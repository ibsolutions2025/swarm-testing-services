/**
 * GET /api/onboarding/status?run_id=X — poll for live progress.
 *
 * Returns the parent onboarding_runs row + every onboarding_step_events row
 * for that run, ordered by emitted_at. The /hire/runs/[runId] page calls
 * this every 3s.
 *
 * RLS scopes both queries to the calling user's auth.uid(); a different
 * user's runId returns 404 even if it exists.
 *
 * Phase C scope. See clients/.shared/PHASE-C-DESIGN.md C.4.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get("run_id");
  if (!runId) return NextResponse.json({ error: "run_id is required" }, { status: 400 });

  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { data: run, error: runErr } = await supabase
    .from("onboarding_runs")
    .select("run_id,url,status,current_step,slug,total_cost_usd,total_tokens_in,total_tokens_out,error,created_at,updated_at")
    .eq("run_id", runId)
    .maybeSingle();
  if (runErr) return NextResponse.json({ error: runErr.message }, { status: 500 });
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const { data: events, error: evtErr } = await supabase
    .from("onboarding_step_events")
    .select("step_id,status,elapsed_ms,summary,cost_usd,emitted_at")
    .eq("run_id", runId)
    .order("emitted_at", { ascending: true });
  if (evtErr) return NextResponse.json({ error: evtErr.message }, { status: 500 });

  return NextResponse.json({ run, events: events ?? [] });
}
