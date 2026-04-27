/**
 * progress-emitter.mjs — engine -> Supabase progress wire (Phase C.3).
 *
 * The engine writes state.json on every step transition. The dashboard polls
 * Supabase rows, NOT the VPS filesystem. So after each step we ALSO insert
 * a onboarding_step_events row + bump the parent onboarding_runs row's
 * status/cost/tokens.
 *
 * Service-role key bypass RLS — only the engine uses this; customers see the
 * resulting rows via the auth.uid()-scoped policies in 0006_onboarding_runs.sql.
 *
 * Falls back gracefully when STS_SUPABASE_URL / STS_SUPABASE_KEY are unset
 * (dev mode, no progress emitted — engine still completes, dashboard just
 * sees nothing). This keeps the CLI usable without the dashboard.
 */
const SUPABASE_URL = process.env.STS_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.STS_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Anthropic Sonnet 4.5 pricing as of 2026-04-27. Update when pricing changes.
// Cents per 1M tokens. Input/output split.
const SONNET_INPUT_PER_MTOK_USD = 3.0;
const SONNET_OUTPUT_PER_MTOK_USD = 15.0;

export function computeStepCost(usage) {
  if (!usage) return 0;
  const inTok = Number(usage.input_tokens) || 0;
  const outTok = Number(usage.output_tokens) || 0;
  return (inTok * SONNET_INPUT_PER_MTOK_USD + outTok * SONNET_OUTPUT_PER_MTOK_USD) / 1_000_000;
}

export function isWired() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

async function supaFetch(method, path, body) {
  if (!isWired()) return { ok: false, error: "supabase not configured" };
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
  };
  try {
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, status: r.status, error: txt.slice(0, 500) };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Mark a run as starting. Idempotent — if the row was already inserted by
 * the dashboard's POST /api/onboarding handler, this UPDATE just bumps
 * status to 'running' and records the VPS run dir.
 */
export async function emitRunStarted({ runId, vpsRunDir }) {
  if (!isWired()) return;
  await supaFetch("PATCH", `onboarding_runs?run_id=eq.${encodeURIComponent(runId)}`, {
    status: "running",
    vps_run_dir: vpsRunDir,
  });
}

/**
 * Insert a step-event row + bump the run's running totals. Called after
 * each engine step (success or fail).
 */
export async function emitStepEvent({ runId, stepId, status, elapsedMs, summary, output, usage }) {
  if (!isWired()) return;
  const costUsd = computeStepCost(usage);
  await supaFetch("POST", "onboarding_step_events", [{
    run_id: runId,
    step_id: stepId,
    status,
    elapsed_ms: elapsedMs ?? null,
    summary: summary ?? null,
    output_json: output ?? null,
    cost_usd: costUsd || null,
  }]);

  // Bump parent run totals. PostgREST doesn't support arithmetic UPDATE
  // expressions, so we read + write. Race-tolerant: each step is sequential
  // in the engine, so no concurrent update.
  if (costUsd > 0 || usage) {
    const { ok, json } = await supaFetchJson(
      `onboarding_runs?run_id=eq.${encodeURIComponent(runId)}&select=total_cost_usd,total_tokens_in,total_tokens_out`
    );
    if (ok && Array.isArray(json) && json[0]) {
      const cur = json[0];
      const newTotals = {
        total_cost_usd: Number(cur.total_cost_usd || 0) + costUsd,
        total_tokens_in: Number(cur.total_tokens_in || 0) + Number(usage?.input_tokens || 0),
        total_tokens_out: Number(cur.total_tokens_out || 0) + Number(usage?.output_tokens || 0),
        current_step: stepId,
      };
      await supaFetch("PATCH", `onboarding_runs?run_id=eq.${encodeURIComponent(runId)}`, newTotals);
    }
  } else {
    // Even with no cost, advance current_step so the UI knows where we are.
    await supaFetch("PATCH", `onboarding_runs?run_id=eq.${encodeURIComponent(runId)}`, {
      current_step: stepId,
    });
  }
}

async function supaFetchJson(path) {
  if (!isWired()) return { ok: false };
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
  };
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return { ok: false, status: r.status };
    const json = await r.json();
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Mark the run terminal — 'complete' on full success, 'failed' otherwise.
 * Records the discovered slug if we got that far.
 */
export async function emitRunFinished({ runId, status, error, slug }) {
  if (!isWired()) return;
  const patch = { status };
  if (error) patch.error = String(error).slice(0, 4000);
  if (slug) patch.slug = slug;
  await supaFetch("PATCH", `onboarding_runs?run_id=eq.${encodeURIComponent(runId)}`, patch);
}
