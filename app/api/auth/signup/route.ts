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
 *   2. If the email already exists, return 409 and ask the caller to log in.
 *      We never reset an existing account's password from an unauthenticated
 *      signup request (that would be account takeover — see S1).
 *   3. For a newly created user, sign them in server-side so the cookie is set.
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

    // 2) Existing user — DO NOT reset the password or sign them in. Resetting an
    //    existing account's password from an unauthenticated signup request with
    //    no proof of ownership is an account-takeover vector (S1). Return a clear
    //    409 and direct the caller to log in instead.
    return NextResponse.json(
      { error: "An account with this email already exists. Please log in." },
      { status: 409 }
    );
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
