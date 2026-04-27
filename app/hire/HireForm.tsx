"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Status = "idle" | "submitting" | "submitted" | "error";

export function HireForm() {
  const router = useRouter();
  const [url, setUrl] = useState("https://agentwork-protocol-puce.vercel.app/");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        throw new Error(data?.error ?? "Request failed");
      }
      setStatus("submitted");
      if (data?.runId) {
        router.push(`/hire/runs/${data.runId}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Something went wrong.";
      setStatus("error");
      setError(msg);
    }
  }

  const submitting = status === "submitting";

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-md border border-zinc-800 bg-zinc-900/40 p-5"
    >
      <label htmlFor="url" className="block text-sm font-medium text-zinc-100">
        Protocol URL
      </label>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Top-level URL with <code>/.well-known/agent.json</code>. Examples:
        AgentWork Protocol, your protocol&apos;s landing page.
      </p>
      <input
        id="url"
        type="url"
        required
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={submitting}
        placeholder="https://your-protocol.example.com/"
        className="mt-3 w-full rounded-md border border-zinc-800 bg-black px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-accent focus:outline-none disabled:opacity-50"
      />
      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
        >
          {submitting ? "Starting…" : "Run audit"}
        </button>
        {status === "error" && error && (
          <span className="text-sm text-red-400">{error}</span>
        )}
      </div>
    </form>
  );
}
