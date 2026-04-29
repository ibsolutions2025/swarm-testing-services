"use client";

import Link from "next/link";
import { useEffect, useState, useMemo } from "react";

type StepEvent = {
  step_id: string;
  status: "running" | "ok" | "fail";
  elapsed_ms: number | null;
  summary: string | null;
  cost_usd: number | null;
  emitted_at: string;
};

type RunRow = {
  run_id: string;
  url: string;
  status: "queued" | "running" | "complete" | "failed" | "greenlit" | "cancelled";
  current_step: string | null;
  slug: string | null;
  total_cost_usd: number | string | null;
  total_tokens_in: number | null;
  total_tokens_out: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type StatusResponse = {
  run: RunRow;
  events: StepEvent[];
};

const STEPS: Array<{ id: string; label: string }> = [
  { id: "01-validate-url", label: "Validate URL" },
  { id: "02-discover-manifest", label: "Discover manifest" },
  { id: "03-inventory-contracts", label: "Inventory contracts" },
  { id: "04-fetch-abis", label: "Fetch ABIs" },
  { id: "05-crawl-docs", label: "Crawl docs" },
  { id: "06-audit-mcp", label: "Audit MCP" },
  { id: "07-generate-rules", label: "Generate rules" },
  { id: "08-generate-events", label: "Generate events" },
  { id: "09-derive-matrix", label: "Derive matrix" },
  { id: "10-derive-scenarios", label: "Derive scenarios" },
  { id: "11-generate-cell-defs", label: "Generate cell defs" },
  { id: "12-write-audit-doc", label: "Write audit doc" },
];

const POLL_INTERVAL_MS = 3000;

function formatElapsed(ms: number | null) {
  if (!ms) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatCost(usd: number | string | null | undefined) {
  if (usd == null) return "$0.00";
  const n = typeof usd === "string" ? Number(usd) : usd;
  if (!isFinite(n)) return "$0.00";
  return `$${n.toFixed(4)}`;
}

export function OnboardingStepper({ runId }: { runId: string }) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const r = await fetch(`/api/onboarding/status?run_id=${encodeURIComponent(runId)}`);
        const j = (await r.json()) as StatusResponse | { error: string };
        if (cancelled) return;
        if (!r.ok) {
          setError("error" in j ? j.error : `status ${r.status}`);
        } else if ("run" in j) {
          setData(j);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (cancelled) return;
        const terminal = data?.run.status === "complete" || data?.run.status === "failed";
        if (!terminal) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, data?.run?.status]);

  // Build a step_id → latest event map. Multiple events per step (running
  // then ok/fail) are possible; pick the most recent.
  const eventByStep = useMemo(() => {
    const map = new Map<string, StepEvent>();
    if (!data) return map;
    for (const e of data.events) map.set(e.step_id, e);
    return map;
  }, [data]);

  const run = data?.run;
  const status = run?.status ?? "queued";

  return (
    <div>
      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-[var(--muted)]">Onboarding run</div>
          <h1 className="mt-1 font-mono text-lg text-zinc-100">{runId}</h1>
          {run && (
            <div className="mt-1 text-sm text-[var(--muted)]">
              <span className="font-mono">{run.url}</span>
              {run.slug && (
                <>
                  {" · "}
                  <span>slug: <code className="text-zinc-300">{run.slug}</code></span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusPill status={status} />
          {run && (
            <div className="text-xs text-[var(--muted)]">
              cost: <span className="text-zinc-100">{formatCost(run.total_cost_usd)}</span>
              {(run.total_tokens_in || run.total_tokens_out) && (
                <span className="ml-2">
                  · {run.total_tokens_in ?? 0} in / {run.total_tokens_out ?? 0} out
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      {error && <div className="mt-4 rounded-md border border-red-900 bg-red-950/30 p-3 text-sm text-red-300">poll error: {error}</div>}

      <ol className="mt-6 space-y-2">
        {STEPS.map((s, i) => {
          const evt = eventByStep.get(s.id);
          let badge: "pending" | "running" | "ok" | "fail" = "pending";
          if (evt) badge = evt.status;
          else if (run?.current_step === s.id && (status === "running" || status === "queued")) badge = "running";
          return (
            <li
              key={s.id}
              className="flex items-start gap-3 rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2"
            >
              <StepBadge n={i + 1} state={badge} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-100">{s.label}</span>
                  <span className="font-mono text-xs text-[var(--muted)]">{s.id}</span>
                </div>
                {evt?.summary && (
                  <div className="mt-0.5 text-sm text-[var(--muted)]">{evt.summary}</div>
                )}
              </div>
              <div className="flex flex-col items-end text-xs text-[var(--muted)]">
                {evt?.elapsed_ms != null && <span>{formatElapsed(evt.elapsed_ms)}</span>}
                {evt?.cost_usd != null && Number(evt.cost_usd) > 0 && (
                  <span className="font-mono">{formatCost(evt.cost_usd)}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {(status === "complete" || status === "greenlit") && (
        <div className="mt-6 rounded-md border border-emerald-900 bg-emerald-950/30 p-4 text-sm text-emerald-200">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              Engine complete. Total cost: {formatCost(run?.total_cost_usd)}.
              {run?.slug && <> Slug: <code className="text-emerald-100">{run.slug}</code>.</>}
            </div>
            <Link
              href={`/hire/runs/${runId}/edit`}
              className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-black hover:bg-emerald-500"
            >
              Edit matrix / scenarios →
            </Link>
          </div>
        </div>
      )}
      {status === "failed" && (
        <div className="mt-6 rounded-md border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
          Engine failed{run?.current_step ? ` at ${run.current_step}` : ""}.
          {run?.error && <div className="mt-1 font-mono text-xs">{run.error}</div>}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: RunRow["status"] }) {
  const map: Record<RunRow["status"], { bg: string; fg: string; label: string }> = {
    queued:    { bg: "bg-zinc-800",     fg: "text-zinc-300",    label: "queued" },
    running:   { bg: "bg-amber-950/60", fg: "text-amber-200",   label: "running" },
    complete:  { bg: "bg-emerald-950/60", fg: "text-emerald-200", label: "complete" },
    failed:    { bg: "bg-red-950/60",   fg: "text-red-300",     label: "failed" },
    greenlit:  { bg: "bg-blue-950/60",  fg: "text-blue-200",    label: "greenlit" },
    cancelled: { bg: "bg-zinc-800",     fg: "text-zinc-400",    label: "cancelled" },
  };
  const m = map[status] ?? map.queued;
  return (
    <span className={`rounded-full px-3 py-0.5 text-xs font-medium ${m.bg} ${m.fg}`}>
      {m.label}
    </span>
  );
}

function StepBadge({ n, state }: { n: number; state: "pending" | "running" | "ok" | "fail" }) {
  const styles: Record<typeof state, string> = {
    pending: "bg-zinc-900 text-zinc-500 border-zinc-800",
    running: "bg-amber-950/60 text-amber-200 border-amber-800 animate-pulse",
    ok:      "bg-emerald-950/60 text-emerald-200 border-emerald-800",
    fail:    "bg-red-950/60 text-red-300 border-red-800",
  };
  return (
    <span
      className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${styles[state]}`}
      aria-label={state}
    >
      {state === "ok" ? "✓" : state === "fail" ? "✗" : n}
    </span>
  );
}
