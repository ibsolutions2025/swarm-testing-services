import { NextRequest, NextResponse } from "next/server";
import { awpSupabase } from "@/lib/awp-supabase";

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
 * Read-through proxy to AWP's lifecycle_results for the AWP project card.
 * Mirrors agentwork-protocol/src/app/api/test-results/lifecycle/route.ts (GET only).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const configKey = searchParams.get("config_key");
    const scenarioKey = searchParams.get("scenario_key");
    const status = searchParams.get("status");
    const limit = parseInt(searchParams.get("limit") || "100", 10);
    const since = searchParams.get("since");
    const onchainJobId = searchParams.get("onchain_job_id");

    let query = awpSupabase()
      .from("lifecycle_results")
      .select("*, step_audits, cell_audit")
      .not("config_key", "like", "config-job-%")
      .order("started_at", { ascending: false })
      .limit(limit);

    if (configKey) query = query.eq("config_key", configKey);
    if (scenarioKey) query = query.eq("scenario_key", scenarioKey);
    if (status) query = query.eq("status", status);
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        query = query.gte("started_at", sinceDate.toISOString());
      }
    }
    if (onchainJobId) {
      query = query.eq("onchain_job_id", parseInt(onchainJobId, 10));
    }

    const { data: results, error } = await query;
    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    // Normalize short scenario keys ("s03") to full keys ("s03-competitive-workers")
    // so matrix lookup matches config.json.
    const SCENARIO_KEY_MAP: Record<string, string> = {
      s01: "s01-happy-path",
      s02: "s02-validator-first",
      s03: "s03-competitive-workers",
      s04: "s04-rejection-loop",
      s05: "s05-total-rejection",
      s06: "s06-validator-waitlist",
      s07: "s07-validator-rotation",
      s08: "s08-worker-no-show",
      s09: "s09-validator-no-show",
      s10: "s10-job-cancelled",
      s11: "s11-deadline-expiry",
      s12: "s12-rating-gate-pass",
      s13: "s13-rating-gate-fail",
      s14: "s14-rating-gate-new-user",
      s15: "s15-approved-not-approved",
      s16: "s16-multiple-submissions",
      s17: "s17-hard-validation-auto",
      s18: "s18-hard-then-soft"
    };
    const normalize = (k: string) => SCENARIO_KEY_MAP[k] || k;

    type Cell = {
      status: string;
      jobCount: number;
      passedCount: number;
      latestJobId: number | null;
    };
    const cells: Record<string, Cell> = {};
    const configs = new Set<string>();
    const scenarios = new Set<string>();

    for (const row of results || []) {
      const scenarioKeyNorm = normalize(row.scenario_key);
      row.scenario_key = scenarioKeyNorm;
      const cellKey = `${row.config_key}:${scenarioKeyNorm}`;

      if (!cells[cellKey]) {
        cells[cellKey] = {
          status: "running",
          jobCount: 0,
          passedCount: 0,
          latestJobId: null
        };
      }
      const cell = cells[cellKey];
      cell.jobCount++;
      if (row.status === "passed") {
        cell.passedCount++;
        cell.status = "passed";
      } else if (row.status === "failed" && cell.status !== "passed") {
        cell.status = "failed";
      }
      const jobId = row.onchain_job_id || 0;
      if (cell.latestJobId === null || jobId > cell.latestJobId) {
        cell.latestJobId = jobId;
      }

      configs.add(row.config_key);
      scenarios.add(scenarioKeyNorm);
    }

    return NextResponse.json(
      {
        results: results || [],
        matrix: {
          configs: Array.from(configs),
          scenarios: Array.from(scenarios),
          cells
        },
        meta: {
          count: results?.length || 0,
          limit,
          filters: {
            config_key: configKey,
            scenario_key: scenarioKey,
            status,
            since
          }
        }
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
