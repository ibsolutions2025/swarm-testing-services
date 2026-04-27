/**
 * POST /api/onboarding — kick off an Onboarding Engine run.
 *
 * 1. Auth: require a Supabase session.
 * 2. Validate: URL must be http(s), parsable.
 * 3. Generate runId: <userShort>-<timestamp> (filesystem-safe).
 * 4. Insert onboarding_runs row with status='queued' (RLS: user_id = auth.uid()).
 * 5. POST to VPS server.mjs /onboarding/start to spawn the engine.
 * 6. Return { runId } so the client can redirect to /hire/runs/<runId>.
 *
 * If the VPS server is unreachable, the row stays at 'queued' and we
 * return 202 — a cron can pick it up later, or the operator can manually
 * kick the engine.
 *
 * Phase C scope. See clients/.shared/PHASE-C-DESIGN.md C.4.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function generateRunId(userId: string): string {
  // <userShort>-<utc timestamp>. user_short isolates per-customer namespace,
  // timestamp provides monotonic ordering + collision-resistance within
  // the same second.
  const userShort = userId.replace(/-/g, "").slice(0, 6);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `c-${userShort}-${ts}`;
}

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    return NextResponse.json({ error: "url must be http(s)" }, { status: 400 });
  }

  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const runId = generateRunId(user.id);

  // Insert onboarding_runs row. RLS check: user_id must equal auth.uid()
  // (the WITH CHECK in 0006_onboarding_runs.sql).
  const { error } = await supabase
    .from("onboarding_runs")
    .insert({ run_id: runId, user_id: user.id, url, status: "queued" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Fire to VPS server. Best-effort: if the server is offline, the row
  // stays queued and we report 202; a poll-based dispatcher can pick it up.
  const serverUrl = process.env.ONBOARDING_SERVER_URL;
  const serverToken = process.env.ONBOARDING_SERVER_TOKEN;

  if (serverUrl && serverToken) {
    try {
      const r = await fetch(`${serverUrl.replace(/\/+$/, "")}/onboarding/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${serverToken}`,
        },
        body: JSON.stringify({ runId, url, userId: user.id }),
        // Vercel function timeout default is 10s; the VPS spawn is sub-100ms
        // but the network round-trip + cold pm2 process can spike. 5s cap.
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.warn(`[/api/onboarding] VPS start returned ${r.status}: ${txt.slice(0, 200)}`);
        return NextResponse.json(
          { runId, status: "queued", note: `VPS server returned ${r.status} — run remains queued` },
          { status: 202 }
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[/api/onboarding] VPS unreachable: ${msg}`);
      return NextResponse.json(
        { runId, status: "queued", note: `VPS unreachable — run remains queued (${msg})` },
        { status: 202 }
      );
    }
  } else {
    console.warn(`[/api/onboarding] ONBOARDING_SERVER_URL or _TOKEN unset — run stays queued`);
    return NextResponse.json(
      { runId, status: "queued", note: "ONBOARDING_SERVER_URL/TOKEN env vars unset; run is queued for manual dispatch" },
      { status: 202 }
    );
  }

  return NextResponse.json({ runId, status: "running" }, { status: 201 });
}
