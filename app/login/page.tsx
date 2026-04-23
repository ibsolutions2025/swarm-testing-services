"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params?.get("next") ?? "/dashboard";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    try {
      const path = mode === "signup" ? "/api/auth/signup" : "/api/auth/signin";
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Something went wrong.");
      // Hard nav so the server component picks up the fresh cookie.
      window.location.href = next;
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
          <div className="flex items-center gap-1 rounded-md border border-[var(--border)] p-1 text-sm">
            <button
              type="button"
              onClick={() => {
                setMode("signin");
                setStatus("idle");
                setError(null);
              }}
              className={`flex-1 rounded px-3 py-2 transition-colors ${
                mode === "signin"
                  ? "bg-white/10 text-white"
                  : "text-[var(--muted)] hover:text-white"
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("signup");
                setStatus("idle");
                setError(null);
              }}
              className={`flex-1 rounded px-3 py-2 transition-colors ${
                mode === "signup"
                  ? "bg-white/10 text-white"
                  : "text-[var(--muted)] hover:text-white"
              }`}
            >
              Sign up
            </button>
          </div>

          <h1 className="mt-8 text-3xl font-semibold tracking-tight">
            {mode === "signup" ? "Create your account" : "Welcome back"}
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {mode === "signup"
              ? "Sign up with email and password — no confirmation email, no magic link."
              : "Sign in with your email and password."}
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 outline-none focus:border-accent"
              />
            </div>
            <div>
              <label htmlFor="password" className="mb-2 block text-sm">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  mode === "signup" ? "At least 8 characters" : "Your password"
                }
                className="w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 outline-none focus:border-accent"
              />
            </div>
            <button
              type="submit"
              disabled={status === "submitting"}
              className="w-full rounded-md bg-accent px-4 py-3 font-medium hover:opacity-90 disabled:opacity-50"
            >
              {status === "submitting"
                ? mode === "signup"
                  ? "Creating account…"
                  : "Signing in…"
                : mode === "signup"
                ? "Create account"
                : "Sign in"}
            </button>
          </form>

          {status === "error" && error && (
            <p className="mt-6 rounded-md border border-red-500/40 p-4 text-sm text-red-300">
              {error}
            </p>
          )}

          {mode === "signin" && (
            <p className="mt-6 text-center text-sm text-[var(--muted)]">
              New here?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("signup");
                  setStatus("idle");
                  setError(null);
                }}
                className="text-accent hover:underline"
              >
                Create an account
              </button>
            </p>
          )}

          <p className="mt-8 text-center text-xs text-[var(--muted)]">
            By signing in you agree to our Terms & Privacy.
          </p>
        </div>
      </div>
    </main>
  );
}
