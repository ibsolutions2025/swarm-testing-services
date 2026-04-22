import { createClient } from "@supabase/supabase-js";
import { env } from "./env.mjs";

let _client = null;

export function supabase() {
  if (_client) return _client;
  _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
  return _client;
}

export async function claimNextQueued() {
  // Atomically pull one queued campaign and flip to 'designing'.
  // Uses a conditional update (optimistic) so two orchestrators can't race.
  const db = supabase();
  const { data: queued } = await db
    .from("campaigns")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!queued) return null;

  const { data, error } = await db
    .from("campaigns")
    .update({ status: "designing" })
    .eq("id", queued.id)
    .eq("status", "queued") // only if still queued
    .select("id, url, description")
    .maybeSingle();

  if (error) {
    console.error("[orchestrator] claim failed:", error.message);
    return null;
  }
  return data; // null if another worker beat us
}

export async function setStatus(campaignId, status, error = null) {
  const db = supabase();
  await db
    .from("campaigns")
    .update({ status, error })
    .eq("id", campaignId);
}

export async function saveMatrix(campaignId, rows, columns) {
  const db = supabase();
  const { data, error } = await db
    .from("matrices")
    .insert({ campaign_id: campaignId, rows, columns })
    .select("id")
    .single();
  if (error) throw error;
  await db.from("campaigns").update({ matrix_id: data.id }).eq("id", campaignId);
  return data.id;
}

export async function savePersona(campaignId, row, persona) {
  const db = supabase();
  const { data, error } = await db
    .from("personas")
    .insert({
      campaign_id: campaignId,
      matrix_row_id: row.id,
      name: persona.name,
      archetype: persona.archetype,
      goals: persona.goals ?? [],
      biases: persona.biases ?? [],
      soul_md: persona.soul_md ?? ""
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function saveRun(campaignId, row, col, personaId, runResult) {
  const db = supabase();
  const { error } = await db
    .from("runs")
    .upsert(
      {
        campaign_id: campaignId,
        matrix_row_id: row.id,
        matrix_column_id: col.id,
        persona_id: personaId,
        outcome: runResult.outcome,
        transcript: runResult.transcript ?? [],
        quote: runResult.quote ?? null,
        duration_ms: runResult.duration_ms ?? 0
      },
      { onConflict: "campaign_id,matrix_row_id,matrix_column_id" }
    );
  if (error) throw error;
}
