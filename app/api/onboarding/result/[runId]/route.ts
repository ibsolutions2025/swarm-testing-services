/**
 * GET /api/onboarding/result/[runId] — fetch final outputs of a complete run.
 *
 * Proxies the VPS server.mjs /onboarding/result/:runId endpoint. We don't
 * read the VPS filesystem from Vercel — that filesystem is only on the VPS.
 * The dashboard talks to VPS via the same bearer-token wire used by
 * POST /api/onboarding.
 *
 * Returns:
 *   { ok, slug, libFiles: { "rules.ts": <bytes>, ... }, auditDoc: <markdown> }
 *
 * Auth: caller must own the onboarding_runs row (RLS check via runId lookup).
 *
 * Phase C scope. See clients/.shared/PHASE-C-DESIGN.md C.4.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type RouteParams = { params: { runId: string } };

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const runId = params.runId;
  if (!runId || !/^[a-zA-Z0-9._-]+$/.test(runId)) {
    return NextResponse.json({ error: "invalid runId" }, { status: 400 });
  }

  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  // Confirm caller owns this run. RLS would block the SELECT for a foreign
  // run, but we want a clean 404 instead of a confusing empty result.
  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("status")
    .eq("run_id", runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const serverUrl = process.env.ONBOARDING_SERVER_URL;
  const serverToken = process.env.ONBOARDING_SERVER_TOKEN;
  if (!serverUrl || !serverToken) {
    return NextResponse.json(
      { error: "VPS server not configured (ONBOARDING_SERVER_URL/TOKEN unset)" },
      { status: 503 }
    );
  }

  try {
    const r = await fetch(
      `${serverUrl.replace(/\/+$/, "")}/onboarding/result/${encodeURIComponent(runId)}`,
      {
        headers: { authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.timeout(10_000),
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
    return NextResponse.json(json);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `VPS unreachable: ${msg}` }, { status: 503 });
  }
}
