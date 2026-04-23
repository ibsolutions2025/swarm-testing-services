"use client";

/**
 * OperationsTab — AWP swarm control panel.
 *
 * Three panels:
 *   A) System Heartbeats     — liveness of swarm-drain, swarm-create, sts-scanner.
 *                              Pulls from /api/test-results/heartbeats.
 *   B) Live Lifecycle Timeline — last 30 step events across recent lifecycle_results rows.
 *                              Pulls from /api/test-results/lifecycle?since=<ISO>, polled 15s.
 *   C) Pipeline Breakdown     — bars of driver (AGENT vs SCRIPT) + status.
 *
 * -----------------------------------------------------------------------
 * VPS DEPENDENCY (out of scope for this PR).
 *
 * Panel A cards stay amber/red with the "No heartbeat yet" fallback until
 * the VPS scripts start writing rows to Supabase `system_heartbeats`.
 * Expected shape (implemented as a separate Cowork task):
 *
 *   INSERT INTO system_heartbeats
 *     (project_id, component, outcome, actions_count, note, meta)
 *   VALUES
 *     ('awp', 'swarm-drain', 'ok', 18, 'drained 18 jobs',
 *      '{"errors":0,"duration_ms":45123}'::jsonb);
 *
 * Expected components: swarm-drain (every 5m), swarm-create (every 15m),
 * sts-scanner (every 15m). See lib/heartbeat-types.ts.
 * -----------------------------------------------------------------------
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HeartbeatCard } from "./HeartbeatCard";
import { LifelineEvent, type TimelineEvent } from "./LifelineEvent";
import { PipelineBreakdown } from "./PipelineBreakdown";
import {
  HEARTBEAT_COMPONENTS,
  type HeartbeatsResponse,
  type HeartbeatComponentState
} from "@/lib/heartbeat-types";
import type {
  LifecycleListResponse,
  LifecycleResult
} from "@/lib/lifecycle-types";

const POLL_MS = 15_000;
const MAX_EVENTS = 30;
const LIFECYCLE_SINCE_HOURS = 24;

const EMPTY_COMPONENT_STATE: HeartbeatComponentState = {
  last: null,
  count24h: 0
};

function stepTimestamp(
  result: LifecycleResult,
  step: LifecycleResult["steps"][number]
): string {
  const d: any = step.details;
  const inferred =
    (typeof d?.timestamp === "string" && d.timestamp) ||
    (typeof d?.ts === "string" && d.ts) ||
    result.updated_at ||
    result.completed_at ||
    result.started_at;
  return inferred || new Date().toISOString();
}

export function OperationsTab({ projectKey }: { projectKey: "awp" }) {
  void projectKey;
  const [heartbeats, setHeartbeats] = useState<HeartbeatsResponse | null>(null);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleListResponse | null>(
    null
  );
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Dedup keys across polls so the timeline grows stably rather than
  // flickering every 15s.
  const seenKeys = useRef<Set<string>>(new Set());

  const buildEvents = useCallback(
    (rows: LifecycleResult[]): TimelineEvent[] => {
      const events: TimelineEvent[] = [];
      for (const r of rows) {
        if (!r.steps) continue;
        for (let i = 0; i < r.steps.length; i++) {
          const step = r.steps[i];
          const at = stepTimestamp(r, step);
          const key = `${r.id}:${i}:${step.name}`;
          events.push({ key, result: r, step, at });
        }
      }
      // Newest first.
      events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      return events.slice(0, MAX_EVENTS);
    },
    []
  );

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

      // Heartbeats.
      if (hbRes.status === "fulfilled" && hbRes.value.ok) {
        try {
          const body: HeartbeatsResponse = await hbRes.value.json();
          if (!cancelled) {
            setHeartbeats(body);
            setHeartbeatError(null);
          }
        } catch (e: any) {
          if (!cancelled)
            setHeartbeatError(e?.message || "parse error");
        }
      } else if (hbRes.status === "fulfilled") {
        setHeartbeatError(`HTTP ${hbRes.value.status}`);
      } else {
        setHeartbeatError((hbRes.reason as any)?.message || "fetch failed");
      }

      // Lifecycle.
      if (lcRes.status === "fulfilled" && lcRes.value.ok) {
        try {
          const body: LifecycleListResponse = await lcRes.value.json();
          if (!cancelled) {
            setLifecycle(body);
            setLifecycleError(null);
            // Update seenKeys to reflect the new event set.
            const events = buildEvents(body.results || []);
            seenKeys.current = new Set(events.map((e) => e.key));
          }
        } catch (e: any) {
          if (!cancelled)
            setLifecycleError(e?.message || "parse error");
        }
      } else if (lcRes.status === "fulfilled") {
        setLifecycleError(`HTTP ${lcRes.value.status}`);
      } else {
        setLifecycleError((lcRes.reason as any)?.message || "fetch failed");
      }

      if (!cancelled) setLoading(false);
    };

    fetchBoth();
    const t = setInterval(fetchBoth, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [buildEvents]);

  const events = useMemo(
    () => buildEvents(lifecycle?.results || []),
    [lifecycle, buildEvents]
  );

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
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--muted)]">
            Live Lifecycle Timeline
          </h2>
          <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
            <span>
              last {events.length} event{events.length === 1 ? "" : "s"}
            </span>
            {lifecycleError && (
              <span className="text-red-400">{lifecycleError}</span>
            )}
          </div>
        </div>
        {loading && !lifecycle ? (
          <div className="flex h-40 items-center justify-center text-xs text-[var(--muted)]">
            Loading recent activity…
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-md border border-[var(--border)] p-6 text-center text-xs text-[var(--muted)]">
            No lifecycle steps captured in the last {LIFECYCLE_SINCE_HOURS}h
            yet.
          </div>
        ) : (
          <ol className="space-y-2">
            {events.map((e) => (
              <LifelineEvent key={e.key} event={e} />
            ))}
          </ol>
        )}
      </section>

      {/* ---------- Panel C ---------- */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--muted)]">
            Pipeline Breakdown
          </h2>
          <span className="text-[11px] text-[var(--muted)]">
            {(lifecycle?.results || []).length} rows in window
          </span>
        </div>
        <PipelineBreakdown results={lifecycle?.results || []} />
      </section>
    </div>
  );
}
