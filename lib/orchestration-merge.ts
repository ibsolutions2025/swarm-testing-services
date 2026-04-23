// Merge orchestration_events (script thinking) with lifecycle_results
// steps (on-chain outcomes) into a single unified feed for the Operations
// tab's Orchestration Stream panel.

import type {
  LifecycleResult,
  LifecycleStep
} from "./lifecycle-types";
import type {
  OrchestrationEvent,
  OrchestrationEventType
} from "./orchestration-types";

export type FeedActor = "script" | "agent" | "chain";
export type FeedEventType = OrchestrationEventType | "act";

export interface FeedRow {
  key: string;
  at: string; // ISO timestamp — sort key
  actor: FeedActor;
  source?: string; // "swarm-drain" | "swarm-create" | "sts-scanner"
  persona?: string | null;
  eventType: FeedEventType;
  summary: string;
  jobId?: number | null;
  txHash?: string | null;
  reasoning?: string | null;
  directive?: string | null;
  cycleId?: string | null;
  wallet?: string | null;
  raw: {
    orchestration?: OrchestrationEvent;
    step?: LifecycleStep;
    result?: LifecycleResult;
  };
}

// ──────────────────────────────────────────────────────────────
// Summary formatters — one per event_type. Kept defensive so bad
// meta shapes still render something sensible.
// ──────────────────────────────────────────────────────────────

function fmtJobHash(ev: OrchestrationEvent): string {
  const parts: string[] = [];
  if (ev.job_id != null) parts.push(`#${ev.job_id}`);
  return parts.join(" ");
}

function summarizeOrchestration(ev: OrchestrationEvent): string {
  const meta = (ev.meta || {}) as Record<string, unknown>;
  switch (ev.event_type) {
    case "scan": {
      const scanned = num(meta.scanned ?? meta.scanned_count);
      const actionable = num(meta.actionable ?? meta.actionable_count);
      if (scanned != null && actionable != null) {
        return `Scanned ${scanned} jobs — ${actionable} actionable`;
      }
      if (scanned != null) return `Scanned ${scanned} jobs`;
      return ev.reasoning || "Scan";
    }
    case "decision": {
      const action = str(meta.action) || "action";
      const whom = ev.persona || "agent";
      const job = ev.job_id != null ? `#${ev.job_id}` : "";
      const reason = ev.reasoning ? ` (${ev.reasoning})` : "";
      return `Chose ${whom} for ${action}${job ? ` on ${job}` : ""}${reason}`;
    }
    case "dispatch": {
      const action = str(meta.action) || "act";
      const whom = ev.persona || "agent";
      const job = ev.job_id != null ? `#${ev.job_id}` : "";
      const directive = ev.directive ? ` · "${ev.directive}"` : "";
      return `${whom} · ${action}${job ? ` ${job}` : ""}${directive}`;
    }
    case "skip": {
      const job = ev.job_id != null ? `#${ev.job_id}` : "target";
      const reason = ev.reasoning ? ` · ${ev.reasoning}` : "";
      return `Skipped ${job}${reason}`;
    }
    case "error": {
      const code = str(meta.status) || str(meta.code);
      const msg = ev.reasoning || str(meta.message) || "Error";
      return code ? `${code} · ${msg}` : msg;
    }
    default:
      return ev.reasoning || ev.event_type;
  }
}

function num(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function shortWallet(w?: string | null): string {
  if (!w) return "";
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

function pickActorWallet(
  result: LifecycleResult,
  step: LifecycleStep
): string | null {
  const d: any = step.details || {};
  for (const k of ["worker", "validator", "poster", "actor"]) {
    const v = d[k];
    if (typeof v === "string" && v.startsWith("0x")) return v;
  }
  const aw = result.agent_wallets as any;
  if (aw && typeof aw === "object" && !Array.isArray(aw)) {
    return aw.worker || aw.validator || aw.poster || null;
  }
  return null;
}

function stepTimestamp(
  result: LifecycleResult,
  step: LifecycleStep
): string {
  const d: any = step.details;
  return (
    (typeof d?.timestamp === "string" && d.timestamp) ||
    result.updated_at ||
    result.completed_at ||
    result.started_at ||
    new Date().toISOString()
  );
}

function summarizeStep(
  result: LifecycleResult,
  step: LifecycleStep,
  personaHint?: string | null
): string {
  const d: any = step.details || {};
  const jobLabel = result.onchain_job_id != null ? `#${result.onchain_job_id}` : "";
  const actor = personaHint || shortWallet(pickActorWallet(result, step)) || "agent";
  const comment = str(d.feedback) || str(d.comment) || str(d.note);
  const base = `${actor} ${step.name} ${jobLabel}`.trim();
  return comment ? `${base} · "${String(comment).slice(0, 140)}"` : base;
}

// ──────────────────────────────────────────────────────────────
// Build rows
// ──────────────────────────────────────────────────────────────

export function buildFeed(
  orchestration: OrchestrationEvent[],
  lifecycleResults: LifecycleResult[],
  options: { max?: number } = {}
): FeedRow[] {
  const max = options.max ?? 100;

  // Index orchestration events by tx_hash (only rows with one).
  const byTxHash = new Map<string, OrchestrationEvent>();
  for (const ev of orchestration) {
    if (ev.tx_hash) {
      const key = ev.tx_hash.toLowerCase();
      // Prefer dispatch over decision if both share a tx_hash.
      const existing = byTxHash.get(key);
      if (
        !existing ||
        (ev.event_type === "dispatch" && existing.event_type !== "dispatch")
      ) {
        byTxHash.set(key, ev);
      }
    }
  }

  const consumedOrchestrationIds = new Set<string>();
  const rows: FeedRow[] = [];

  // Lifecycle steps → act rows (merged with matching orchestration if any).
  for (const r of lifecycleResults) {
    if (!r.steps) continue;
    for (let i = 0; i < r.steps.length; i++) {
      const step = r.steps[i];
      const tx = (step.details as any)?.txHash as string | undefined;
      const matched = tx ? byTxHash.get(tx.toLowerCase()) : undefined;
      if (matched) consumedOrchestrationIds.add(matched.id);

      const personaHint = matched?.persona ?? null;
      rows.push({
        key: `lc:${r.id}:${i}`,
        at: stepTimestamp(r, step),
        actor: "agent",
        source: matched?.source,
        persona: personaHint,
        eventType: "act",
        summary: summarizeStep(r, step, personaHint),
        jobId: r.onchain_job_id ?? null,
        txHash: tx || null,
        reasoning: matched?.reasoning ?? null,
        directive: matched?.directive ?? null,
        cycleId: matched?.cycle_id ?? null,
        wallet: pickActorWallet(r, step),
        raw: { step, result: r, orchestration: matched }
      });
    }
  }

  // Non-consumed orchestration events → their own rows.
  for (const ev of orchestration) {
    if (consumedOrchestrationIds.has(ev.id)) continue;
    const actor: FeedActor =
      ev.event_type === "dispatch" && ev.persona ? "agent" : "script";
    rows.push({
      key: `or:${ev.id}`,
      at: ev.ran_at,
      actor,
      source: ev.source,
      persona: ev.persona ?? null,
      eventType: ev.event_type as FeedEventType,
      summary: summarizeOrchestration(ev),
      jobId: ev.job_id ?? null,
      txHash: ev.tx_hash ?? null,
      reasoning: ev.reasoning ?? null,
      directive: ev.directive ?? null,
      cycleId: ev.cycle_id,
      raw: { orchestration: ev }
    });
  }

  rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return rows.slice(0, max);
}
