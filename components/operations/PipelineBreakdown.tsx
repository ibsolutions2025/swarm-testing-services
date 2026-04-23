"use client";

import { RUN_OUTCOME_COLORS } from "@/lib/constants";
import { driverForStep, type Driver } from "@/lib/operations";
import type { LifecycleResult } from "@/lib/lifecycle-types";

export function PipelineBreakdown({ results }: { results: LifecycleResult[] }) {
  const total = results.length;

  // By driver — use each row's latest step + its created_at to attribute.
  const driverCounts: Record<Driver, number> = { AGENT: 0, SCRIPT: 0 };
  for (const r of results) {
    const lastStep = r.steps?.[r.steps.length - 1];
    const d = driverForStep(lastStep, r.created_at ?? r.started_at);
    driverCounts[d]++;
  }

  // By status.
  const statusCounts: Record<string, number> = {};
  for (const r of results) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }

  if (total === 0) {
    return (
      <div className="rounded-md border border-[var(--border)] p-6 text-center text-xs text-[var(--muted)]">
        No lifecycle rows yet to break down.
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-md border border-[var(--border)] bg-zinc-900/20 p-4">
      <Row
        title="By driver"
        segments={[
          {
            key: "AGENT",
            count: driverCounts.AGENT,
            color: "bg-emerald-500/50",
            border: "border-emerald-400/40"
          },
          {
            key: "SCRIPT",
            count: driverCounts.SCRIPT,
            color: "bg-blue-500/50",
            border: "border-blue-400/40"
          }
        ]}
        total={total}
      />
      <Row
        title="By status"
        segments={Object.entries(statusCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([status, count]) => ({
            key: status,
            count,
            color: RUN_OUTCOME_COLORS[status] ?? "bg-zinc-500/40",
            border: ""
          }))}
        total={total}
      />
    </div>
  );
}

function Row({
  title,
  segments,
  total
}: {
  title: string;
  segments: Array<{ key: string; count: number; color: string; border: string }>;
  total: number;
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-widest text-zinc-500">
        {title}
      </div>
      <div className="flex h-7 w-full overflow-hidden rounded border border-[var(--border)]">
        {segments
          .filter((s) => s.count > 0)
          .map((s, i, arr) => {
            const pct = (s.count / total) * 100;
            const label = `${s.key} ${s.count} (${pct.toFixed(0)}%)`;
            return (
              <div
                key={s.key}
                title={label}
                style={{ flexBasis: `${pct}%` }}
                className={`${s.color} flex items-center justify-start overflow-hidden px-2 text-[11px] font-medium text-zinc-100 ${
                  i < arr.length - 1 ? "border-r border-white/10" : ""
                }`}
              >
                <span className="truncate">{label}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
}
