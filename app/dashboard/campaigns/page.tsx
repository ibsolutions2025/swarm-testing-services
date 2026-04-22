import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase-server";
import { DashboardNav } from "@/components/DashboardNav";
import { CampaignStatus } from "@/components/CampaignStatus";
import { formatDate, truncate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const supabase = createServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard/campaigns");

  const { data, error } = await supabase
    .from("campaigns")
    .select("id, url, description, status, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  const tableMissing =
    error && (error.code === "PGRST205" || /does not exist/i.test(error.message ?? ""));

  const campaigns = (tableMissing ? [] : data) ?? [];

  return (
    <main className="min-h-screen">
      <DashboardNav />

      <section className="container-narrow py-16">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">Campaigns</h1>
          <Link
            href="/dashboard"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium hover:opacity-90"
          >
            New campaign
          </Link>
        </div>

        {tableMissing && (
          <div className="mt-6 rounded-md border border-amber-500/40 p-4 text-sm text-amber-300">
            The <code>campaigns</code> table is not provisioned yet. Run{" "}
            <code>supabase/migrations/0001_init.sql</code> in your Supabase SQL editor.
          </div>
        )}

        {!tableMissing && campaigns.length === 0 && (
          <div className="mt-12 rounded-md border border-[var(--border)] p-8 text-center text-[var(--muted)]">
            No campaigns yet. Launch your first one from the{" "}
            <Link href="/dashboard" className="text-accent hover:underline">
              New campaign
            </Link>{" "}
            tab.
          </div>
        )}

        {campaigns.length > 0 && (
          <ul className="mt-10 space-y-3">
            {campaigns.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/dashboard/campaigns/${c.id}`}
                  className="block rounded-md border border-[var(--border)] p-5 hover:bg-white/5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.url}</p>
                      <p className="mt-1 text-sm text-[var(--muted)]">
                        {truncate(c.description, 140)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <CampaignStatus status={c.status} />
                      <span className="text-xs text-[var(--muted)]">
                        {formatDate(c.created_at)}
                      </span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
