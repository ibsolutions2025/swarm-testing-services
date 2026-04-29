/**
 * GET /api/onboarding/bundle/[runId] — download the engine output as tar.gz.
 *
 * For status='complete': bundles runs/<runId>/output/lib/<slug> + clients/<slug>
 *   (engine output, no edits applied; customer can still see edits in the
 *   editor and they'll be applied at greenlight).
 * For status='greenlit': bundles lib/<slug>-<userShort> + clients/<slug>-<userShort>
 *   (post-greenlight canonical with HITL edits applied).
 *
 * Streams from VPS /onboarding/bundle (which spawns `tar -czf -`) directly
 * to the customer with a Content-Disposition attachment header. No on-disk
 * caching, no Vercel Blob — Node 22 fetch ReadableStream pipes through.
 *
 * Phase C.6 scope.
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("status, slug, user_id")
    .eq("run_id", runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (run.user_id !== user.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (run.status !== "complete" && run.status !== "greenlit") {
    return NextResponse.json({ error: `bundle not ready (status="${run.status}")` }, { status: 409 });
  }
  if (!run.slug) return NextResponse.json({ error: "no slug" }, { status: 409 });

  const userShort = user.id.replace(/-/g, "").slice(0, 6);
  const paths: string[] =
    run.status === "greenlit"
      ? [`lib/${run.slug}-${userShort}/`, `clients/${run.slug}-${userShort}/`]
      : [`framework/onboarding/runs/${runId}/output/`];

  const filename =
    run.status === "greenlit"
      ? `${run.slug}-${userShort}.tar.gz`
      : `${run.slug}-${runId}-engine-output.tar.gz`;

  const serverUrl = process.env.ONBOARDING_SERVER_URL;
  const serverToken = process.env.ONBOARDING_SERVER_TOKEN;
  if (!serverUrl || !serverToken) {
    return NextResponse.json({ error: "VPS server not configured" }, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${serverUrl.replace(/\/+$/, "")}/onboarding/bundle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${serverToken}` },
      body: JSON.stringify({ paths }),
      // No timeout — tar streaming may take seconds for large bundles
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: `VPS bundle unreachable: ${e instanceof Error ? e.message : String(e)}` }, { status: 503 });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    return NextResponse.json({ error: `VPS bundle ${upstream.status}: ${txt.slice(0, 300)}` }, { status: upstream.status });
  }
  if (!upstream.body) {
    return NextResponse.json({ error: "VPS bundle response missing body" }, { status: 500 });
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
