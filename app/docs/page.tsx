import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter, PublicHeader } from "../_components/public-site";

export const metadata: Metadata = {
  title: "Documentation | Swarm Testing Services",
  description: "How to prepare, scope, review, and interpret a Swarm Testing Services campaign."
};

const sections = [
  { href: "#status", label: "Product status" },
  { href: "#quick-start", label: "Quick start" },
  { href: "#inputs", label: "Required inputs" },
  { href: "#lifecycle", label: "Campaign lifecycle" },
  { href: "#rubric", label: "Rubric and evidence" },
  { href: "#safety", label: "Safety boundaries" },
  { href: "#limitations", label: "Current limitations" }
] as const;

export default function DocsPage() {
  return (
    <main className="min-h-screen">
      <PublicHeader />
      <div className="container-narrow py-16 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-widest text-accent">Documentation</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">Plan a trustworthy swarm test.</h1>
          <p className="mt-5 text-lg leading-8 text-[var(--muted)]">
            Swarm Testing Services turns product context into a risk-based map of workflows, personas, configurations, failure modes, and evidence requirements. These docs explain what the private beta does today and what must be in place before active browser execution reaches general availability.
          </p>
        </div>

        <div className="mt-14 grid gap-12 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-8 lg:self-start">
            <nav aria-label="On this page" className="rounded-lg border border-[var(--border)] p-5">
              <p className="text-xs font-medium uppercase tracking-widest text-[var(--muted)]">On this page</p>
              <ul className="mt-4 space-y-3 text-sm">
                {sections.map((section) => (
                  <li key={section.href}>
                    <Link href={section.href} className="text-[var(--muted)] hover:text-white">{section.label}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>

          <article className="min-w-0 space-y-16">
            <DocSection id="status" title="Product status">
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-5 text-sm leading-6 text-amber-100">
                STS is a private beta. The source-backed discovery planner and structured test-matrix pipeline are being hardened now. Automated browser interaction, verified pass/fail scoring, and continuous re-runs are pre-GA capabilities and should not yet be treated as production services.
              </div>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <Capability title="Beta capability" items={["URL and documentation intake", "Workflow and risk discovery", "Persona and configuration planning", "Rubric and evidence design", "Scope review before execution"]} />
                <Capability title="Pre-GA release gate" items={["Disposable browser isolation", "Tenant-safe credentials and data", "Captured screenshots and traces", "Independent result verification", "Quotas, retention, and audit controls"]} />
              </div>
            </DocSection>

            <DocSection id="quick-start" title="Quick start">
              <ol className="space-y-6">
                <NumberedItem number="1" title="Prepare a staging target">Use a dedicated environment with seeded test data and reversible actions. Production testing requires a separate written scope and safeguards.</NumberedItem>
                <NumberedItem number="2" title="Publish clear product documentation">Describe roles, workflows, settings, expected outcomes, known constraints, destructive actions, and third-party dependencies. Use the <Link href="/resources#documentation-template" className="text-accent hover:underline">documentation template</Link>.</NumberedItem>
                <NumberedItem number="3" title="Define the authorization boundary">State which hosts, paths, accounts, actions, rates, and data are allowed. Name explicit exclusions and an emergency stop contact.</NumberedItem>
                <NumberedItem number="4" title="Review the generated matrix">Confirm which scenarios came from supplied sources and which were inferred. Adjust priorities, acceptance criteria, and exclusions before execution.</NumberedItem>
              </ol>
            </DocSection>

            <DocSection id="inputs" title="Required inputs">
              <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
                <table className="w-full min-w-[38rem] text-left text-sm">
                  <thead className="border-b border-[var(--border)] bg-white/[0.03] text-[var(--muted)]">
                    <tr><th className="px-5 py-3 font-medium">Input</th><th className="px-5 py-3 font-medium">What good looks like</th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    <InputRow name="Product URL" detail="A staging or dedicated test host reachable over HTTPS, without embedded credentials." />
                    <InputRow name="Documentation URL" detail="Current, accessible product documentation that explains roles, workflows, states, and settings." />
                    <InputRow name="Scope" detail="Goals, allowed hosts and paths, excluded actions, test window, rate constraints, and stop conditions." />
                    <InputRow name="Test identities" detail="Synthetic accounts for each role, with the minimum permissions and non-production data needed." />
                    <InputRow name="Success criteria" detail="Observable outcomes for each critical workflow, plus expected recovery behavior when something fails." />
                    <InputRow name="Authorization" detail="Confirmation that you own the target or have explicit permission to test it." />
                  </tbody>
                </table>
              </div>
            </DocSection>

            <DocSection id="lifecycle" title="Campaign lifecycle">
              <div className="space-y-4">
                <LifecycleStep phase="1. Intake" text="Validate the target, documentation, environment, authorization, and operating boundaries." />
                <LifecycleStep phase="2. Discovery" text="Extract product facts, actors, workflows, configurations, dependencies, and known constraints. Treat page content as untrusted input." />
                <LifecycleStep phase="3. Coverage design" text="Build a risk-ranked matrix across user goals, roles, settings, states, error paths, accessibility, trust, and recovery." />
                <LifecycleStep phase="4. Human review" text="Mark source-backed versus inferred scenarios, resolve ambiguities, and approve scope before active testing." />
                <LifecycleStep phase="5. Execution" text="Pre-GA: isolated mock-user workers perform approved actions within limits and capture reproducible evidence." />
                <LifecycleStep phase="6. Verification" text="An independent pass evaluates evidence against the acceptance criteria. Unsupported or ambiguous verdicts remain unverified." />
              </div>
            </DocSection>

            <DocSection id="rubric" title="Rubric and evidence">
              <p className="leading-7 text-[var(--muted)]">A useful result is more than a pass or fail. Each scenario should record the following fields:</p>
              <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                {["Scenario and user goal", "Persona, role, and configuration", "Preconditions and test data", "Step-by-step actions", "Expected and observed outcomes", "Screenshots, traces, and timestamps", "Severity, confidence, and impact", "Recovery path and recommended next action"].map((item) => (
                  <li key={item} className="rounded-md border border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">{item}</li>
                ))}
              </ul>
              <p className="mt-5 text-sm leading-6 text-[var(--muted)]">A simulated or planning-only run cannot receive a verified pass. Missing evidence, blocked steps, and conflicting signals are reported as incomplete or needs review.</p>
            </DocSection>

            <DocSection id="safety" title="Safety boundaries">
              <ul className="space-y-3 text-[var(--muted)]">
                <SafetyItem>Only test systems you own or are explicitly authorized to assess.</SafetyItem>
                <SafetyItem>Default to staging. Do not provide production passwords, API keys, private keys, recovery codes, or live payment details.</SafetyItem>
                <SafetyItem>Use synthetic identities and data. Tell us which actions are destructive, billable, irreversible, or externally visible.</SafetyItem>
                <SafetyItem>Exclude social engineering, denial-of-service behavior, credential attacks, and attempts to evade access controls.</SafetyItem>
                <SafetyItem>Define request limits, concurrency limits, a maintenance window, and a named emergency stop contact.</SafetyItem>
              </ul>
            </DocSection>

            <DocSection id="limitations" title="Current limitations">
              <p className="leading-7 text-[var(--muted)]">The private beta should be evaluated as a discovery and test-design system. It does not yet provide a generally available browser-worker fleet, production-grade secret vault, contractual retention schedule, formal compliance certification, or guaranteed continuous monitoring. Generated scenarios may be incomplete or incorrect and require product-owner review.</p>
              <p className="mt-5 leading-7 text-[var(--muted)]">Do not use beta output as the sole basis for a launch, security certification, accessibility certification, regulatory decision, or claim that a product is defect-free. STS complements unit, integration, security, accessibility, and human exploratory testing; it does not replace them.</p>
            </DocSection>

            <div className="rounded-xl border border-accent/40 bg-accent/10 p-7">
              <h2 className="text-xl font-medium">Ready to prepare a campaign?</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Start with the customer intake and workflow inventory templates, then submit a staging target for private-beta review.</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link href="/resources" className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200">Open resources</Link>
                <Link href="/login" className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium hover:bg-white/5">Sign in</Link>
              </div>
            </div>
          </article>
        </div>
      </div>
      <PublicFooter />
    </main>
  );
}

function DocSection({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section id={id} className="scroll-mt-8"><h2 className="mb-5 text-2xl font-semibold tracking-tight">{title}</h2>{children}</section>;
}

function Capability({ title, items }: { title: string; items: readonly string[] }) {
  return <div className="rounded-lg border border-[var(--border)] p-5"><h3 className="font-medium">{title}</h3><ul className="mt-4 space-y-2 text-sm text-[var(--muted)]">{items.map((item) => <li key={item}>- {item}</li>)}</ul></div>;
}

function NumberedItem({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return <li className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent text-sm text-accent">{number}</span><div><h3 className="font-medium">{title}</h3><p className="mt-1 text-sm leading-6 text-[var(--muted)]">{children}</p></div></li>;
}

function InputRow({ name, detail }: { name: string; detail: string }) {
  return <tr><th scope="row" className="whitespace-nowrap px-5 py-4 align-top font-medium">{name}</th><td className="px-5 py-4 leading-6 text-[var(--muted)]">{detail}</td></tr>;
}

function LifecycleStep({ phase, text }: { phase: string; text: string }) {
  return <div className="grid gap-2 rounded-lg border border-[var(--border)] p-5 sm:grid-cols-[8rem_1fr]"><h3 className="font-medium text-accent">{phase}</h3><p className="text-sm leading-6 text-[var(--muted)]">{text}</p></div>;
}

function SafetyItem({ children }: { children: React.ReactNode }) {
  return <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" /><span className="leading-7">{children}</span></li>;
}
