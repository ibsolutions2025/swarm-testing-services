"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs: { href: string; label: string }[] = [
  { href: "/dashboard", label: "New campaign" },
  { href: "/dashboard/campaigns", label: "Campaigns" },
  { href: "/dashboard/personas", label: "Personas" }
];

export function DashboardNav() {
  const pathname = usePathname() ?? "";
  return (
    <header className="border-b border-[var(--border)]">
      <div className="container-narrow flex items-center justify-between py-5">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-6 w-6 rounded bg-accent" />
          <span className="font-semibold tracking-tight">Swarm Testing</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm text-[var(--muted)]">
          {tabs.map((t) => {
            const active =
              t.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={active ? "text-white" : "hover:text-white"}
              >
                {t.label}
              </Link>
            );
          })}
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] px-3 py-1 text-xs hover:bg-white/5"
            >
              Sign out
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}
