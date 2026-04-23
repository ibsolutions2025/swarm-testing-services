import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import type {
  OrchestrationEvent,
  OrchestrationResponse
} from "@/lib/orchestration-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}

/**
 * GET /api/test-results/orchestration?project=awp&since=<ISO>&limit=<N>
 *
 * Returns orchestration_events rows newest-first for the Orchestration
 * Stream panel. Graceful degrade on missing table — the Phase 6 UI reads
 * `table_missing: true` to render the "not provisioned yet" state instead
 * of a 500.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project") || "awp";
  const since = searchParams.get("since");
  const limitRaw = parseInt(searchParams.get("limit") || "100", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(1000, limitRaw))
    : 100;

  try {
    const admin = createAdminClient();
    let query = admin
      .from("orchestration_events")
      .select("*")
      .eq("project_id", projectId)
      .order("ran_at", { ascending: false })
      .limit(limit);

    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        query = query.gte("ran_at", sinceDate.toISOString());
      }
    }

    const { data, error } = await query;
    if (error) {
      const msg = error.message || "";
      const missing = /relation .* does not exist|orchestration_events/i.test(
        msg
      );
      if (missing) {
        const body: OrchestrationResponse = {
          events: [],
          table_missing: true
        };
        return NextResponse.json(body, { headers: corsHeaders });
      }
      return NextResponse.json(
        { error: msg, events: [] },
        { status: 500, headers: corsHeaders }
      );
    }

    const body: OrchestrationResponse = {
      events: (data as OrchestrationEvent[]) || []
    };
    return NextResponse.json(body, { headers: corsHeaders });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error", events: [] },
      { status: 500, headers: corsHeaders }
    );
  }
}
