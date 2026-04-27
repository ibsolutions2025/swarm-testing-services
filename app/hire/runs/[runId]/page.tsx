/**
 * /hire/runs/[runId] — live run status page.
 *
 * Server component auth-gates, then mounts the OnboardingStepper client
 * component which polls /api/onboarding/status every 3s. The stepper
 * renders a 12-box state machine matching engine.mjs's STEPS array.
 *
 * Phase C scope. See clients/.shared/PHASE-C-DESIGN.md C.4.
 */
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase-server";
import { OnboardingStepper } from "@/components/OnboardingStepper";

export const dynamic = "force-dynamic";

type PageProps = { params: { runId: string } };

export default async function HireRunPage({ params }: PageProps) {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/hire/runs/${params.runId}`);

  // Confirm the run exists + caller owns it (RLS would reject anyway, but
  // we want a clean 404 page rather than an empty stepper).
  const { data: run } = await supabase
    .from("onboarding_runs")
    .select("run_id")
    .eq("run_id", params.runId)
    .maybeSingle();
  if (!run) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-2xl font-semibold text-zinc-100">Run not found</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          The run <code>{params.runId}</code> doesn&apos;t exist or isn&apos;t yours.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <OnboardingStepper runId={params.runId} />
    </main>
  );
}
