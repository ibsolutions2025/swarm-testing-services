import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";
import { verify } from "@/lib/hmac";
import type { OrchestratorWebhookPayload } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

const PHASE_TO_STATUS = {
  matrix_designed: "generating_personas",
  personas_generated: "running",
  run_completed: "running",
  campaign_completed: "completed",
  campaign_failed: "failed"
} as const;

const STATUS_RANK: Record<string, number> = {
  queued: 0,
  designing: 1,
  generating_personas: 2,
  running: 3,
  completed: 4,
  failed: 4,
  cancelled: 4
};

function validPayload(value: unknown): value is OrchestratorWebhookPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.campaign_id === "string"
    && typeof payload.event_id === "string"
    && typeof payload.phase === "string"
    && payload.phase in PHASE_TO_STATUS
    && (payload.schema_version === undefined || payload.schema_version === 1);
}

export async function POST(req: NextRequest) {
  const secret = process.env.ORCHESTRATOR_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "webhook unavailable" }, { status: 503 });
  }

  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  const timestamp = req.headers.get("x-swarm-timestamp") ?? "";
  const eventId = req.headers.get("x-swarm-event-id") ?? "";
  const signature = req.headers.get("x-swarm-signature") ?? "";
  const timestampSeconds = Number(timestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return NextResponse.json({ error: "stale or invalid timestamp" }, { status: 401 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) {
    return NextResponse.json({ error: "invalid event id" }, { status: 400 });
  }

  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }
  if (!verify(raw, signature, secret, timestamp)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!validPayload(parsed) || parsed.event_id !== eventId) {
    return NextResponse.json({ error: "invalid webhook payload" }, { status: 400 });
  }

  const payload = parsed;
  const admin = createAdminClient();
  const payloadHash = crypto.createHash("sha256").update(raw).digest("hex");
  const { error: eventInsertError } = await admin.from("webhook_events").insert({
    event_id: eventId,
    campaign_id: payload.campaign_id,
    event_type: payload.phase,
    payload_sha256: payloadHash,
    status: "processing"
  });

  if (eventInsertError) {
    if (eventInsertError.code !== "23505") {
      return NextResponse.json({ error: "webhook ledger unavailable" }, { status: 503 });
    }
    const { data: existing } = await admin
      .from("webhook_events")
      .select("payload_sha256,status")
      .eq("event_id", eventId)
      .maybeSingle();
    if (!existing || existing.payload_sha256 !== payloadHash) {
      return NextResponse.json({ error: "event id conflict" }, { status: 409 });
    }
    if (existing.status === "completed") {
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    }
  }

  const { data: campaign, error: campaignError } = await admin
    .from("campaigns")
    .select("id,status")
    .eq("id", payload.campaign_id)
    .maybeSingle();
  if (campaignError || !campaign) {
    await admin.from("webhook_events").update({ status: "failed", error: "campaign not found" }).eq("event_id", eventId);
    return NextResponse.json({ error: "campaign not found" }, { status: 404 });
  }

  const nextStatus = PHASE_TO_STATUS[payload.phase];
  const currentRank = STATUS_RANK[campaign.status] ?? -1;
  const nextRank = STATUS_RANK[nextStatus] ?? -1;
  const terminal = ["completed", "failed", "cancelled"].includes(campaign.status);
  if (terminal || nextRank < currentRank) {
    await admin.from("webhook_events").update({ status: "completed", processed_at: new Date().toISOString() }).eq("event_id", eventId);
    return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
  }

  const data = payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : {};
  const { data: updated, error: updateError } = await admin
    .from("campaigns")
    .update({
      status: nextStatus,
      error: payload.phase === "campaign_failed" ? String(data.error ?? "unknown error").slice(0, 2_000) : null
    })
    .eq("id", payload.campaign_id)
    .eq("status", campaign.status)
    .select("id")
    .maybeSingle();

  if (updateError || !updated) {
    await admin.from("webhook_events").update({ status: "failed", error: "campaign transition conflict" }).eq("event_id", eventId);
    return NextResponse.json({ error: "campaign transition conflict" }, { status: 409 });
  }

  await admin
    .from("webhook_events")
    .update({ status: "completed", processed_at: new Date().toISOString(), error: null })
    .eq("event_id", eventId);

  return NextResponse.json({ ok: true }, { status: 200, headers: { "cache-control": "no-store" } });
}
