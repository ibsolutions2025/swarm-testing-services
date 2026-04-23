"use client";

import { useState } from "react";
import { AWP_JOBNFT, BASESCAN_BASE } from "@/lib/awp-contracts";
import {
  driverBadgeClass,
  driverForStep,
  formatRel,
  type Driver
} from "@/lib/operations";
import type { LifecycleResult, LifecycleStep } from "@/lib/lifecycle-types";

function short(addr: string | null | undefined): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function stepIcon(status: string): string {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "◌";
    case "skipped":
      return "–";
    case "error":
      return "!";
    default:
      return "·";
  }
}

function pickAgentWallet(result: LifecycleResult, step: LifecycleStep): string | null {
  const stepWallet = (step.details as any)?.worker as string | undefined;
  if (typeof stepWallet === "string") return stepWallet;
  const aw = result.agent_wallets;
  if (Array.isArray(aw)) {
    return aw.find((s): s is string => typeof s === "string") ?? null;
  }
  if (aw && typeof aw === "object") {
    return aw.poster || aw.worker || aw.validator || null;
  }
  const w = result.wallets as any;
  if (w && typeof w === "object") {
    if (typeof w.worker === "string") return w.worker;
    if (w.employer?.address) return w.employer.address as string;
    if (Array.isArray(w.workers) && w.workers[0]?.address) {
      return w.workers[0].address as string;
    }
  }
  return null;
}

export interface TimelineEvent {
  key: string;
  result: LifecycleResult;
  step: LifecycleStep;
  at: string; // ISO timestamp for sorting (from step details or row updated_at)
}

export function LifelineEvent({ event }: { event: TimelineEvent }) {
  const { result, step, at } = event;
  const [expanded, setExpanded] = useState(false);
  const driver: Driver = driverForStep(step, result.created_at ?? result.started_at);
  const wallet = pickAgentWallet(result, step);
  const tx = (step.details as any)?.txHash as string | undefined;
  const jobLabel =
    typeof result.onchain_job_id === "number"
      ? `#${result.onchain_job_id}`
      : `#${result.run_id.slice(0, 6)}`;

  return (
    <li className="rounded border border-[var(--border)] bg-zinc-900/30 p-3 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-zinc-500 w-4 text-center">
            {stepIcon(step.status)}
          </span>
          {result.onchain_job_id ? (
            <a
              href={`${BASESCAN_BASE}/token/${AWP_JOBNFT}?a=${result.onchain_job_id}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
            >
              {jobLabel}
            </a>
          ) : (
            <span className="font-mono text-zinc-500">{jobLabel}</span>
          )}
          <span className="font-medium text-zinc-200">{step.name}</span>
          {wallet && (
            <a
              href={`${BASESCAN_BASE}/address/${wallet}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
            >
              {short(wallet)}
            </a>
          )}
          <span
            className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${driverBadgeClass(
              driver
            )}`}
          >
            {driver}
          </span>
          <span className="ml-auto text-zinc-500">{formatRel(at)}</span>
          {tx && (
            <a
              href={`${BASESCAN_BASE}/tx/${tx}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
            >
              tx ↗
            </a>
          )}
        </div>
      </button>
      {expanded && step.details && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 font-mono text-[10px] leading-4 text-zinc-300">
          {JSON.stringify(step.details, null, 2)}
        </pre>
      )}
    </li>
  );
}
