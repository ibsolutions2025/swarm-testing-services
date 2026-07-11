import Link from "next/link";
import { PublicFooter, PublicHeader } from "./_components/public-site";

export default function LandingPage() {
  return (
    <main className="min-h-screen">
      <PublicHeader />

      <section className="container-narrow py-24">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-indigo-200">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          Private beta: discovery and test planning
        </div>
        <p className="mb-4 text-sm uppercase tracking-widest text-accent">
          Agentic product testing
        </p>
        <h1 className="max-w-4xl text-5xl font-semibold leading-[1.05] tracking-tight md:text-6xl">
          Turn a product URL into a rigorous, reviewable test plan.
        </h1>
        <p className="mt-6 max-w-3xl text-lg leading-8 text-[var(--muted)]">
          Provide a staging URL, clear product documentation, and an authorized scope. Swarm Testing Services maps workflows, configurations, personas, risks, and edge cases into an evidence-ready testing rubric. Isolated browser execution by mock-user agents is the next pre-GA milestone.
        </p>
        <div className="mt-10 flex flex-wrap gap-3">
          <Link
            href="/login"
            className="rounded-md bg-accent px-6 py-3 font-medium transition-opacity hover:opacity-90"
          >
            Join the private beta
          </Link>
          <Link
            href="/docs"
            className="rounded-md border border-[var(--border)] px-6 py-3 font-medium transition-colors hover:bg-white/5"
          >
            Read the docs
          </Link>
        </div>
        <p className="mt-4 max-w-2xl text-xs leading-5 text-[var(--muted)]">
          Use staging or a dedicated test environment. Never submit secrets, production credentials, or data you are not authorized to test.
        </p>
      </section>

      <section id="how-it-works" className="border-t border-[var(--border)] py-20">
        <div className="container-narrow">
          <p className="text-sm uppercase tracking-widest text-accent">The workflow</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">From source material to accountable coverage</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            <Step
              n={1}
              title="Define the authorized surface"
              body="Submit a staging URL, documentation URL, test goals, exclusions, credentials policy, and explicit confirmation that you control or are authorized to test the target."
            />
            <Step
              n={2}
              title="Generate a risk-based matrix"
              body="The discovery planner derives workflows, user personas, settings, failure modes, accessibility checks, and edge cases. Every inferred scenario is marked for review instead of being presented as fact."
            />
            <Step
              n={3}
              title="Review before execution"
              body="You approve the scope and rubric before any active testing. Today the beta produces the reviewable plan; isolated browser workers, captured evidence, and verified pass/fail scoring are pre-GA gates."
            />
          </div>
        </div>
      </section>

      <section className="border-t border-[var(--border)] py-20">
        <div className="container-narrow">
          <div className="grid gap-6 lg:grid-cols-2">
            <StatusPanel
              eyebrow="Available in beta"
              title="Discovery, coverage design, and rubric planning"
              items={[
                "Product and documentation intake",
                "Source-backed workflow and scenario discovery",
                "Risk-ranked configuration and persona matrices",
                "Structured rubric and evidence requirements",
                "Human review before active execution"
              ]}
            />
            <StatusPanel
              eyebrow="Required before GA"
              title="Safe, evidence-backed browser execution"
              items={[
                "Isolated, disposable browser workers",
                "Tenant-scoped credentials and test data",
                "Screenshots, traces, and reproducible evidence",
                "Independent result verification and confidence scoring",
                "Quotas, rate controls, retention, and audit trails"
              ]}
              muted
            />
          </div>
        </div>
      </section>

      <section id="why" className="border-t border-[var(--border)] py-20">
        <div className="container-narrow">
          <h2 className="text-3xl font-semibold tracking-tight">Designed for findings you can defend</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-2">
            <Point
              title="Coverage with provenance"
              body="Scenarios link back to supplied documentation or are labeled as inferred. That makes the plan auditable and gives product teams a clear review surface."
            />
            <Point
              title="Risk before volume"
              body="Coverage is ranked by customer impact, likelihood, recoverability, and trust risk. A meaningful test matrix matters more than a large cell count."
            />
            <Point
              title="Evidence before verdicts"
              body="A future browser run will not count as a pass without reproducible steps and captured evidence. Simulator output is never represented as real-user interaction."
            />
            <Point
              title="Safety by default"
              body="Staging is the default. Authorization, scope boundaries, secret handling, rate limits, and stop conditions are part of the campaign contract."
            />
          </div>
        </div>
      </section>

      <section className="border-t border-[var(--border)] py-20">
        <div className="container-narrow grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <div>
            <p className="text-sm uppercase tracking-widest text-accent">Prepare a high-quality run</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">Good testing starts with good context.</h2>
            <p className="mt-4 max-w-2xl leading-7 text-[var(--muted)]">
              Use our templates to document roles, workflows, settings, test accounts, seeded data, destructive actions, third-party dependencies, and success criteria. The clearer the input, the more useful and reviewable the matrix.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 lg:justify-end">
            <Link href="/resources" className="rounded-md bg-white px-5 py-3 font-medium text-black hover:bg-zinc-200">
              Open resources
            </Link>
            <Link href="/docs#limitations" className="rounded-md border border-[var(--border)] px-5 py-3 font-medium hover:bg-white/5">
              Review limitations
            </Link>
          </div>
        </div>
      </section>

      <PublicFooter />
    </main>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <article>
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full border border-accent text-sm text-accent">
        {n}
      </div>
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{body}</p>
    </article>
  );
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <article className="rounded-lg border border-[var(--border)] p-6">
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{body}</p>
    </article>
  );
}

function StatusPanel({
  eyebrow,
  title,
  items,
  muted = false
}: {
  eyebrow: string;
  title: string;
  items: readonly string[];
  muted?: boolean;
}) {
  return (
    <article className={`rounded-xl border p-7 ${muted ? "border-[var(--border)] bg-white/[0.02]" : "border-accent/40 bg-accent/10"}`}>
      <p className={`text-xs font-medium uppercase tracking-widest ${muted ? "text-[var(--muted)]" : "text-indigo-200"}`}>{eyebrow}</p>
      <h3 className="mt-3 text-xl font-medium">{title}</h3>
      <ul className="mt-5 space-y-3 text-sm text-[var(--muted)]">
        {items.map((item) => (
          <li key={item} className="flex gap-3">
            <span className="text-accent" aria-hidden="true">&#8226;</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
