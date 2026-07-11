"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardNav } from "@/components/DashboardNav";

type Status = "idle" | "submitting" | "submitted" | "error";
type Environment = "staging" | "production";

export default function DashboardPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [docsUrl, setDocsUrl] = useState("");
  const [description, setDescription] = useState("");
  const [environment, setEnvironment] = useState<Environment>("staging");
  const [authorized, setAuthorized] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("submitting");
    setError(null);

    try {
      const response = await fetch("/api/test-campaign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          docs_url: docsUrl || null,
          description,
          environment,
          authorization_confirmed: authorized
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error ?? "Request failed");
      }
      setStatus("submitted");
      if (data?.campaign_id) {
        router.push(`/dashboard/campaigns/${data.campaign_id}`);
      }
    } catch (submitError) {
      setStatus("error");
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
    }
  }

  const submitting = status === "submitting";

  return (
    <main className="min-h-screen">
      <DashboardNav />

      <section className="container-narrow py-16">
        <p className="text-sm uppercase tracking-widest text-accent">Test intake</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Start with your product and its documentation</h1>
        <p className="mt-3 max-w-3xl text-[var(--muted)]">
          Swarm Testing maps workflows, roles, settings, branches, and edge cases from the sources you provide. Staging is the default and safest target.
        </p>

        <form onSubmit={handleSubmit} className="mt-10 max-w-3xl space-y-6">
          <div>
            <label htmlFor="url" className="mb-2 block text-sm font-medium">Product URL</label>
            <input
              id="url"
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://staging.your-product.com"
              className="w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 outline-none focus:border-accent"
            />
          </div>

          <div>
            <label htmlFor="docs-url" className="mb-2 block text-sm font-medium">Documentation URL <span className="font-normal text-[var(--muted)]">(recommended)</span></label>
            <input
              id="docs-url"
              type="url"
              value={docsUrl}
              onChange={(event) => setDocsUrl(event.target.value)}
              placeholder="https://docs.your-product.com/getting-started"
              className="w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 outline-none focus:border-accent"
            />
            <p className="mt-2 text-xs text-[var(--muted)]">Use a public, test-safe entry point. Never paste passwords, API keys, or production customer data here.</p>
          </div>

          <div>
            <label htmlFor="environment" className="mb-2 block text-sm font-medium">Target environment</label>
            <select
              id="environment"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value as Environment)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-4 py-3 outline-none focus:border-accent"
            >
              <option value="staging">Staging or test (recommended)</option>
              <option value="production">Production</option>
            </select>
            {environment === "production" && (
              <p className="mt-2 text-sm text-amber-300">Production targets are blocked by default and require operator approval. They must use non-destructive test accounts and must not trigger real payments, emails, or irreversible actions.</p>
            )}
          </div>

          <div>
            <label htmlFor="description" className="mb-2 block text-sm font-medium">Scope, goals, and constraints</label>
            <textarea
              id="description"
              required
              minLength={20}
              maxLength={5000}
              rows={8}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Describe the core user journeys, user roles, test accounts, important settings, destructive actions to avoid, and what success means."
              className="w-full rounded-md border border-[var(--border)] bg-transparent px-4 py-3 outline-none focus:border-accent"
            />
            <p className="mt-2 text-xs text-[var(--muted)]">The engine will expand this into workflow, configuration, persona, failure, accessibility, and recovery scenarios.</p>
          </div>

          <label className="flex items-start gap-3 rounded-md border border-[var(--border)] p-4 text-sm">
            <input
              type="checkbox"
              required
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
              className="mt-1"
            />
            <span>I own this product or have explicit authorization to run automated tests against it, and I will provide test-safe accounts and data.</span>
          </label>

          <button
            type="submit"
            disabled={submitting || !authorized}
            className="rounded-md bg-accent px-6 py-3 font-medium hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Creating test plan..." : "Launch discovery run"}
          </button>
        </form>

        {status === "error" && error && (
          <div role="alert" className="mt-8 max-w-3xl rounded-md border border-red-500/40 p-6 text-sm text-red-300">{error}</div>
        )}
      </section>
    </main>
  );
}
