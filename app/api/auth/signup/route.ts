import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase-admin";

/**
 * POST /api/auth/signup
 * Body: { email, password }
 *
 * Create-or-update flow:
 *   1. Try to create a new user via the service-role admin client with
 *      email_confirm=true so they can sign in immediately (no confirmation
 *      email, no magic link).
 *   2. If the email already exists, look it up and update the password
 *      instead — this lets users who originally signed up via magic link
 *      convert to password auth without losing their account.
 *   3. Finally, sign the user in server-side so the session cookie is set.
 */
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json(
      { error: "A valid email is required." },
      { status: 400 }
    );
  }
  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // 1) Try to create.
  const { data: created, error: createErr } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

  if (createErr) {
    const msg = createErr.message ?? "";
    const alreadyExists =
      /already been registered/i.test(msg) ||
      /already exists/i.test(msg) ||
      /duplicate/i.test(msg) ||
      (createErr as any).status === 422;

    if (!alreadyExists) {
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    // 2) Existing user — find them, then reset password.
    const { data: list, error: listErr } = await admin.auth.admin.listUsers();
    if (listErr) {
      return NextResponse.json({ error: listErr.message }, { status: 500 });
    }
    const existing = list.users.find(
      (u) => (u.email ?? "").toLowerCase() === email.toLowerCase()
    );
    if (!existing) {
      return NextResponse.json(
        { error: "User exists but could not be found for update." },
        { status: 500 }
      );
    }
    const { error: updErr } = await admin.auth.admin.updateUserById(
      existing.id,
      { password, email_confirm: true }
    );
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }
  }

  // 3) Sign the user in through the anon/server client so cookies are set.
  const supabase = createServerClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email,
    password
  });
  if (signInErr) {
    return NextResponse.json({ error: signInErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
