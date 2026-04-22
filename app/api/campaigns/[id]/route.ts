import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import type { CampaignResults } from "@/lib/types";

/**
 * GET /api/campaigns/:id — return the full result bundle for one campaign:
 * campaign metadata, matrix, personas, runs, + summary counts.
 *
 * RLS enforces access: user can only read their own campaigns.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createServerClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const [{ data: campaign }, { data: matrix }, { data: personas }, { data: runs }] =
    await Promise.all([
      supabase
        .from("campaigns")
        .select("id, user_id, url, description, status, matrix_id, error, created_at, updated_at")
        .eq("id", params.id)
        .maybeSingle(),
      supabase
        .from("matrices")
        .select("id, campaign_id, rows, columns, created_at")
        .eq("campaign_id", params.id)
        .maybeSingle(),
      supabase
        .from("personas")
        .select("id, campaign_id, matrix_row_id, name, archetype, goals, biases, soul_md, created_at")
        .eq("campaign_id", params.id),
      supabase
        .from("runs")
        .select(
          "id, campaign_id, matrix_row_id, matrix_column_id, persona_id, outcome, transcript, quote, duration_ms, created_at"
        )
        .eq("campaign_id", params.id)
    ]);

  if (!campaign) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const summary = {
    total: runs?.length ?? 0,
    passed: runs?.filter((r) => r.outcome === "pass").length ?? 0,
    failed: runs?.filter((r) => r.outcome === "fail").length ?? 0,
    partial: runs?.filter((r) => r.outcome === "partial").length ?? 0,
    error: runs?.filter((r) => r.outcome === "error").length ?? 0
  };

  const bundle: CampaignResults = {
    campaign: campaign as any,
    matrix: (matrix as any) ?? null,
    personas: (personas ?? []) as any,
    runs: (runs ?? []) as any,
    summary
  };

  return NextResponse.json(bundle, { status: 200 });
}
