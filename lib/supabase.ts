import { createBrowserClient as createSSRBrowserClient } from "@supabase/ssr";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Browser-side Supabase client. Use inside `"use client"` components
 * for auth flows and direct reads.
 */
export function createBrowserClient() {
  if (!URL || !ANON_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      "[supabase] NEXT_PUBLIC_SUPABASE_URL / ANON_KEY missing — set .env.local"
    );
  }
  return createSSRBrowserClient(URL, ANON_KEY);
}
