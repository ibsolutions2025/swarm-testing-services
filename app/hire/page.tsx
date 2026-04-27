/**
 * /hire — Hire-the-Swarm landing page.
 *
 * Server-component shell auth-gates the route (redirects to /login?next=/hire
 * for unauthenticated visitors), then renders the client form below. On
 * submit the form POSTs /api/onboarding and redirects to /hire/runs/[runId]
 * where the live stepper takes over.
 *
 * Phase C scope. See clients/.shared/PHASE-C-DESIGN.md C.4.
 */
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase-server";
import { HireForm } from "./HireForm";

export const dynamic = "force-dynamic";

export default async function HirePage() {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/hire");

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <div className="mb-3 text-xs uppercase tracking-widest text-accent">
        Onboarding · Phase C
      </div>
      <h1 className="text-3xl font-semibold text-zinc-100">
        Hire AI agents to test your protocol
      </h1>
      <p className="mt-4 text-base text-[var(--muted)]">
        Drop a URL. Our engine reads <code>/.well-known/agent.json</code>,
        crawls your contracts on chain, derives the lifecycle test matrix
        from your contract source, and produces an audit doc — usually in
        7–10 minutes.
      </p>

      <section className="mt-10">
        <HireForm />
      </section>

      <section className="mt-12 grid gap-4 md:grid-cols-2">
        <Pillar
          title="Zero pre-knowledge onboarding"
          body="The engine reads only your URL. It derives the entire test matrix from your protocol's own state machine — no special prep on your side."
        />
        <Pillar
          title="Real cognitive agents, not scripts"
          body="The swarm is 7 blank-slate agents. Each finds your docs, decides which path to take, and reports back. Failures tell you where your docs or MCP are unclear."
        />
        <Pillar
          title="6-bucket audited matrix"
          body="Pass / fail / correctly-blocked / running / untested / N/A. Failures land in agent_too_dumb, mcp_product_gap, docs_product_gap, correct_enforcement, contract_flaw, or infra_issue."
        />
        <Pillar
          title="Cost transparency"
          body="Engine cost is shown live during the run, summed at the bottom. Typical AWP-shaped run is ~$0.66 of LLM compute."
        />
      </section>
    </main>
  );
}

function Pillar({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-5">
      <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      <p className="mt-2 text-sm text-[var(--muted)]">{body}</p>
    </div>
  );
}
