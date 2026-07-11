import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import {
  HEARTBEAT_COMPONENTS,
  type Heartbeat,
  type HeartbeatsResponse,
  type HeartbeatComponent,
  type HeartbeatComponentState
} from "@/lib/heartbeat-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const privateHeaders = { "Cache-Control": "private, no-store" };

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
  const supabase = createServerClient();
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401, headers: privateHeaders }
    );
  }

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project") || "awp";
  if (!/^[a-z0-9-]{1,64}$/.test(projectId)) {
    return NextResponse.json(
      { error: "Invalid project identifier" },
      { status: 400, headers: privateHeaders }
    );
  }

  try {
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
        supabase
          .from("system_heartbeats")
          .select("id,project_id,component,ran_at,outcome,actions_count,note,meta")
          .eq("project_id", projectId)
          .like("component", componentPrefix)
          .order("ran_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
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
          return NextResponse.json(res, { headers: privateHeaders });
        }
        return NextResponse.json(
          { error: msg, components } as Record<string, unknown>,
          { status: 500, headers: privateHeaders }
        );
      }

      components[component] = {
        last: (lastRes.data as Heartbeat | null) ?? null,
        count24h: countRes.count ?? 0
      };
    }

    const body: HeartbeatsResponse = { components };
    return NextResponse.json(body, { headers: privateHeaders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json(
      { error: message },
      { status: 500, headers: privateHeaders }
    );
  }
}
