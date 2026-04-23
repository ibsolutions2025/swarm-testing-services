"use client";

/**
 * OperationsTab — AWP swarm control panel.
 *
 * Three panels:
 *   A) System Heartbeats      — liveness of swarm-drain, swarm-create,
 *                               sts-scanner. Pulls /api/test-results/heartbeats.
 *   B) Orchestration Stream   — merged feed of script thinking
 *                               (orchestration_events) + agent on-chain
 *                               acts (lifecycle_results steps). Own polling
 *                               inside the sub-component (Phase 6).
 *   C) Pipeline Breakdown     — AGENT vs SCRIPT + status bars derived from
 *                               lifecycle_results in the last 24h.
 *
 * -----------------------------------------------------------------------
 * VPS DEPENDENCY (out of scope for this PR).
 *
 * Panel A cards stay idle until VPS scripts write to `system_heartbeats`.
 * Panel B's script-side rows stay empty until VPS scripts write to
 * `orchestration_events`. Migrations 0003 / 0004 + the VPS emit patches
 * are the unlock; see lib/heartbeat-types.ts and
 * lib/orchestration-types.ts.
 * -----------------------------------------------------------------------
 */

import { useEffect, useState } from "react";
import { HeartbeatCard } from "./HeartbeatCard";
import { PipelineBreakdown } from "./PipelineBreakdown";
import { OrchestrationStream } from "./OrchestrationStream";
import {
  HEARTBEAT_COMPONENTS,
  type HeartbeatsResponse,
  type HeartbeatComponentState
} from "@/lib/heartbeat-types";
import type { LifecycleListResponse } from "@/lib/lifecycle-types";

const POLL_MS = 15_000;
const LIFECYCLE_SINCE_HOURS = 24;

const EMPTY_COMPONENT_STATE: HeartbeatComponentState = {
  last: null,
  count24h: 0
};

export function OperationsTab({ projectKey }: { projectKey: "awp" }) {
  void projectKey;
  const [heartbeats, setHeartbeats] = useState<HeartbeatsResponse | null>(null);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleListResponse | null>(
    null
  );
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchBoth = async () => {
      const sinceIso = new Date(
        Date.now() - LIFECYCLE_SINCE_HOURS * 60 * 60 * 1000
      ).toISOString();

      const [hbRes, lcRes] = await Promise.allSettled([
        fetch("/api/test-results/heartbeats?project=awp", {
          cache: "no-store"
        }),
        fetch(
          `/api/test-results/lifecycle?limit=200&since=${encodeURIComponent(
            sinceIso
          )}`,
          { cache: "no-store" }
        )
      ]);

      if (cancelled) return;

      if (hbRes.status === "fulfilled" && hbRes.value.ok) {
        try {
          const body: HeartbeatsResponse = await hbRes.value.json();
          if (!cancelled) {
            setHeartbeats(body);
            setHeartbeatError(null);
          }
        } catch (e: any) {
          if (!cancelled) setHeartbeatError(e?.message || "parse error");
        }
      } else if (hbRes.status === "fulfilled") {
        setHeartbeatError(`HTTP ${hbRes.value.status}`);
      } else {
        setHeartbeatError((hbRes.reason as any)?.message || "fetch failed");
      }

      if (lcRes.status === "fulfilled" && lcRes.value.ok) {
        try {
          const body: LifecycleListResponse = await lcRes.value.json();
          if (!cancelled) {
            setLifecycle(body);
            setLifecycleError(null);
          }
        } catch (e: any) {
          if (!cancelled) setLifecycleError(e?.message || "parse error");
        }
      } else if (lcRes.status === "fulfilled") {
        setLifecycleError(`HTTP ${lcRes.value.status}`);
      } else {
        setLifecycleError((lcRes.reason as any)?.message || "fetch failed");
      }
    };

    fetchBoth();
    const t = setInterval(fetchBoth, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const heartbeatTableMissing = heartbeats?.table_missing === true;

  return (
    <div className="space-y-8">
      {/* ---------- Panel A ---------- */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--muted)]">
            System Heartbeats
          </h2>
          {heartbeatTableMissing && (
            <span className="rounded-full bg-amber-900/20 border border-amber-700 px-2 py-0.5 text-[11px] text-amber-300">
              system_heartbeats table not provisioned yet
            </span>
          )}
          {heartbeatError && !heartbeatTableMissing && (
            <span className="text-[11px] text-red-400">
              heartbeats: {heartbeatError}
            </span>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {HEARTBEAT_COMPONENTS.map((c) => (
            <HeartbeatCard
              key={c}
              component={c}
              state={heartbeats?.components?.[c] ?? EMPTY_COMPONENT_STATE}
            />
          ))}
        </div>
      </section>

      {/* ---------- Panel B ---------- */}
      <section>
        <OrchestrationStream projectKey="awp" />
      </section>

      {/* ---------- Panel C ---------- */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--muted)]">
            Pipeline Breakdown
          </h2>
          <span className="text-[11px] text-[var(--muted)]">
            {(lifecycle?.results || []).length} rows in window
            {lifecycleError && (
              <span className="ml-2 text-red-400">{lifecycleError}</span>
            )}
          </span>
        </div>
        <PipelineBreakdown results={lifecycle?.results || []} />
      </section>
    </div>
  );
}
