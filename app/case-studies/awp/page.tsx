import Link from "next/link";

export default function AwpCaseStudyPage() {
  return (
    <main className="min-h-screen">
      <header className="border-b border-[var(--border)]">
        <div className="container-narrow flex items-center justify-between py-5">
          <Link href="/" className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-accent" />
            <span className="font-semibold tracking-tight">Swarm Testing</span>
          </Link>
          <nav className="flex items-center gap-6 text-sm text-[var(--muted)]">
            <Link href="/" className="hover:text-white">Home</Link>
            <Link href="/pricing" className="hover:text-white">Pricing</Link>
            <Link href="/case-studies/awp" className="text-white">Case study</Link>
            <Link
              href="/login"
              className="rounded-md bg-accent px-4 py-2 text-white hover:opacity-90"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <section className="container-narrow py-20">
        <p className="text-sm uppercase tracking-widest text-accent">
          Case study
        </p>
        <h1 className="mt-3 max-w-3xl text-5xl font-semibold leading-tight tracking-tight">
          AgentWork Protocol — stress-testing an on-chain agent marketplace.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-[var(--muted)]">
          AgentWork Protocol (AWP) is an on-chain marketplace where autonomous
          agents post jobs, submit work, and review each other's submissions.
          We ran Swarm Testing Services against AWP for four weeks before
          launch to surface production-visible failures that unit tests
          missed entirely.
        </p>

        <div className="mt-12 grid gap-6 md:grid-cols-4">
          <Stat label="Matrix cells" value="736" />
          <Stat label="Personas" value="7" />
          <Stat label="Failure classes found" value="5" />
          <Stat label="Dispatch cadence" value="every 10 min" />
        </div>

        <div className="mt-16 space-y-10">
          <Section title="The challenge">
            <p>
              AWP's job lifecycle involves multiple agents interacting across
              contracts, indexers, and off-chain validators. Unit tests
              covered individual contract calls but couldn't reveal what
              happened when a full swarm of autonomous agents tried to
              actually use the marketplace at the same time.
            </p>
            <p>
              The team also needed confidence that new-user onboarding worked
              for realistic agent personas — not just the cherry-picked
              scripted flows a deterministic test suite could cover.
            </p>
          </Section>

          <Section title="What the swarm found">
            <List
              items={[
                "Review-gate deadlocks — jobs silently stuck in review when pending queues capped out. Caught on the 2nd run.",
                "Config alias drift — a contract address alias was deleted but callers still referenced it; on-chain writes silently no-opped.",
                "Deployer wallet exhausted — jobs queued but never posted once gas dropped below threshold; no alert fired.",
                "Persona prompt bias — one scenario never failed because the prompt quietly told the agent what to do. The swarm's zero-bias orchestrator exposed the leak.",
                "Indexer skip on fresh job IDs — after a contract redeploy, job IDs below a filter threshold were silently dropped."
              ]}
            />
          </Section>

          <Section title="How it ran">
            <p>
              A 5-row × 6-column matrix (plus cross-product variants totalling
              736 cells) ran via a VPS cron every ten minutes. Each cell was
              assigned to one of seven personas — each with its own goals,
              biases, and SOUL file — and the zero-bias orchestrator walked
              them through the scenario without any scripted hand-holding.
            </p>
            <p>
              Results streamed back into a matrix heatmap the team monitored
              in the dashboard. Every failure came with a transcript and a
              one-line quote from the persona — a story, not a stack trace.
            </p>
          </Section>

          <Section title="Outcome">
            <p>
              Five classes of production-visible failures were caught before
              real users ever touched AWP. Every subsequent contract redeploy
              now kicks off an automatic swarm run; the pipeline has
              prevented at least three regressions from shipping to
              mainnet-adjacent environments.
            </p>
          </Section>
        </div>

        <div className="mt-16 rounded-lg border border-accent bg-accent/5 p-8">
          <h2 className="text-2xl font-semibold tracking-tight">
            Want the same confidence before your next launch?
          </h2>
          <p className="mt-2 text-[var(--muted)]">
            Paste a URL, describe what you want tested, and let the swarm do
            the rest.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block rounded-md bg-accent px-6 py-3 font-medium hover:opacity-90"
          >
            Start a trial campaign
          </Link>
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] p-5">
      <p className="text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-xs uppercase tracking-widest text-[var(--muted)]">
        {label}
      </p>
    </div>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4 space-y-4 text-[var(--muted)]">{children}</div>
    </div>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span>{i}</span>
        </li>
      ))}
    </ul>
  );
}
