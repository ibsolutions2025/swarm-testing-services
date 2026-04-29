/**
 * /api/onboarding/edit — HITL edit patches (C.5).
 *
 * POST body: { runId, target: 'matrix' | 'scenarios' | 'rules-backlog', patch_json, note? }
 *   Inserts one onboarding_edits row. Each row is one logical edit (one
 *   axis added, one scenario field changed, one rule flagged). The
 *   editor's UI accumulates many edits over a session — they apply in
 *   created_at order at greenlight (C.7).
 *
 * GET ?run_id=X
 *   Returns all edits for the run, ordered oldest-first. The editor uses
 *   this on page load to reconstruct the current state.
 *
 * RLS: 0006_onboarding_runs.sql restricts SELECT/INSERT to user_id =
 * auth.uid(). The handler additionally validates that the runId belongs
 * to the calling user before inserting.
 *
 * Phase C.5 scope. See clients/.shared/PHASE-C-DESIGN.md C.5.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const VALID_TARGETS = new Set(["matrix", "scenarios", "rules-backlog"]);

export async function POST(req: NextRequest) {
  let body: { runId?: string; target?: string; patch_json?: unknown; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { runId, target, patch_json, note } = body;
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });
  if (!target || !VALID_TARGETS.has(target)) {
    return NextResponse.json({ error: "target must be matrix | scenarios | rules-backlog" }, { status: 400 });
  }
  if (!patch_json || typeof patch_json !== "object") {
    return NextResponse.json({ error: "patch_json must be a non-null object" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Verify caller owns this run. RLS would block the SELECT for foreign
  // runs, but we want a clean 404 instead of an empty result.
  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("status")
    .eq("run_id", runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  // Editor only allowed once engine is complete. The status page hides
  // the Edit link until status='complete', so this is a defensive check.
  if (run.status !== "complete" && run.status !== "greenlit") {
    return NextResponse.json({ error: `run status is "${run.status}"; edits only allowed on complete or greenlit runs` }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("onboarding_edits")
    .insert({
      run_id: runId,
      user_id: user.id,
      target,
      patch_json,
      note: note ?? null,
    })
    .select("id, created_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ id: data.id, created_at: data.created_at }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("run_id");
  if (!runId) return NextResponse.json({ error: "run_id required" }, { status: 400 });

  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { data, error } = await supabase
    .from("onboarding_edits")
    .select("id, target, patch_json, note, created_at")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ edits: data ?? [] });
}
