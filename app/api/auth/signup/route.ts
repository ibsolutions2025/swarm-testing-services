import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase-server";

/**
 * POST /api/auth/signup
 * Body: { email, password }
 *
 * Uses Supabase's public signup flow so email ownership is verified when
 * confirmation is enabled. This route must never use the service-role admin
 * API to mutate an existing user.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json(
      { error: "A valid email is required." },
      { status: 400 }
    );
  }
  if (password.length < 12) {
    return NextResponse.json(
      { error: "Password must be at least 12 characters." },
      { status: 400 }
    );
  }

  const supabase = createServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${req.nextUrl.origin}/auth/callback?next=/dashboard`
    }
  });

  if (error) {
    const rateLimited = error.status === 429 || /rate limit/i.test(error.message || "");
    return NextResponse.json(
      {
        error: rateLimited
          ? "Too many signup attempts. Please wait and try again."
          : "Unable to create an account. Check your details and try again."
      },
      { status: rateLimited ? 429 : 400 }
    );
  }

  const requiresConfirmation = !data.session;
  return NextResponse.json(
    {
      ok: true,
      requiresConfirmation,
      message: requiresConfirmation
        ? "If the address can be registered, check your email to continue."
        : "Account created."
    },
    {
      status: requiresConfirmation ? 202 : 200,
      headers: { "cache-control": "no-store" }
    }
  );
}
