/**
 * POST /api/onboarding/greenlight — C.7 cutover.
 *
 * Body: { runId }
 *
 * Pipeline:
 *  1. Auth + ownership check on the run
 *  2. Run must be status='complete' (re-greenlight on already-greenlit
 *     re-runs the cutover but doesn't re-flip status)
 *  3. Compute target paths: lib/<slug>-<userShort>/ + clients/<slug>-<userShort>/
 *  4. Verify (slug, user_short) is not occupied by a different run
 *  5. Fetch baseline (libContents from VPS) + edits (Supabase)
 *  6. Apply patches → produce override files
 *  7. POST to VPS /onboarding/cutover (atomic write into target dirs)
 *  8. Insert client_libs row
 *  9. UPDATE onboarding_runs.status = 'greenlit'
 *
 * v1: HLO is NOT auto-started. The cutover plumbing writes the lib path;
 * production swarm activation is a manual ops step that comes later. That's
 * the intentional safety boundary in PHASE-C-DESIGN.md C.7.
 */
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServerClient } from "@/lib/supabase-server";
import { applyEdits, type Axis, type Scenario, type Rule, type EditRow } from "@/lib/onboarding-patches";
import { buildOverrideFiles } from "@/lib/cutover-render";

export const dynamic = "force-dynamic";

// E.4 Path B — read the runtime-helpers template once per request.
// Located alongside the engine framework so the same template applies
// to every greenlit lib. Lives in the dashboard's deployed bundle.
async function loadRuntimeHelpersTemplate(): Promise<string | null> {
  const templatePath = resolve(process.cwd(), "framework/onboarding/lib/runtime-helpers.template.ts");
  try {
    return await readFile(templatePath, "utf8");
  } catch {
    // Template missing — fall back to no-shim cutover. Greenlight still
    // succeeds; HLO swap would fail at module-load until the helper
    // template is shipped. Logged + reported in the response.
    return null;
  }
}

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
  try { return JSON.parse(src.slice(start, i)); } catch { return []; }
}

export async function POST(req: NextRequest) {
  let body: { runId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const runId = body.runId;
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("status, slug, user_id")
    .eq("run_id", runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (run.user_id !== user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!run.slug) return NextResponse.json({ error: "run has no slug; engine did not complete" }, { status: 409 });
  if (run.status !== "complete" && run.status !== "greenlit") {
    return NextResponse.json({ error: `run status="${run.status}"; greenlight only allowed on complete or greenlit (re-cutover)` }, { status: 409 });
  }

  const userShort = user.id.replace(/-/g, "").slice(0, 6);
  const slug = run.slug;
  const targetLibDir = `lib/${slug}-${userShort}`;
  const targetClientsDir = `clients/${slug}-${userShort}`;

  // Conflict check: if a DIFFERENT run already greenlit to this slug+userShort, block.
  const { data: existingLib } = await supabase
    .from("client_libs")
    .select("run_id")
    .eq("slug", slug)
    .eq("user_short", userShort)
    .maybeSingle();
  if (existingLib && existingLib.run_id !== runId) {
    return NextResponse.json(
      { error: `${targetLibDir} is already occupied by run ${existingLib.run_id}; rotate userShort or wipe first` },
      { status: 409 }
    );
  }

  // Pull baseline from VPS
  const serverUrl = process.env.ONBOARDING_SERVER_URL;
  const serverToken = process.env.ONBOARDING_SERVER_TOKEN;
  if (!serverUrl || !serverToken) {
    return NextResponse.json({ error: "VPS server not configured" }, { status: 503 });
  }
  let libContents: Record<string, string> = {};
  let auditDoc: string | null = null;
  try {
    const r = await fetch(
      `${serverUrl.replace(/\/+$/, "")}/onboarding/result/${encodeURIComponent(runId)}`,
      { headers: { authorization: `Bearer ${serverToken}` }, signal: AbortSignal.timeout(15_000) }
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return NextResponse.json({ error: `VPS result ${r.status}: ${txt.slice(0, 300)}` }, { status: r.status });
    }
    const j = await r.json();
    libContents = j.libContents || {};
    auditDoc = j.auditDoc ?? null;
  } catch (e: unknown) {
    return NextResponse.json({ error: `VPS unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 503 });
  }

  // Parse baseline + load edits
  const baseline = {
    axes: extractJsonArray(libContents["matrix.ts"] || "", "AXES") as Axis[],
    scenarios: extractJsonArray(libContents["scenarios.ts"] || "", "ALL_SCENARIOS") as Scenario[],
    rules: extractJsonArray(libContents["rules.ts"] || "", "RULES") as Rule[],
  };
  const { data: editRows, error: editsErr } = await supabase
    .from("onboarding_edits")
    .select("id, target, patch_json, note, created_at")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (editsErr) return NextResponse.json({ error: editsErr.message }, { status: 500 });

  const applied = applyEdits(baseline, (editRows ?? []) as EditRow[]);

  // E.4 Path B — load the runtime-helpers template + pass through to
  // buildOverrideFiles, which will add lib/<targetSlug>/runtime-helpers.ts
  // and append re-exports to index.ts.
  const helperTemplate = await loadRuntimeHelpersTemplate();

  // Compute override files
  const files = buildOverrideFiles(libContents, auditDoc, applied, targetLibDir, targetClientsDir, helperTemplate);

  // Send to VPS for atomic write
  let vpsResult: { libDir: string; clientsDir: string; libFiles: string[]; clientsFiles: string[] };
  try {
    const r = await fetch(`${serverUrl.replace(/\/+$/, "")}/onboarding/cutover`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${serverToken}` },
      body: JSON.stringify({ runId, sourceSlug: slug, targetLibDir, targetClientsDir, files }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return NextResponse.json({ error: `VPS cutover ${r.status}: ${txt.slice(0, 300)}` }, { status: r.status });
    }
    vpsResult = await r.json();
  } catch (e: unknown) {
    return NextResponse.json({ error: `VPS cutover unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 503 });
  }

  // Insert/update client_libs row
  const { error: libErr } = await supabase
    .from("client_libs")
    .upsert(
      {
        run_id: runId,
        user_id: user.id,
        slug,
        user_short: userShort,
        lib_path: targetLibDir + "/",
      },
      { onConflict: "slug,user_short" }
    );
  if (libErr) {
    return NextResponse.json({ error: `client_libs insert failed: ${libErr.message}` }, { status: 500 });
  }

  // Flip run status to greenlit (idempotent on re-greenlight)
  const { error: statusErr } = await supabase
    .from("onboarding_runs")
    .update({ status: "greenlit" })
    .eq("run_id", runId);
  if (statusErr) {
    return NextResponse.json({ error: `status flip failed: ${statusErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    runId,
    slug,
    userShort,
    libDir: vpsResult.libDir,
    clientsDir: vpsResult.clientsDir,
    libFiles: vpsResult.libFiles,
    clientsFiles: vpsResult.clientsFiles,
    editCount: (editRows ?? []).length,
    runtimeHelpersInjected: helperTemplate != null,
    note: "Cutover complete. HLO is NOT auto-started — production activation is a manual ops step.",
  });
}
