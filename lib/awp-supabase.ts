import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-only client for the external AWP Supabase (nyhwpkxezlwkwmjuklaj).
 * Used by the AWP project dashboard to surface lifecycle_results populated
 * by the VPS-hosted awp-lifecycle-scanner. This repo's own Supabase is a
 * separate project and is accessed via lib/supabase-server.ts.
 */
const URL = process.env.AWP_SUPABASE_URL;
const KEY = process.env.AWP_SUPABASE_ANON_KEY;

let cached: SupabaseClient | null = null;

export function awpSupabase(): SupabaseClient {
  if (cached) return cached;
  if (!URL || !KEY) {
    throw new Error(
      "AWP_SUPABASE_URL / AWP_SUPABASE_ANON_KEY not set — cannot read lifecycle_results"
    );
  }
  cached = createClient(URL, KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return cached;
}
