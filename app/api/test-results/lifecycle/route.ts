import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

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
 * GET /api/test-results/lifecycle?project=<slug>
 *
 * Reads from THIS repo's Supabase (lifecycle_results). STS owns the swarm
 * end-to-end; AWP is tenant #1. Until Cash's migration 0002 lands and the
 * sts-scanner on the VPS starts populating rows, this returns an empty
 * matrix — which the LifecycleTestsTab handles cleanly.
 *
 * Mirrors the response shape of the former AWP route so the UI is agnostic.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("project") || "awp";
    const configKey = searchParams.get("config_key");
    const scenarioKey = searchParams.get("scenario_key");
    const status = searchParams.get("status");
    const limit = parseInt(searchParams.get("limit") || "5000", 10);
    const since = searchParams.get("since");
    const onchainJobId = searchParams.get("onchain_job_id");

    const admin = createAdminClient();
    let query = admin
      .from("lifecycle_results")
      .select("*")
      .eq("project_id", projectId)
      .order("started_at", { ascending: false })
      .limit(limit);

    if (configKey) query = query.eq("config_key", configKey);
    if (scenarioKey) query = query.eq("scenario_key", scenarioKey);
    if (status) query = query.eq("status", status);
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        // Filter on updated_at so the Operations live-timeline picks up
        // rows whose steps were updated after the cursor, not just rows
        // that were newly created.
        query = query.gte("updated_at", sinceDate.toISOString());
      }
    }
    if (onchainJobId) {
      query = query.eq("onchain_job_id", parseInt(onchainJobId, 10));
    }

    const { data: results, error } = await query;
    if (error) {
      // Table may not exist yet (migration 0002 is still in flight).
      // Return an empty matrix instead of 500 so the UI renders cleanly.
      const missingTable =
        typeof error.message === "string" &&
        /relation .* does not exist|lifecycle_results/i.test(error.message);
      if (missingTable) {
        return NextResponse.json(
          {
            results: [],
            matrix: { configs: [], scenarios: [], cells: {} },
            meta: {
              count: 0,
              limit,
              projectId,
              note: "lifecycle_results table not provisioned yet"
            },
            table_missing: true
          },
          { headers: corsHeaders }
        );
      }
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders }
      );
    }

    // Normalize short scenario keys ("s03") to full keys ("s03-competitive-workers")
    // so matrix lookup matches public/tests/lifecycle/config.json.
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

    // V15 scanner classifies still-running jobs as 's00-in-flight' (no
    // terminal scenario_key yet). Those rows have no S## column to land
    // in, so the matrix Running counter would silently miss them. The
    // scanner stores the *intended* scenario in cell_audit.intended_scenario
    // (parsed from the on-chain requirementsJson that swarm-create embeds).
    // Re-bucket in-flight rows under that intended scenario so they show up
    // as Running under the cell they're headed for. Falls back to the raw
    // 's00-in-flight' key if cell_audit is missing or malformed.
    const remapToIntended = (row: { scenario_key: string; cell_audit?: unknown }) => {
      if (row.scenario_key !== 's00-in-flight') return row.scenario_key;
      const ca = row.cell_audit as { intended_scenario?: unknown } | null | undefined;
      const intended = ca && typeof ca.intended_scenario === 'string' ? ca.intended_scenario : null;
      return intended ? normalize(intended) : row.scenario_key;
    };

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
      const scenarioKeyNorm = remapToIntended(row);
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
          projectId,
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
