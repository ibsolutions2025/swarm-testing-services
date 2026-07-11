import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter, PublicHeader } from "../_components/public-site";

export const metadata: Metadata = {
  title: "Resources | Swarm Testing Services",
  description: "Templates and checklists for preparing an authorized, high-quality swarm testing campaign."
};

const documentationTemplate = `Product name and environment:
Primary staging URL:
Documentation URL:

Users and roles
- Role, permissions, goals, and constraints

Critical workflows
- Starting state
- User goal
- Expected steps and outcome
- Recovery behavior

Configurations and settings
- Setting name, allowed values, defaults, and dependencies

Test data and accounts
- Synthetic identity, role, seeded state, and reset method

Boundaries
- Allowed hosts and paths
- Prohibited actions
- Rate and concurrency limits
- Stop conditions and emergency contact`;

const issueTemplate = `Scenario ID:
Environment and build:
Persona / role / configuration:
Preconditions:
Steps to reproduce:
Expected result:
Observed result:
Evidence (screenshot, trace, timestamp):
Customer impact and severity:
Confidence / open questions:
Suggested next action:`;

export default function ResourcesPage() {
  return (
    <main className="min-h-screen">
      <PublicHeader />
      <div className="container-narrow py-16 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-widest text-accent">Resources</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">Give the swarm context it can trust.</h1>
          <p className="mt-5 text-lg leading-8 text-[var(--muted)]">Use these templates to define a product, authorize the testing surface, and make every result reproducible. They are intentionally plain text so teams can place them in an existing README, knowledge base, or test-plan document.</p>
        </div>

        <section className="mt-14 grid gap-6 md:grid-cols-3" aria-labelledby="launch-checklist">
          <div className="md:col-span-3"><p className="text-sm uppercase tracking-widest text-accent">Before intake</p><h2 id="launch-checklist" className="mt-2 text-2xl font-semibold tracking-tight">Campaign preparation checklist</h2></div>
          <ChecklistCard title="Target" items={["Dedicated staging host", "Known build or release ID", "Seeded, resettable data", "Synthetic test accounts", "Third-party sandbox mode"]} />
          <ChecklistCard title="Scope" items={["Written authorization", "Allowed hosts and paths", "Prohibited actions", "Rate and concurrency limits", "Stop contact and conditions"]} />
          <ChecklistCard title="Oracle" items={["Expected outcomes", "Role and permission rules", "Error and recovery behavior", "Accessibility expectations", "Known issues and exceptions"]} />
        </section>

        <section id="documentation-template" className="scroll-mt-8 border-t border-[var(--border)] py-16">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
            <div><p className="text-sm uppercase tracking-widest text-accent">Template 01</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">Product documentation and scope</h2><p className="mt-4 leading-7 text-[var(--muted)]">Complete this before creating a campaign. Keep credentials in an approved secret-sharing channel, never in the document or URL.</p></div>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-white/[0.03] p-6 text-sm leading-6 text-zinc-300"><code>{documentationTemplate}</code></pre>
          </div>
        </section>

        <section className="border-t border-[var(--border)] py-16">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
            <div><p className="text-sm uppercase tracking-widest text-accent">Template 02</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">Finding and evidence record</h2><p className="mt-4 leading-7 text-[var(--muted)]">Use one record per distinct failure. A verdict without a reproducible path and evidence remains unverified.</p></div>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-white/[0.03] p-6 text-sm leading-6 text-zinc-300"><code>{issueTemplate}</code></pre>
          </div>
        </section>

        <section className="border-t border-[var(--border)] py-16">
          <p className="text-sm uppercase tracking-widest text-accent">Review guide</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">Questions to ask of a generated matrix</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {["Does every critical workflow have a success, failure, and recovery path?", "Are roles, permission boundaries, and account states represented?", "Which scenarios came from documentation, and which were inferred?", "Are settings tested individually and in meaningful combinations?", "Are destructive, billable, or externally visible actions clearly blocked?", "Can every acceptance criterion be observed without guesswork?", "Are accessibility, trust, privacy, and abuse risks included?", "What important area is intentionally excluded, and who approved that choice?"].map((question) => <div key={question} className="rounded-lg border border-[var(--border)] p-5 text-sm leading-6 text-[var(--muted)]">{question}</div>)}
          </div>
        </section>

        <section className="rounded-xl border border-accent/40 bg-accent/10 p-7">
          <h2 className="text-xl font-medium">Understand the operating model first.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">Review current beta capabilities, safety boundaries, evidence requirements, and limitations before submitting a target.</p>
          <div className="mt-5 flex flex-wrap gap-3"><Link href="/docs" className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200">Read the docs</Link><Link href="/login" className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-medium hover:bg-white/5">Sign in</Link></div>
        </section>
      </div>
      <PublicFooter />
    </main>
  );
}

function ChecklistCard({ title, items }: { title: string; items: readonly string[] }) {
  return <article className="rounded-lg border border-[var(--border)] p-6"><h3 className="font-medium">{title}</h3><ul className="mt-4 space-y-3 text-sm text-[var(--muted)]">{items.map((item) => <li key={item} className="flex gap-3"><span className="text-accent" aria-hidden="true">&#10003;</span><span>{item}</span></li>)}</ul></article>;
}
