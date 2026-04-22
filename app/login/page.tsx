"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError(null);

    try {
      const supabase = createBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo:
            typeof window !== "undefined"
              ? `${window.location.origin}/auth/callback?next=/dashboard`
              : undefined
        }
      });
      if (error) throw error;
      setStatus("sent");
    } catch (err: any) {
      setStatus("error");
      setError(err?.message ?? "Something went wrong.");
    }
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-[var(--border)]">
        <div className="container-narrow flex items-center justify-between py-5">
          <Link href="/" className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-accent" />
            <span className="font-semibold tracking-tight">Swarm Testing</span>
          </Link>
        </div>
      </header>

      <div className="container-narrow flex min-h-[70vh] items-center justify-center py-20">
        <div className="w-full max-w-sm">
          <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Enter your work email and we'll send you a magic link.
          </p>

          <form onSubmit={handleMagicLink} className="mt-8 space-y-4">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 outline-none focus:border-accent"
              />
            </div>
            <button
              type="submit"
              disabled={status === "sending"}
              className="w-full rounded-md bg-accent px-4 py-3 font-medium hover:opacity-90 disabled:opacity-50"
            >
              {status === "sending" ? "Sending…" : "Send magic link"}
            </button>
          </form>

          {status === "sent" && (
            <p className="mt-6 rounded-md border border-[var(--border)] p-4 text-sm">
              Check your inbox. The link will sign you in and drop you on your
              dashboard.
            </p>
          )}
          {status === "error" && error && (
            <p className="mt-6 rounded-md border border-red-500/40 p-4 text-sm text-red-300">
              {error}
            </p>
          )}

          <p className="mt-10 text-center text-xs text-[var(--muted)]">
            By signing in you agree to our Terms & Privacy.
          </p>
        </div>
      </div>
    </main>
  );
}
