/**
 * /hire/runs/[runId]/edit — HITL editor page (C.5).
 *
 * Server-component shell auth-gates + verifies the run is complete.
 * Mounts the EditorTabs client component which fetches /api/onboarding/data
 * + /api/onboarding/cutover-preview and renders the three sub-editors.
 *
 * Phase C.5 scope. See clients/.shared/PHASE-C-DESIGN.md C.5.
 */
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase-server";
import { EditorTabs } from "./EditorTabs";

export const dynamic = "force-dynamic";

type PageProps = { params: { runId: string } };

export default async function EditPage({ params }: PageProps) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/hire/runs/${params.runId}/edit`);

  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("run_id, status, slug, url")
    .eq("run_id", params.runId)
    .maybeSingle();
  if (!run) notFound();

  // Editor only renders on terminal-complete or already-greenlit runs.
  if (run.status !== "complete" && run.status !== "greenlit") {
    return (
      <main className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="text-2xl font-semibold text-zinc-100">Edit not available yet</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Run status is <code className="text-zinc-300">{run.status}</code>. The editor unlocks once
          the engine completes. <Link href={`/hire/runs/${params.runId}`} className="text-accent hover:underline">Go back to the run page</Link>.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-[var(--muted)]">Edit · HITL</div>
          <h1 className="mt-1 font-mono text-lg text-zinc-100">{params.runId}</h1>
          {run.slug && (
            <div className="mt-1 text-sm text-[var(--muted)]">slug: <code className="text-zinc-300">{run.slug}</code></div>
          )}
        </div>
        <Link href={`/hire/runs/${params.runId}`} className="text-sm text-accent hover:underline">
          ← Back to run
        </Link>
      </div>

      <EditorTabs runId={params.runId} />
    </main>
  );
}
