import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="min-h-screen">
      {/* Top nav */}
      <header className="border-b border-[var(--border)]">
        <div className="container-narrow flex items-center justify-between py-5">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-accent" />
            <span className="font-semibold tracking-tight">Swarm Testing</span>
          </div>
          <nav className="flex items-center gap-6 text-sm text-[var(--muted)]">
            <Link href="#how-it-works" className="hover:text-white">How it works</Link>
            <Link href="/pricing" className="hover:text-white">Pricing</Link>
            <Link href="/case-studies/awp" className="hover:text-white">Case study</Link>
            <Link
              href="/login"
              className="rounded-md bg-accent px-4 py-2 text-white hover:opacity-90"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="container-narrow py-24">
        <p className="mb-4 text-sm uppercase tracking-widest text-accent">
          Agentic product testing
        </p>
        <h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight md:text-6xl">
          Stress-test your product with an autonomous swarm.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-[var(--muted)]">
          Point us at a URL. Describe what you want validated. We'll spin up a
          matrix of agentic personas, run them through every scenario that
          matters, and return a human-readable report on what's broken, what's
          slow, and what confuses real users — before your real users find out.
        </p>
        <div className="mt-10 flex gap-3">
          <Link
            href="/login"
            className="rounded-md bg-accent px-6 py-3 font-medium hover:opacity-90"
          >
            Start a test campaign
          </Link>
          <Link
            href="#how-it-works"
            className="rounded-md border border-[var(--border)] px-6 py-3 font-medium hover:bg-white/5"
          >
            See how it works
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="border-t border-[var(--border)] py-20">
        <div className="container-narrow">
          <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            <Step
              n={1}
              title="Paste a URL, describe a test"
              body="Give us your product URL and a plain-English description of what you want the swarm to test — onboarding friction, checkout drop-off, edge cases, pricing confusion, whatever matters."
            />
            <Step
              n={2}
              title="We design the matrix"
              body="We auto-generate a grid: rows are product/service configurations, columns are agentic user scenarios. Then we build the personas and their knowledge files — biased toward real users, not synthetic ones."
            />
            <Step
              n={3}
              title="The swarm runs, you get a report"
              body="A zero-bias orchestrator walks the swarm through every cell. You see pass/fail, where they struggled, direct quotes from the agents, and one prioritized list of fixes."
            />
          </div>
        </div>
      </section>

      {/* Why swarms */}
      <section id="why" className="border-t border-[var(--border)] py-20">
        <div className="container-narrow">
          <h2 className="text-3xl font-semibold tracking-tight">
            Why a swarm beats a test suite
          </h2>
          <div className="mt-10 grid gap-8 md:grid-cols-2">
            <Point
              title="Real-world bias, not synthetic coverage"
              body="Unit tests check what you thought to check. Swarms reveal what you didn't — because every persona has its own goals, biases, and frustrations."
            />
            <Point
              title="Full coverage without authoring every case"
              body="We generate the matrix from your description. Hundreds of (config × scenario) cells, each run by the right persona, without you writing a single Cypress spec."
            />
            <Point
              title="Human-readable results"
              body="Every failure comes with a quote: 'I tried to sign up but the email field rejected my plus-address.' You get stories, not stack traces."
            />
            <Point
              title="Re-run on every deploy"
              body="Schedule the swarm against staging. Catch regressions before they ship — without paying a QA team to re-click the same buttons."
            />
          </div>
        </div>
      </section>

      {/* Clients */}
      <section id="clients" className="border-t border-[var(--border)] py-20">
        <div className="container-narrow">
          <h2 className="text-3xl font-semibold tracking-tight">Who's using it</h2>
          <p className="mt-4 text-[var(--muted)]">
            Swarm Testing Services is in private beta. Our first client is{" "}
            <span className="text-white">AgentWork Protocol</span> — an on-chain
            marketplace for autonomous agents, where every posted job goes
            through 7 agentic personas before users ever touch it.
          </p>
          <div className="mt-8 rounded-lg border border-[var(--border)] p-6">
            <p className="text-sm uppercase tracking-widest text-accent">
              Case study — AgentWork Protocol
            </p>
            <p className="mt-2 text-xl">
              736 (config × scenario) cells. 7 personas. Ran every 10 minutes on
              a VPS. Caught five classes of production-visible failures that
              unit tests never would have.
            </p>
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--border)] py-12">
        <div className="container-narrow flex items-center justify-between text-sm text-[var(--muted)]">
          <div>© {new Date().getFullYear()} Swarm Testing Services</div>
          <div className="flex gap-6">
            <Link href="#">Terms</Link>
            <Link href="#">Privacy</Link>
            <Link href="mailto:hello@swarm-testing.dev">Contact</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div>
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full border border-accent text-sm text-accent">
        {n}
      </div>
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-2 text-sm text-[var(--muted)]">{body}</p>
    </div>
  );
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] p-6">
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-2 text-sm text-[var(--muted)]">{body}</p>
    </div>
  );
}
