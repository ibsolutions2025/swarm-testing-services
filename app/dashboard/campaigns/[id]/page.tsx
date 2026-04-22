import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabase-server";
import { DashboardNav } from "@/components/DashboardNav";
import { CampaignStatus } from "@/components/CampaignStatus";
import { ScenarioMatrix } from "@/components/ScenarioMatrix";
import { PersonaCard } from "@/components/PersonaCard";
import { formatDate } from "@/lib/format";
import type { Matrix, Persona, Run } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({
  params
}: {
  params: { id: string };
}) {
  const supabase = createServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/dashboard/campaigns/${params.id}`);

  const [
    { data: campaign },
    { data: matrix },
    { data: personas },
    { data: runs }
  ] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, url, description, status, error, created_at, updated_at")
      .eq("id", params.id)
      .maybeSingle(),
    supabase
      .from("matrices")
      .select("id, campaign_id, rows, columns, created_at")
      .eq("campaign_id", params.id)
      .maybeSingle(),
    supabase
      .from("personas")
      .select("id, campaign_id, matrix_row_id, name, archetype, goals, biases, soul_md, created_at")
      .eq("campaign_id", params.id),
    supabase
      .from("runs")
      .select(
        "id, campaign_id, matrix_row_id, matrix_column_id, persona_id, outcome, transcript, quote, duration_ms, created_at"
      )
      .eq("campaign_id", params.id)
  ]);

  if (!campaign) notFound();

  const matrixTyped = matrix as Matrix | null;
  const personasTyped = (personas ?? []) as Persona[];
  const runsTyped = (runs ?? []) as Run[];

  const summary = {
    total: runsTyped.length,
    passed: runsTyped.filter((r) => r.outcome === "pass").length,
    failed: runsTyped.filter((r) => r.outcome === "fail").length,
    partial: runsTyped.filter((r) => r.outcome === "partial").length,
    error: runsTyped.filter((r) => r.outcome === "error").length
  };

  return (
    <main className="min-h-screen">
      <DashboardNav />

      <section className="container-narrow py-12">
        <Link
          href="/dashboard/campaigns"
          className="text-sm text-[var(--muted)] hover:text-white"
        >
          ← Campaigns
        </Link>

        <div className="mt-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {campaign.url}
            </h1>
            <p className="mt-2 text-[var(--muted)]">{campaign.description}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <CampaignStatus status={campaign.status} />
            <span className="text-xs text-[var(--muted)]">
              Started {formatDate(campaign.created_at)}
            </span>
          </div>
        </div>

        {campaign.error && (
          <div className="mt-6 rounded-md border border-red-500/40 p-4 text-sm text-red-300">
            <p className="font-medium">Campaign failed</p>
            <p className="mt-1">{campaign.error}</p>
          </div>
        )}

        {/* Summary */}
        {runsTyped.length > 0 && (
          <div className="mt-10 grid grid-cols-5 gap-3">
            <SummaryCard label="Total" value={summary.total} />
            <SummaryCard
              label="Passed"
              value={summary.passed}
              color="text-emerald-300"
            />
            <SummaryCard
              label="Failed"
              value={summary.failed}
              color="text-red-300"
            />
            <SummaryCard
              label="Partial"
              value={summary.partial}
              color="text-amber-300"
            />
            <SummaryCard
              label="Errors"
              value={summary.error}
              color="text-fuchsia-300"
            />
          </div>
        )}

        {/* Matrix */}
        {matrixTyped && matrixTyped.rows.length > 0 && (
          <div className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight">Matrix</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Rows are product configurations. Columns are agentic scenarios.
              Click a cell to see the transcript.
            </p>
            <div className="mt-6">
              <ScenarioMatrix matrix={matrixTyped} runs={runsTyped} />
            </div>
          </div>
        )}

        {/* Personas */}
        {personasTyped.length > 0 && (
          <div className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight">Personas</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              One persona per configuration row.
            </p>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {personasTyped.map((p) => (
                <PersonaCard key={p.id} persona={p} />
              ))}
            </div>
          </div>
        )}

        {/* Empty state while orchestrator is still building */}
        {!matrixTyped && (
          <div className="mt-12 rounded-md border border-[var(--border)] p-8 text-center text-[var(--muted)]">
            {campaign.status === "queued" || campaign.status === "designing"
              ? "Matrix is being designed — check back in a few minutes."
              : "No matrix yet."}
          </div>
        )}
      </section>
    </main>
  );
}

function SummaryCard({
  label,
  value,
  color
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="rounded-md border border-[var(--border)] p-4">
      <p className="text-xs uppercase tracking-widest text-[var(--muted)]">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold ${color ?? ""}`}>{value}</p>
    </div>
  );
}
