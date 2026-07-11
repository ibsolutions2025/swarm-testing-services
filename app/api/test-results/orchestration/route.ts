import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type {
  OrchestrationEvent,
  OrchestrationResponse
} from "@/lib/orchestration-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const privateHeaders = { "Cache-Control": "private, no-store" };

/**
 * GET /api/test-results/orchestration?project=awp&since=<ISO>&limit=<N>
 *
 * Returns orchestration_events rows newest-first for the Orchestration
 * Stream panel. Graceful degrade on missing table — the Phase 6 UI reads
 * `table_missing: true` to render the "not provisioned yet" state instead
 * of a 500.
 */
export async function GET(request: NextRequest) {
  const supabase = createServerClient();
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: "Authentication required", events: [] },
      { status: 401, headers: privateHeaders }
    );
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project") || "awp";
  if (!/^[a-z0-9-]{1,64}$/.test(projectId)) {
    return NextResponse.json(
      { error: "Invalid project identifier", events: [] },
      { status: 400, headers: privateHeaders }
    );
  }
  const since = searchParams.get("since");
  const limitRaw = parseInt(searchParams.get("limit") || "100", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(1000, limitRaw))
    : 100;

  try {
    let query = supabase
      .from("orchestration_events")
      .select(
        "id,project_id,ran_at,cycle_id,source,event_type,persona,job_id,directive,reasoning,tx_hash,meta"
      )
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
        return NextResponse.json(body, { headers: privateHeaders });
      }
      return NextResponse.json(
        { error: msg, events: [] },
        { status: 500, headers: privateHeaders }
      );
    }

    const body: OrchestrationResponse = {
      events: (data as OrchestrationEvent[]) || []
    };
    return NextResponse.json(body, { headers: privateHeaders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json(
      { error: message, events: [] },
      { status: 500, headers: privateHeaders }
    );
  }
}
