import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { sign } from "@/lib/hmac";
import { assertPublicTargetUrl, TargetUrlError } from "@/lib/target-url.mjs";

export const runtime = "nodejs";

type CampaignInput = {
  url?: unknown;
  docs_url?: unknown;
  description?: unknown;
  environment?: unknown;
  authorization_confirmed?: unknown;
};

export async function POST(req: NextRequest) {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }

  const supabase = createServerClient();
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { data: withinQuota, error: quotaError } = await supabase.rpc(
    "consume_campaign_quota",
    { max_requests: 3, window_seconds: 600 }
  );
  if (quotaError) {
    return NextResponse.json(
      { error: "Campaign intake is temporarily unavailable." },
      { status: 503 }
    );
  }
  if (!withinQuota) {
    return NextResponse.json(
      { error: "Campaign limit reached. Try again after the current 10-minute window." },
      { status: 429, headers: { "retry-after": "600" } }
    );
  }

  let body: CampaignInput;
  try {
    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody, "utf8") > 16_384) {
      return NextResponse.json({ error: "request body too large" }, { status: 413 });
    }
    body = JSON.parse(rawBody) as CampaignInput;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (body.authorization_confirmed !== true) {
    return NextResponse.json(
      { error: "Confirm that you are authorized to test this product." },
      { status: 400 }
    );
  }

  let productUrl: string;
  let docsUrl: string | null = null;
  try {
    productUrl = (await assertPublicTargetUrl(String(body.url || ""))).url.toString();
    if (typeof body.docs_url === "string" && body.docs_url.trim()) {
      docsUrl = (await assertPublicTargetUrl(body.docs_url)).url.toString();
    }
  } catch (error) {
    const message = error instanceof TargetUrlError
      ? error.message
      : "The product or documentation URL could not be validated.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length < 20 || description.length > 5_000) {
    return NextResponse.json(
      { error: "Test scope must be between 20 and 5,000 characters." },
      { status: 400 }
    );
  }

  const environment = body.environment === "production" ? "production" : "staging";
  if (environment === "production" && process.env.STS_ALLOW_PRODUCTION_TARGETS !== "true") {
    return NextResponse.json(
      { error: "Production targets require operator approval. Use a staging target for beta campaigns." },
      { status: 403 }
    );
  }

  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      user_id: user.id,
      url: productUrl,
      docs_url: docsUrl,
      description,
      environment,
      authorization_confirmed_at: new Date().toISOString(),
      status: "queued"
    })
    .select("id, status")
    .single();

  if (error) {
    if (error.code === "PGRST205" || /does not exist/i.test(error.message)) {
      return NextResponse.json(
        { error: "The campaign data model has not been provisioned." },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: "Unable to create the campaign." }, { status: 500 });
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_WEBHOOK_URL;
  const orchestratorSecret = process.env.ORCHESTRATOR_WEBHOOK_SECRET;
  let dispatchStatus: "not_configured" | "accepted" | "queued" = "not_configured";

  if (orchestratorUrl && orchestratorSecret) {
    const eventId = crypto.randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify({ campaign_id: data.id, event_id: eventId, kick: "new" });
    const signature = sign(payload, orchestratorSecret, timestamp);
    try {
      const response = await fetch(orchestratorUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-swarm-event-id": eventId,
          "x-swarm-timestamp": timestamp,
          "x-swarm-signature": signature
        },
        body: payload,
        signal: AbortSignal.timeout(10_000)
      });
      dispatchStatus = response.ok ? "accepted" : "queued";
    } catch {
      dispatchStatus = "queued";
    }
  }

  return NextResponse.json(
    { campaign_id: data.id, status: data.status, dispatch_status: dispatchStatus },
    { status: 201, headers: { "cache-control": "no-store" } }
  );
}
