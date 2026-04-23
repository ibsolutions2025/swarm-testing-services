"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardNav } from "@/components/DashboardNav";

type Status = "idle" | "submitting" | "submitted" | "error";

export default function DashboardPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    try {
      const res = await fetch("/api/test-campaign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, description })
      });
      const data = await res.json();
      if (!res.ok && res.status !== 202) {
        throw new Error(data?.error ?? "Request failed");
      }
      setStatus("submitted");
      // Redirect to the campaign detail so they can watch status.
      if (data?.campaign_id && !String(data.campaign_id).startsWith("stub-")) {
        router.push(`/dashboard/campaigns/${data.campaign_id}`);
      }
    } catch (err: any) {
      setStatus("error");
      setError(err?.message ?? "Something went wrong.");
    }
  }

  return (
    <main className="min-h-screen">
      <DashboardNav />

      <section className="container-narrow py-16">
        <h1 className="text-3xl font-semibold tracking-tight">
          New project
        </h1>
        <p className="mt-2 text-[var(--muted)]">
          Give us a URL and describe what you want the swarm to test. We'll
          design the matrix, build personas, and return transactions you can
          act on.
        </p>

        <form onSubmit={handleSubmit} className="mt-10 space-y-6">
          <div>
            <label htmlFor="url" className="mb-2 block text-sm font-medium">
              Product URL
            </label>
            <input
              id="url"
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-product.com"
              className="w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 outline-none focus:border-accent"
            />
          </div>

          <div>
            <label
              htmlFor="description"
              className="mb-2 block text-sm font-medium"
            >
              What do you want the swarm to test?
            </label>
            <textarea
              id="description"
              required
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                'Example: "I want to see if new users can complete signup, understand pricing, and complete their first purchase without friction. Especially worried about the checkout form on mobile."'
              }
              className="w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 outline-none focus:border-accent"
            />
            <p className="mt-2 text-xs text-[var(--muted)]">
              Plain English is fine — the more specific, the sharper the
              matrix. 20+ characters required.
            </p>
          </div>

          <button
            type="submit"
            disabled={status === "submitting"}
            className="rounded-md bg-accent px-6 py-3 font-medium hover:opacity-90 disabled:opacity-50"
          >
            {status === "submitting" ? "Designing matrix…" : "Launch project"}
          </button>
        </form>

        {status === "error" && error && (
          <div className="mt-8 rounded-md border border-red-500/40 p-6 text-sm text-red-300">
            {error}
          </div>
        )}
      </section>
    </main>
  );
}
