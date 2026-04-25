import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import {
  HEARTBEAT_COMPONENTS,
  type Heartbeat,
  type HeartbeatsResponse,
  type HeartbeatComponent,
  type HeartbeatComponentState
} from "@/lib/heartbeat-types";

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
 * GET /api/test-results/heartbeats?project=awp
 * Returns the latest row + 24h count per tracked VPS component.
 *
 * The system_heartbeats table is populated by the VPS scripts on each
 * run (swarm-drain, swarm-create, sts-scanner). Until that VPS patch
 * lands, all components return { last: null, count24h: 0 } and the
 * Operations tab renders the idle fallback.
 *
 * Component matching uses LIKE `${component}%` rather than equality so
 * versioned suffixes match (e.g. the V15 cutover renamed the scanner's
 * heartbeat component from `sts-scanner` to `sts-scanner-v15`). Without
 * this, the Operations card sat at "No heartbeat yet" forever after deploy
 * even though rows were landing in system_heartbeats every 15 min.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project") || "awp";

  try {
    const admin = createAdminClient();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const emptyState: HeartbeatComponentState = { last: null, count24h: 0 };
    const components: Record<HeartbeatComponent, HeartbeatComponentState> = {
      "swarm-drain": { ...emptyState },
      "swarm-create": { ...emptyState },
      "sts-scanner": { ...emptyState }
    };

    for (const component of HEARTBEAT_COMPONENTS) {
      // Prefix-match so e.g. `sts-scanner` matches both `sts-scanner` (V14)
      // and `sts-scanner-v15` (V15). The most recent row wins for `last`,
      // and count24h aggregates across versions so the Operations card
      // doesn't go dark mid-cutover when both daemons are momentarily live.
      const componentPrefix = `${component}%`;
      const [lastRes, countRes] = await Promise.all([
        admin
          .from("system_heartbeats")
          .select("*")
          .eq("project_id", projectId)
          .like("component", componentPrefix)
          .order("ran_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin
          .from("system_heartbeats")
          .select("*", { count: "exact", head: true })
          .eq("project_id", projectId)
          .like("component", componentPrefix)
          .gte("ran_at", since24h)
      ]);

      // Missing-table detection on either call.
      const err = lastRes.error || countRes.error;
      if (err) {
        const msg = err.message || "";
        if (/relation .* does not exist|system_heartbeats/i.test(msg)) {
          const res: HeartbeatsResponse = {
            components,
            table_missing: true
          };
          return NextResponse.json(res, { headers: corsHeaders });
        }
        return NextResponse.json(
          { error: msg, components } as Record<string, unknown>,
          { status: 500, headers: corsHeaders }
        );
      }

      components[component] = {
        last: (lastRes.data as Heartbeat | null) ?? null,
        count24h: countRes.count ?? 0
      };
    }

    const body: HeartbeatsResponse = { components };
    return NextResponse.json(body, { headers: corsHeaders });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
