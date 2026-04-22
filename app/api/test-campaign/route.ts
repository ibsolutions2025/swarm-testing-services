import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { sign } from "@/lib/hmac";

/**
 * POST /api/test-campaign
 * Body: { url, description }
 *
 * 1. Auth — require a Supabase session cookie.
 * 2. Validate — URL must parse, description non-empty.
 * 3. Persist — insert a row in `campaigns` with status='queued'.
 * 4. Dispatch — fire-and-forget POST to the orchestrator webhook so the
 *    matrix designer + persona generator + dispatcher can start.
 * 5. Graceful degradation — if the `campaigns` table isn't provisioned
 *    yet, return a 202 with `table_missing: true`.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { url, description } = body ?? {};

  if (!url || typeof url !== "string") {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  try {
    // Reject non-http(s) or malformed URLs early.
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("bad protocol");
    }
  } catch {
    return NextResponse.json(
      { error: "url must be a valid http(s) URL" },
      { status: 400 }
    );
  }

  if (!description || typeof description !== "string" || description.trim().length < 20) {
    return NextResponse.json(
      { error: "description must be at least 20 characters" },
      { status: 400 }
    );
  }

  const supabase = createServerClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      user_id: user.id,
      url,
      description,
      status: "queued"
    })
    .select("id, status")
    .single();

  if (error) {
    if (error.code === "PGRST205" || /does not exist/i.test(error.message)) {
      return NextResponse.json(
        {
          campaign_id: "stub-" + Date.now(),
          table_missing: true,
          note:
            "campaigns table not yet provisioned; run supabase/migrations/0001_init.sql to enable persistence."
        },
        { status: 202 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Fire-and-forget webhook to the orchestrator. Kept inside a try/catch so
  // a missing orchestrator in dev doesn't block campaign creation — the
  // campaign stays queued and a cron-style orchestrator can pick it up.
  const orchestratorUrl = process.env.ORCHESTRATOR_WEBHOOK_URL;
  const orchestratorSecret = process.env.ORCHESTRATOR_WEBHOOK_SECRET;

  if (orchestratorUrl && orchestratorSecret) {
    const payload = JSON.stringify({ campaign_id: data.id, kick: "new" });
    const signature = sign(payload, orchestratorSecret);
    // Intentionally not awaited — fire and forget.
    fetch(orchestratorUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-swarm-signature": signature
      },
      body: payload
    }).catch(() => {
      /* orchestrator offline → campaign stays queued; poller handles it */
    });
  }

  return NextResponse.json(
    { campaign_id: data.id, status: data.status },
    { status: 201 }
  );
}
