"use client";

import { useState } from "react";
import type { Scenario } from "@/lib/onboarding-patches";

type Props = {
  scenarios: Scenario[];
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
};

const STATUS_CHOICES: Scenario["status"][] = ["classifiable", "aspirational", "deferred"];

export function ScenarioCardEditor({ scenarios, onPatch }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Scenario["status"]>("all");

  const filtered = filter === "all" ? scenarios : scenarios.filter((s) => s.status === filter);

  async function emit(label: string, patch: Record<string, unknown>) {
    setBusy(label);
    try { await onPatch(patch); } finally { setBusy(null); }
  }

  async function setStatus(scenario: Scenario, status: Scenario["status"]) {
    if (status === scenario.status) return;
    await emit(`status:${scenario.id}`, {
      op: "edit_scenario",
      scenarioId: scenario.id,
      fields: { status },
    });
  }

  async function setApplicability(scenario: Scenario, applicability: string) {
    if (applicability === scenario.applicability) return;
    await emit(`appl:${scenario.id}`, {
      op: "edit_scenario",
      scenarioId: scenario.id,
      fields: { applicability },
    });
  }

  async function setDescription(scenario: Scenario, description: string) {
    if (description === scenario.description) return;
    await emit(`desc:${scenario.id}`, {
      op: "edit_scenario",
      scenarioId: scenario.id,
      fields: { description },
    });
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Scenarios</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {scenarios.length} scenarios.{" "}
            {scenarios.filter((s) => s.status === "classifiable").length} classifiable,{" "}
            {scenarios.filter((s) => s.status === "aspirational").length} aspirational,{" "}
            {scenarios.filter((s) => s.status === "deferred").length} deferred.
          </p>
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          className="rounded-md border border-zinc-800 bg-black px-2 py-1 text-sm text-zinc-100"
        >
          <option value="all">All</option>
          <option value="classifiable">Classifiable</option>
          <option value="aspirational">Aspirational</option>
          <option value="deferred">Deferred</option>
        </select>
      </header>

      <div className="grid gap-3">
        {filtered.length === 0 && (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-[var(--muted)]">
            No scenarios match the filter.
          </div>
        )}
        {filtered.map((scenario) => (
          <div key={scenario.id} className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-baseline gap-2">
              <h3 className="font-mono text-sm text-zinc-100">{scenario.id}</h3>
              <span className="text-sm text-[var(--muted)]">— {scenario.label}</span>
            </div>

            <div className="mt-2 flex gap-1">
              {STATUS_CHOICES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(scenario, s)}
                  disabled={busy === `status:${scenario.id}`}
                  className={
                    "rounded-full px-3 py-0.5 text-xs " +
                    (scenario.status === s
                      ? s === "classifiable"
                        ? "bg-emerald-950/60 text-emerald-200"
                        : s === "aspirational"
                          ? "bg-amber-950/60 text-amber-200"
                          : "bg-zinc-800 text-zinc-300"
                      : "border border-zinc-800 text-[var(--muted)] hover:bg-white/5") +
                    (busy === `status:${scenario.id}` ? " opacity-60" : "")
                  }
                >
                  {s}
                </button>
              ))}
            </div>

            <label className="mt-3 block">
              <span className="text-xs text-[var(--muted)]">Description</span>
              <textarea
                rows={2}
                defaultValue={scenario.description}
                onBlur={(e) => setDescription(scenario, e.target.value)}
                disabled={busy === `desc:${scenario.id}`}
                className="mt-1 w-full rounded-md border border-zinc-800 bg-black px-2 py-1 text-sm text-zinc-100 disabled:opacity-50"
              />
            </label>

            <label className="mt-2 block">
              <span className="text-xs text-[var(--muted)]">Applicability filter</span>
              <input
                type="text"
                defaultValue={scenario.applicability}
                onBlur={(e) => setApplicability(scenario, e.target.value)}
                disabled={busy === `appl:${scenario.id}`}
                placeholder='e.g. "validationMode != HARD_ONLY" or "any"'
                className="mt-1 w-full rounded-md border border-zinc-800 bg-black px-2 py-1 font-mono text-xs text-zinc-100 disabled:opacity-50"
              />
            </label>

            {scenario.notes && (
              <p className="mt-2 text-xs text-[var(--muted)] italic">notes: {scenario.notes}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
