"use client";

import { useState } from "react";
import { ScenarioMatrix } from "./ScenarioMatrix";
import { PersonaCard } from "./PersonaCard";
import { RUN_OUTCOME_COLORS } from "@/lib/constants";
import { formatDate, formatDuration, truncate } from "@/lib/format";
import type { Matrix, Persona, Run } from "@/lib/types";

type TabKey = "matrix" | "personas" | "transactions";

interface Props {
  matrix: Matrix | null;
  personas: Persona[];
  runs: Run[];
  status: string;
}

/**
 * Standard project layout used for every project on Swarm Testing Services.
 * Three tabs — Matrix / Personas / Transactions — matching the AWP /testing
 * page that this product was spun out of.
 */
export function ProjectTabs({ matrix, personas, runs, status }: Props) {
  const [active, setActive] = useState<TabKey>("matrix");

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    {
      key: "matrix",
      label: "Matrix",
      count: matrix ? matrix.rows.length * matrix.columns.length : 0
    },
    { key: "personas", label: "Personas", count: personas.length },
    { key: "transactions", label: "Transactions", count: runs.length }
  ];

  return (
    <div>
      <div className="flex items-center gap-1 border-b border-[var(--border)]">
        {tabs.map((t) => {
          const isActive = active === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              className={`relative px-4 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? "text-white"
                  : "text-[var(--muted)] hover:text-white"
              }`}
            >
              {t.label}
              {typeof t.count === "number" && (
                <span className="ml-2 rounded-full bg-white/10 px-2 py-0.5 text-xs text-[var(--muted)]">
                  {t.count}
                </span>
              )}
              {isActive && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 bg-accent" />
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-8">
        {active === "matrix" && (
          <MatrixTab matrix={matrix} runs={runs} status={status} />
        )}
        {active === "personas" && <PersonasTab personas={personas} />}
        {active === "transactions" && (
          <TransactionsTab runs={runs} matrix={matrix} personas={personas} />
        )}
      </div>
    </div>
  );
}

function MatrixTab({
  matrix,
  runs,
  status
}: {
  matrix: Matrix | null;
  runs: Run[];
  status: string;
}) {
  if (!matrix || matrix.rows.length === 0) {
    return (
      <div className="rounded-md border border-[var(--border)] p-8 text-center text-[var(--muted)]">
        {status === "queued" || status === "designing"
          ? "Matrix is being designed — check back in a few minutes."
          : "No matrix yet."}
      </div>
    );
  }
  return (
    <div>
      <p className="text-sm text-[var(--muted)]">
        Rows are product configurations. Columns are agentic scenarios. Click
        a cell to see its transcript.
      </p>
      <div className="mt-6">
        <ScenarioMatrix matrix={matrix} runs={runs} />
      </div>
    </div>
  );
}

function PersonasTab({ personas }: { personas: Persona[] }) {
  if (personas.length === 0) {
    return (
      <div className="rounded-md border border-[var(--border)] p-8 text-center text-[var(--muted)]">
        No personas yet. They're generated after the matrix is designed.
      </div>
    );
  }
  return (
    <div>
      <p className="text-sm text-[var(--muted)]">
        One persona per configuration row. Each has goals, biases, and a full
        SOUL that shapes how it interacts with your product.
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {personas.map((p) => (
          <PersonaCard key={p.id} persona={p} />
        ))}
      </div>
    </div>
  );
}

function TransactionsTab({
  runs,
  matrix,
  personas
}: {
  runs: Run[];
  matrix: Matrix | null;
  personas: Persona[];
}) {
  const [selected, setSelected] = useState<Run | null>(null);

  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-[var(--border)] p-8 text-center text-[var(--muted)]">
        No transactions yet. Each cell of the matrix produces one transaction
        when the swarm runs.
      </div>
    );
  }

  const rowLabel = (id: string) =>
    matrix?.rows.find((r) => r.id === id)?.label ?? id;
  const colLabel = (id: string) =>
    matrix?.columns.find((c) => c.id === id)?.label ?? id;
  const personaName = (id: string | null | undefined) =>
    id ? personas.find((p) => p.id === id)?.name ?? "—" : "—";

  const sorted = [...runs].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <div>
      <p className="text-sm text-[var(--muted)]">
        Every row is one swarm run against one (configuration × scenario) cell.
        Click a row to inspect the full transcript.
      </p>

      <div className="mt-6 overflow-x-auto rounded-md border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-white/5 text-xs uppercase tracking-widest text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Outcome</th>
              <th className="px-4 py-3 text-left font-medium">Cell</th>
              <th className="px-4 py-3 text-left font-medium">Persona</th>
              <th className="px-4 py-3 text-left font-medium">Quote</th>
              <th className="px-4 py-3 text-right font-medium">Duration</th>
              <th className="px-4 py-3 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((run) => {
              const isOpen = selected?.id === run.id;
              return (
                <tr
                  key={run.id}
                  onClick={() => setSelected(isOpen ? null : run)}
                  className={`cursor-pointer border-t border-[var(--border)] transition-colors ${
                    isOpen ? "bg-white/5" : "hover:bg-white/5"
                  }`}
                >
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs ${
                        RUN_OUTCOME_COLORS[run.outcome] ?? ""
                      }`}
                    >
                      {run.outcome}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    <span className="text-white">
                      {rowLabel(run.matrix_row_id)}
                    </span>{" "}
                    × {colLabel(run.matrix_column_id)}
                  </td>
                  <td className="px-4 py-3">{personaName(run.persona_id)}</td>
                  <td className="px-4 py-3 italic text-[var(--muted)]">
                    {run.quote ? `"${truncate(run.quote, 80)}"` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--muted)]">
                    {formatDuration(run.duration_ms)}
                  </td>
                  <td className="px-4 py-3 text-right text-[var(--muted)]">
                    {formatDate(run.created_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="mt-6 rounded-md border border-[var(--border)] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-accent">
                Transaction detail
              </p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {rowLabel(selected.matrix_row_id)} ×{" "}
                {colLabel(selected.matrix_column_id)} —{" "}
                {personaName(selected.persona_id)}
              </p>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-xs text-[var(--muted)] hover:text-white"
            >
              Close
            </button>
          </div>

          {selected.quote && (
            <blockquote className="mt-4 border-l-2 border-accent pl-4 italic text-[var(--muted)]">
              "{selected.quote}"
            </blockquote>
          )}

          {selected.transcript && selected.transcript.length > 0 && (
            <div className="mt-6 space-y-2">
              <p className="text-xs uppercase tracking-widest text-[var(--muted)]">
                Transcript
              </p>
              {selected.transcript.map((turn, i) => (
                <div
                  key={i}
                  className="rounded border border-[var(--border)] p-3 text-sm"
                >
                  <p className="text-xs uppercase tracking-wide text-accent">
                    {turn.role}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap">{turn.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
