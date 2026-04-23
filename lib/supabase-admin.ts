import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. Bypasses RLS.
 *
 * USE ONLY IN SERVER-SIDE CODE (route handlers, server components, server
 * actions). Never expose the service key to the browser.
 *
 * Used for:
 *   - Seeding demo data (AWP project) on behalf of a user
 *   - Orchestrator writes (matrices, personas, runs)
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !serviceKey) {
    throw new Error(
      "[supabase-admin] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing"
    );
  }
  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
