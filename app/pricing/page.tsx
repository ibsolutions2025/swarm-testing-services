import Link from "next/link";

const tiers = [
  {
    name: "Trial",
    price: "$0",
    cadence: "forever",
    tagline: "Run a swarm against one product and see what breaks.",
    features: [
      "1 campaign / month",
      "Up to 3 personas",
      "Up to 10 scenarios",
      "Human-readable report",
      "Email support"
    ],
    cta: "Start free",
    href: "/login",
    highlight: false
  },
  {
    name: "Indie",
    price: "$99",
    cadence: "per month",
    tagline: "Solo founders and small teams who ship weekly.",
    features: [
      "10 campaigns / month",
      "Up to 5 personas per campaign",
      "Up to 30 scenarios per campaign",
      "Slack + email support",
      "Scheduled re-runs"
    ],
    cta: "Start Indie",
    href: "/login",
    highlight: true
  },
  {
    name: "Team",
    price: "$499",
    cadence: "per month",
    tagline: "Product and engineering teams shipping to production.",
    features: [
      "50 campaigns / month",
      "Up to 10 personas per campaign",
      "Up to 100 scenarios per campaign",
      "CI webhook trigger",
      "Regression diffs against last run",
      "Priority support"
    ],
    cta: "Start Team",
    href: "/login",
    highlight: false
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "annual",
    tagline: "Compliance, SSO, volume commitments, dedicated orchestrator.",
    features: [
      "Unlimited campaigns",
      "Unlimited personas & scenarios",
      "SSO / SCIM",
      "Private orchestrator instance",
      "SLA + named CSM"
    ],
    cta: "Contact sales",
    href: "mailto:hello@swarm-testing.dev?subject=Enterprise%20inquiry",
    highlight: false
  }
];

export default function PricingPage() {
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
            <Link href="/pricing" className="text-white">Pricing</Link>
            <Link href="/case-studies/awp" className="hover:text-white">
              Case study
            </Link>
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
        <div className="max-w-2xl">
          <p className="text-sm uppercase tracking-widest text-accent">Pricing</p>
          <h1 className="mt-3 text-5xl font-semibold tracking-tight">
            Pay for campaigns, not per agent run.
          </h1>
          <p className="mt-4 text-lg text-[var(--muted)]">
            Every plan includes unlimited seats. Campaign-level billing keeps
            the math simple.
          </p>
        </div>

        <div className="mt-16 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`flex flex-col rounded-lg border p-6 ${
                t.highlight
                  ? "border-accent bg-accent/5"
                  : "border-[var(--border)]"
              }`}
            >
              <h2 className="text-lg font-semibold">{t.name}</h2>
              <p className="mt-4 text-3xl font-semibold">{t.price}</p>
              <p className="text-sm text-[var(--muted)]">{t.cadence}</p>
              <p className="mt-4 text-sm text-[var(--muted)]">{t.tagline}</p>
              <ul className="mt-6 space-y-2 text-sm">
                {t.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-accent">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <div className="flex-1" />
              <Link
                href={t.href}
                className={`mt-8 rounded-md px-4 py-2 text-center text-sm font-medium ${
                  t.highlight
                    ? "bg-accent text-white hover:opacity-90"
                    : "border border-[var(--border)] hover:bg-white/5"
                }`}
              >
                {t.cta}
              </Link>
            </div>
          ))}
        </div>

        <p className="mt-12 text-center text-xs text-[var(--muted)]">
          Pricing is provisional — we're in private beta. Trial is live; paid
          tiers bill once Stripe is wired.
        </p>
      </section>
    </main>
  );
}
