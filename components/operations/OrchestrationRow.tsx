"use client";

import { useState } from "react";
import { AWP_JOBNFT, BASESCAN_BASE } from "@/lib/awp-contracts";
import { formatRel } from "@/lib/operations";
import type { FeedRow } from "@/lib/orchestration-merge";

const EVENT_ICON: Record<string, string> = {
  scan: "🔍",
  decision: "🧠",
  dispatch: "➜",
  skip: "⏭",
  act: "⛓",
  error: "⚠"
};

const SOURCE_COLOR: Record<string, string> = {
  "swarm-drain": "border-blue-500/50",
  "swarm-create": "border-purple-500/50",
  "sts-scanner": "border-zinc-500/50"
};

function actorPillClass(row: FeedRow): string {
  if (row.actor === "agent")
    return "bg-emerald-500/20 border-emerald-400/40 text-emerald-300";
  if (row.actor === "chain")
    return "bg-zinc-500/20 border-zinc-400/30 text-zinc-300";
  return "bg-blue-500/20 border-blue-400/40 text-blue-300";
}

function actorLabel(row: FeedRow): string {
  if (row.actor === "agent") {
    return row.persona ? `Agent · ${row.persona}` : "Agent";
  }
  if (row.actor === "chain") return "Chain";
  return row.source ? `Script · ${row.source}` : "Script";
}

function rowTintClass(row: FeedRow): string {
  // Left-border accent per source colour.
  return SOURCE_COLOR[row.source ?? ""] ?? "border-[var(--border)]";
}

export function OrchestrationRow({ row }: { row: FeedRow }) {
  const [expanded, setExpanded] = useState(false);
  const icon = EVENT_ICON[row.eventType] ?? "·";

  return (
    <li
      className={`rounded border border-l-4 bg-zinc-900/30 p-2 text-xs ${rowTintClass(
        row
      )}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono w-5 text-center">{icon}</span>
          <span
            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${actorPillClass(
              row
            )}`}
          >
            {actorLabel(row)}
          </span>
          <span className="text-zinc-500 whitespace-nowrap">
            {formatRel(row.at)}
          </span>
          <span className="text-zinc-200 flex-1 min-w-0 break-words">
            {row.summary}
          </span>
          {row.jobId != null && (
            <a
              href={`${BASESCAN_BASE}/token/${AWP_JOBNFT}?a=${row.jobId}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
            >
              job #{row.jobId} ↗
            </a>
          )}
          {row.txHash && (
            <a
              href={`${BASESCAN_BASE}/tx/${row.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
            >
              tx ↗
            </a>
          )}
          {row.wallet && !row.persona && (
            <a
              href={`${BASESCAN_BASE}/address/${row.wallet}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
            >
              {row.wallet.slice(0, 6)}…{row.wallet.slice(-4)}
            </a>
          )}
        </div>
        {/* Second line: if this row merged a dispatch's directive into an on-chain act,
            show the directive in quotes. Otherwise show the reasoning if any. */}
        {row.eventType === "act" && row.directive && (
          <div className="mt-1 pl-7 text-[11px] italic text-zinc-400">
            directive: "{row.directive}"
          </div>
        )}
        {row.eventType !== "act" && row.reasoning && (
          <div className="mt-1 pl-7 text-[11px] text-zinc-500">
            {row.reasoning}
          </div>
        )}
      </button>
      {expanded && (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-300">
          {JSON.stringify(
            row.raw.orchestration ?? row.raw.step ?? row.raw.result ?? row,
            null,
            2
          )}
        </pre>
      )}
    </li>
  );
}
