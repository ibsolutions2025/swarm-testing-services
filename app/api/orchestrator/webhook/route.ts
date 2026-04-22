import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verify } from "@/lib/hmac";
import type { OrchestratorWebhookPayload } from "@/lib/types";

/**
 * POST /api/orchestrator/webhook
 *
 * The orchestrator service calls this to update campaign state as phases
 * complete. Signed with HMAC-SHA256 using ORCHESTRATOR_WEBHOOK_SECRET.
 *
 * This uses the service-role client (not the user's cookie session) so the
 * orchestrator can write without impersonating the user.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.ORCHESTRATOR_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "ORCHESTRATOR_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }

  const raw = await req.text();
  const sig = req.headers.get("x-swarm-signature") ?? "";

  if (!verify(raw, sig, secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: OrchestratorWebhookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!serviceKey || !supabaseUrl) {
    return NextResponse.json(
      { error: "service-role credentials missing" },
      { status: 500 }
    );
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });

  const nextStatus: Record<string, string> = {
    matrix_designed: "generating_personas",
    personas_generated: "running",
    run_completed: "running",
    campaign_completed: "completed",
    campaign_failed: "failed"
  };

  const { error } = await admin
    .from("campaigns")
    .update({
      status: nextStatus[payload.phase] ?? "running",
      error:
        payload.phase === "campaign_failed"
          ? String((payload.data as any)?.error ?? "unknown error")
          : null
    })
    .eq("id", payload.campaign_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
