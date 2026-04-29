/**
 * GET /api/onboarding/data/[runId] — fetch parsed baseline + edits.
 *
 * Returns the engine output's matrix/scenarios/rules parsed into structured
 * JSON, plus all customer edits stored against the run. The editor at
 * /hire/runs/[runId]/edit consumes this directly.
 *
 * Parsing strategy: each .ts file the engine emits has a known shape with
 * a JSON-literal array (the engine renders via `JSON.stringify(...)`). We
 * extract the array literal between `=` and `;` for each export and
 * `JSON.parse` it. No runtime eval.
 *
 * Phase C.5 scope. See clients/.shared/PHASE-C-DESIGN.md C.5.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type RouteParams = { params: { runId: string } };

type RawAxis = {
  name: string;
  description?: string;
  source_param?: string;
  values: string[];
  maps_to?: Record<string, unknown>;
};

type RawScenario = {
  id: string;
  label: string;
  description: string;
  status: "classifiable" | "aspirational" | "deferred" | "in-flight";
  applicability: string;
  requiredEvents?: string[];
  negativeEvents?: string[];
  terminalState?: Record<string, unknown>;
  notes?: string;
};

type RawRule = {
  id: string;
  fn: string;
  kind: string;
  condition: string;
  errorName: string;
  failureCategory: string;
  failureSubcategory?: string;
  notes?: string;
};

/**
 * Extract the value of `export const NAME = [ ... ];` (or `: TYPE = [...]`).
 * The engine emits these via JSON.stringify so the body parses as JSON.
 */
function extractJsonArray(src: string, exportName: string): unknown[] {
  // Pattern: `export const NAME[: ANY_TYPE]?\s*=\s*[` — match the opening bracket
  // then walk to the matching closing bracket, respecting strings.
  const re = new RegExp(`export const ${exportName}(?:\\s*:[^=]+)?\\s*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) return [];
  const start = m.index + m[0].length - 1; // position of opening [
  let depth = 0;
  let i = start;
  let inStr = false;
  let strCh: string | null = null;
  let lc = false;
  let bc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1] || "";
    if (lc) { if (c === "\n") lc = false; continue; }
    if (bc) { if (c === "*" && c2 === "/") { bc = false; i++; } continue; }
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === strCh) { inStr = false; strCh = null; }
      continue;
    }
    if (c === "/" && c2 === "/") { lc = true; i++; continue; }
    if (c === "/" && c2 === "*") { bc = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const body = src.slice(start, i);
  try {
    return JSON.parse(body);
  } catch {
    return [];
  }
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const runId = params.runId;
  if (!runId || !/^[a-zA-Z0-9._-]+$/.test(runId)) {
    return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Confirm caller owns the run.
  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("status, slug")
    .eq("run_id", runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  // Pull lib contents from VPS (server.mjs result endpoint).
  const serverUrl = process.env.ONBOARDING_SERVER_URL;
  const serverToken = process.env.ONBOARDING_SERVER_TOKEN;
  if (!serverUrl || !serverToken) {
    return NextResponse.json({ error: "VPS server not configured" }, { status: 503 });
  }

  let libContents: Record<string, string> = {};
  let auditDoc: string | null = null;
  let slug: string | null = run.slug ?? null;
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
      return NextResponse.json(
        { error: `VPS returned ${r.status}: ${txt.slice(0, 300)}` },
        { status: r.status }
      );
    }
    const json = await r.json();
    libContents = json.libContents || {};
    auditDoc = json.auditDoc ?? null;
    slug = json.slug ?? slug;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `VPS unreachable: ${msg}` }, { status: 503 });
  }

  // Parse the three editor files.
  const matrixSrc = libContents["matrix.ts"] || "";
  const scenariosSrc = libContents["scenarios.ts"] || "";
  const rulesSrc = libContents["rules.ts"] || "";

  const axes = extractJsonArray(matrixSrc, "AXES") as RawAxis[];
  const scenarios = extractJsonArray(scenariosSrc, "ALL_SCENARIOS") as RawScenario[];
  const rules = extractJsonArray(rulesSrc, "RULES") as RawRule[];

  // Pull existing edits.
  const { data: edits, error: editsErr } = await supabase
    .from("onboarding_edits")
    .select("id, target, patch_json, note, created_at")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (editsErr) {
    return NextResponse.json({ error: editsErr.message }, { status: 500 });
  }

  return NextResponse.json({
    runId,
    slug,
    status: run.status,
    baseline: { axes, scenarios, rules },
    edits: edits ?? [],
    auditDoc,
  });
}
