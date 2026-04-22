"use client";

import { useState } from "react";
import { RUN_OUTCOME_COLORS } from "@/lib/constants";
import type { Matrix, Run } from "@/lib/types";

interface Props {
  matrix: Matrix;
  runs: Run[];
}

export function ScenarioMatrix({ matrix, runs }: Props) {
  const [selected, setSelected] = useState<{
    rowId: string;
    colId: string;
  } | null>(null);

  const runFor = (rowId: string, colId: string) =>
    runs.find(
      (r) => r.matrix_row_id === rowId && r.matrix_column_id === colId
    );

  const selectedRun = selected
    ? runFor(selected.rowId, selected.colId)
    : null;

  return (
    <div className="space-y-8">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1">
          <thead>
            <tr>
              <th className="w-48 p-2 text-left text-xs uppercase tracking-widest text-[var(--muted)]">
                Configuration ↓ / Scenario →
              </th>
              {matrix.columns.map((col) => (
                <th
                  key={col.id}
                  className="min-w-[140px] p-2 text-left text-xs font-medium"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.id}>
                <td className="align-top p-2 text-sm">{row.label}</td>
                {matrix.columns.map((col) => {
                  const run = runFor(row.id, col.id);
                  const outcome = run?.outcome ?? "skipped";
                  const color =
                    RUN_OUTCOME_COLORS[outcome] ??
                    "bg-zinc-500/20 border-zinc-400/30";
                  const isSelected =
                    selected?.rowId === row.id && selected?.colId === col.id;
                  return (
                    <td key={col.id} className="p-0">
                      <button
                        onClick={() =>
                          setSelected({ rowId: row.id, colId: col.id })
                        }
                        className={`h-16 w-full rounded border text-xs ${color} ${
                          isSelected ? "ring-2 ring-white" : ""
                        } hover:opacity-80`}
                        title={`${row.label} × ${col.label} — ${outcome}`}
                      >
                        {run ? outcome : "—"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedRun && (
        <div className="rounded-md border border-[var(--border)] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-accent">
                Run detail
              </p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {
                  matrix.rows.find((r) => r.id === selectedRun.matrix_row_id)
                    ?.label
                }{" "}
                ×{" "}
                {
                  matrix.columns.find(
                    (c) => c.id === selectedRun.matrix_column_id
                  )?.label
                }
              </p>
            </div>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                RUN_OUTCOME_COLORS[selectedRun.outcome] ?? ""
              }`}
            >
              {selectedRun.outcome}
            </span>
          </div>

          {selectedRun.quote && (
            <blockquote className="mt-4 border-l-2 border-accent pl-4 italic text-[var(--muted)]">
              "{selectedRun.quote}"
            </blockquote>
          )}

          {selectedRun.transcript && selectedRun.transcript.length > 0 && (
            <div className="mt-6 space-y-3">
              <p className="text-xs uppercase tracking-widest text-[var(--muted)]">
                Transcript
              </p>
              <div className="space-y-2">
                {selectedRun.transcript.map((turn, i) => (
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
