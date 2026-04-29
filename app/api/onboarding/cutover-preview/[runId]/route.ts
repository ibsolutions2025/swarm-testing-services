/**
 * GET /api/onboarding/cutover-preview/[runId] — what would change at greenlight.
 *
 * Computes the post-applied state (engine baseline + all customer edits) and
 * returns a structured diff against baseline. Checkpoint 3 surfaces this so
 * Isaiah greenlights or rejects each piece BEFORE C.7 runs.
 *
 * No mutation. No file I/O on the dashboard side. Reuses the same patch
 * applier as the editor UI so the preview is faithful.
 *
 * Phase C.5 scope (used by Checkpoint 3 verification step). See
 * clients/.shared/PHASE-C-DESIGN.md C.5 + C.7.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { applyEdits, computeDiff, type EditRow } from "@/lib/onboarding-patches";

export const dynamic = "force-dynamic";

type RouteParams = { params: { runId: string } };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const runId = params.runId;
  if (!runId || !/^[a-zA-Z0-9._-]+$/.test(runId)) {
    return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Re-use /api/onboarding/data path: fetch baseline from VPS + edits from
  // Supabase. To keep the cutover preview self-contained we duplicate the
  // small fetch logic rather than calling our own route.
  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("status, slug")
    .eq("run_id", runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const serverUrl = process.env.ONBOARDING_SERVER_URL;
  const serverToken = process.env.ONBOARDING_SERVER_TOKEN;
  if (!serverUrl || !serverToken) {
    return NextResponse.json({ error: "VPS server not configured" }, { status: 503 });
  }

  let libContents: Record<string, string> = {};
  try {
    const r = await fetch(
      `${serverUrl.replace(/\/+$/, "")}/onboarding/result/${encodeURIComponent(runId)}`,
      {
        headers: { authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return NextResponse.json({ error: `VPS ${r.status}: ${txt.slice(0, 300)}` }, { status: r.status });
    }
    libContents = (await r.json()).libContents || {};
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `VPS unreachable: ${msg}` }, { status: 503 });
  }

  const matrixSrc = libContents["matrix.ts"] || "";
  const scenariosSrc = libContents["scenarios.ts"] || "";
  const rulesSrc = libContents["rules.ts"] || "";

  const baseline = {
    axes: extractJsonArray(matrixSrc, "AXES") as never[],
    scenarios: extractJsonArray(scenariosSrc, "ALL_SCENARIOS") as never[],
    rules: extractJsonArray(rulesSrc, "RULES") as never[],
  };

  const { data: editRows, error: editsErr } = await supabase
    .from("onboarding_edits")
    .select("id, target, patch_json, note, created_at")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (editsErr) return NextResponse.json({ error: editsErr.message }, { status: 500 });

  const edits = (editRows ?? []) as EditRow[];
  const applied = applyEdits(baseline, edits);
  const diff = computeDiff(baseline, applied);

  // Compute target greenlight path so the user knows where the lib WILL go.
  const userShort = user.id.replace(/-/g, "").slice(0, 6);
  const slug = run.slug || "unknown";
  const targetLibPath = `lib/${slug}-${userShort}/`;
  const targetClientsPath = `clients/${slug}-${userShort}/`;

  return NextResponse.json({
    runId,
    slug,
    status: run.status,
    editCount: edits.length,
    diff,
    applied: {
      axisCount: applied.axes.length,
      scenarioCount: applied.scenarios.length,
      ruleCount: applied.rules.length,
      ruleFlagCount: applied.ruleFlags.length,
      ruleMissingCount: applied.ruleMissing.length,
    },
    cutoverTarget: {
      libPath: targetLibPath,
      clientsPath: targetClientsPath,
      userShort,
    },
  });
}

// Local copy of the same parser used in /api/onboarding/data — small enough
// not to warrant a shared util across server-only routes.
function extractJsonArray(src: string, exportName: string): unknown[] {
  const re = new RegExp(`export const ${exportName}(?:\\s*:[^=]+)?\\s*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) return [];
  const start = m.index + m[0].length - 1;
  let depth = 0, i = start, inStr = false, strCh: string | null = null, lc = false, bc = false;
  for (; i < src.length; i++) {
    const c = src[i], c2 = src[i + 1] || "";
    if (lc) { if (c === "\n") lc = false; continue; }
    if (bc) { if (c === "*" && c2 === "/") { bc = false; i++; } continue; }
    if (inStr) { if (c === "\\") { i++; continue; } if (c === strCh) { inStr = false; strCh = null; } continue; }
    if (c === "/" && c2 === "/") { lc = true; i++; continue; }
    if (c === "/" && c2 === "*") { bc = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) { i++; break; } }
  }
  const body = src.slice(start, i);
  try { return JSON.parse(body); } catch { return []; }
}
