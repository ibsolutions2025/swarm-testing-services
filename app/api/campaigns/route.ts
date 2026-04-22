import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

/**
 * GET /api/campaigns — list the authenticated user's campaigns, newest first.
 */
export async function GET() {
  const supabase = createServerClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("campaigns")
    .select("id, url, description, status, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    if (error.code === "PGRST205" || /does not exist/i.test(error.message)) {
      return NextResponse.json({ campaigns: [], table_missing: true }, { status: 200 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ campaigns: data }, { status: 200 });
}
