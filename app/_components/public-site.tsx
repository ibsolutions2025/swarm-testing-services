import Link from "next/link";

const primaryLinks = [
  { href: "/docs", label: "Docs" },
  { href: "/resources", label: "Resources" },
  { href: "/pricing", label: "Pricing" },
  { href: "/case-studies/awp", label: "Case study" }
] as const;

export function PublicHeader() {
  return (
    <header className="border-b border-[var(--border)]">
      <div className="container-narrow flex flex-wrap items-center justify-between gap-4 py-5">
        <Link href="/" className="flex items-center gap-2" aria-label="Swarm Testing Services home">
          <span className="h-6 w-6 rounded bg-accent" aria-hidden="true" />
          <span className="font-semibold tracking-tight">Swarm Testing</span>
        </Link>
        <nav aria-label="Primary navigation" className="flex flex-wrap items-center justify-end gap-x-5 gap-y-3 text-sm text-[var(--muted)]">
          {primaryLinks.map((link) => (
            <Link key={link.href} href={link.href} className="transition-colors hover:text-white">
              {link.label}
            </Link>
          ))}
          <Link
            href="/login"
            className="rounded-md bg-accent px-4 py-2 text-white transition-opacity hover:opacity-90"
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-[var(--border)] py-12">
      <div className="container-narrow flex flex-col justify-between gap-6 text-sm text-[var(--muted)] sm:flex-row sm:items-center">
        <div>&copy; {new Date().getFullYear()} Swarm Testing Services</div>
        <nav aria-label="Footer navigation" className="flex flex-wrap gap-x-6 gap-y-3">
          <Link href="/docs" className="hover:text-white">Docs</Link>
          <Link href="/resources" className="hover:text-white">Resources</Link>
          <Link href="/terms" className="hover:text-white">Terms</Link>
          <Link href="/privacy" className="hover:text-white">Privacy</Link>
          <Link href="mailto:hello@swarm-testing.dev" className="hover:text-white">Contact</Link>
        </nav>
      </div>
    </footer>
  );
}
