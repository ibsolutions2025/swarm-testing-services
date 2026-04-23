// Operations-tab helpers: driver attribution (SCRIPT vs AGENT) + timing.
//
// The AWP swarm ran agent-driven (Chutes Kimi K2.6-TEE orchestrated by
// auto-cycle.mjs) until 2026-04-23 19:40 UTC; the mechanical rewrite
// (swarm-drain.mjs + swarm-create.mjs) took over at the cutover. We
// distinguish the two in the timeline badge.

import type { LifecycleStep } from "./lifecycle-types";

export const CUTOVER_UTC = "2026-04-23T19:40:00Z";
const CUTOVER_MS = new Date(CUTOVER_UTC).getTime();

export type Driver = "SCRIPT" | "AGENT";

export function driverForStep(
  step: LifecycleStep | undefined,
  createdAt: string | undefined | null
): Driver {
  const stepDriver = (step?.details as any)?.driver;
  if (stepDriver === "swarm-drain" || stepDriver === "swarm-create") {
    return "SCRIPT";
  }
  if (createdAt) {
    const t = new Date(createdAt).getTime();
    if (!isNaN(t) && t >= CUTOVER_MS) return "SCRIPT";
  }
  return "AGENT";
}

export function driverBadgeClass(driver: Driver): string {
  return driver === "SCRIPT"
    ? "bg-blue-500/20 border-blue-400/30 text-blue-300"
    : "bg-emerald-500/20 border-emerald-400/30 text-emerald-300";
}

/**
 * Human-readable relative time. Mirrors the one in TransactionsTab but
 * with second-level precision for the live timeline.
 */
export function formatRel(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diff = Date.now() - t;
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Classify a heartbeat's last-ran_at against its expected cadence.
 * Absolute beyond-30-min check overrides cadence ratio (per spec).
 */
export type HealthTone = "green" | "amber" | "red" | "idle";

export function heartbeatHealth(
  lastRanAt: string | null | undefined,
  expectedSec: number
): HealthTone {
  if (!lastRanAt) return "idle";
  const t = new Date(lastRanAt).getTime();
  if (isNaN(t)) return "idle";
  const ageSec = (Date.now() - t) / 1000;
  if (ageSec > 30 * 60) return "red";
  if (ageSec <= 2 * expectedSec) return "green";
  if (ageSec <= 4 * expectedSec) return "amber";
  return "red";
}
