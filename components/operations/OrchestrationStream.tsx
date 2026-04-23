"use client";

/**
 * OrchestrationStream — the operating-brain view for the AWP swarm.
 *
 * Merges TWO sources into one newest-first feed, polled every 10s:
 *   • /api/test-results/orchestration — script-emitted events
 *     (scan / decision / dispatch / skip / error)
 *   • /api/test-results/lifecycle — on-chain steps from the scanner
 *     (rendered as event_type='act')
 *
 * Dedupe rule: a lifecycle step whose tx_hash matches an orchestration
 * event's tx_hash collapses into one merged row that shows BOTH the
 * dispatch directive AND the on-chain outcome.
 *
 * -----------------------------------------------------------------------
 * VPS DEPENDENCY (out of scope for this PR).
 *
 * Panel stays in "no orchestration events yet" state until the VPS
 * scripts start emitting to `orchestration_events`. Expected shape per
 * emission:
 *
 *   POST /rest/v1/orchestration_events
 *   {
 *     project_id:  'awp',
 *     cycle_id:    <uuid or timestamp-based group id>,
 *     source:      'swarm-drain' | 'swarm-create',
 *     event_type:  'scan' | 'decision' | 'dispatch' | 'skip' | 'error',
 *     persona:     'Judge' | ...,     // for dispatch/decision rows
 *     job_id:      <number>,          // when targeted at a job
 *     directive:   "review this submission honestly",
 *     reasoning:   "eligible validator + round-robin turn",
 *     tx_hash:     "0x...",           // if known at emission time
 *     meta:        { action: 'approve', scanned: 80, actionable: 12, ... }
 *   }
 *
 * Typical drain cycle:
 *   1 × scan       (at start: "scanned jobs X-Y")
 *   N × decision   (one per job considered)
 *   M × dispatch   (one per agent called — the directive shows here)
 *   M × act        (merged in via lifecycle step's tx_hash)
 *   1 × error      (on any failure)
 *   end: the heartbeat row (Phase 4/5).
 * -----------------------------------------------------------------------
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { OrchestrationRow } from "./OrchestrationRow";
import { buildFeed, type FeedRow } from "@/lib/orchestration-merge";
import type {
  OrchestrationResponse
} from "@/lib/orchestration-types";
import type { LifecycleListResponse } from "@/lib/lifecycle-types";

const POLL_MS = 10_000;
const MAX_ROWS = 100;
const WINDOW_HOURS = 24;

const PERSONAS = [
  "Spark",
  "Grind",
  "Judge",
  "Chaos",
  "Scout",
  "Flash",
  "Bridge"
] as const;

type ActorFilter = "all" | "scripts" | "agents";
type EventFilter =
  | "all"
  | "decisions"
  | "dispatches"
  | "acts"
  | "errors";

const EVENT_FILTER_MATCH: Record<EventFilter, Set<string>> = {
  all: new Set(["scan", "decision", "dispatch", "skip", "act", "error"]),
  decisions: new Set(["decision"]),
  dispatches: new Set(["dispatch"]),
  acts: new Set(["act"]),
  errors: new Set(["error"])
};

export function OrchestrationStream({
  projectKey
}: {
  projectKey: "awp";
}) {
  void projectKey;

  const [orchestration, setOrchestration] =
    useState<OrchestrationResponse | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleListResponse | null>(
    null
  );
  const [orchError, setOrchError] = useState<string | null>(null);
  const [lcError, setLcError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [actorFilter, setActorFilter] = useState<ActorFilter>("all");
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [personaFilter, setPersonaFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");

  const fetchBoth = useCallback(async () => {
    const sinceIso = new Date(
      Date.now() - WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();
    const [orRes, lcRes] = await Promise.allSettled([
      fetch(
        `/api/test-results/orchestration?project=awp&since=${encodeURIComponent(
          sinceIso
        )}&limit=500`,
        { cache: "no-store" }
      ),
      fetch(
        `/api/test-results/lifecycle?limit=200&since=${encodeURIComponent(
          sinceIso
        )}`,
        { cache: "no-store" }
      )
    ]);

    if (orRes.status === "fulfilled" && orRes.value.ok) {
      try {
        const body: OrchestrationResponse = await orRes.value.json();
        setOrchestration(body);
        setOrchError(null);
      } catch (e: any) {
        setOrchError(e?.message || "parse error");
      }
    } else if (orRes.status === "fulfilled") {
      setOrchError(`HTTP ${orRes.value.status}`);
    } else {
      setOrchError((orRes.reason as any)?.message || "fetch failed");
    }

    if (lcRes.status === "fulfilled" && lcRes.value.ok) {
      try {
        const body: LifecycleListResponse = await lcRes.value.json();
        setLifecycle(body);
        setLcError(null);
      } catch (e: any) {
        setLcError(e?.message || "parse error");
      }
    } else if (lcRes.status === "fulfilled") {
      setLcError(`HTTP ${lcRes.value.status}`);
    } else {
      setLcError((lcRes.reason as any)?.message || "fetch failed");
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await fetchBoth();
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [fetchBoth]);

  const orchestrationMissing = orchestration?.table_missing === true;

  const feed: FeedRow[] = useMemo(
    () =>
      buildFeed(
        orchestration?.events ?? [],
        lifecycle?.results ?? [],
        { max: MAX_ROWS }
      ),
    [orchestration, lifecycle]
  );

  const filtered: FeedRow[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    const typeSet = EVENT_FILTER_MATCH[eventFilter];
    return feed.filter((row) => {
      if (actorFilter === "scripts" && row.actor !== "script") return false;
      if (
        actorFilter === "agents" &&
        row.actor !== "agent" &&
        row.actor !== "chain"
      )
        return false;
      if (!typeSet.has(row.eventType)) return false;
      if (personaFilter !== "all" && row.persona !== personaFilter)
        return false;
      if (q) {
        const hay = [row.summary, row.reasoning || "", row.directive || ""]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [feed, actorFilter, eventFilter, personaFilter, search]);

  // Group consecutive rows with the same cycle_id for the nice-to-have
  // cycle header (only if more than one row shares the id).
  const grouped = useMemo(() => {
    const groups: Array<{
      cycleId: string | null;
      source: string | undefined;
      rows: FeedRow[];
    }> = [];
    for (const row of filtered) {
      const last = groups[groups.length - 1];
      if (last && last.cycleId && last.cycleId === row.cycleId) {
        last.rows.push(row);
      } else {
        groups.push({
          cycleId: row.cycleId ?? null,
          source: row.source,
          rows: [row]
        });
      }
    }
    return groups;
  }, [filtered]);

  // ───────── render
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--muted)]">
          Orchestration Stream
        </h2>
        <div className="flex items-center gap-3 text-[11px] text-[var(--muted)]">
          <span>
            {filtered.length} of {feed.length} rows
          </span>
          {orchestrationMissing && (
            <span className="rounded-full bg-amber-900/20 border border-amber-700 px-2 py-0.5 text-amber-300">
              orchestration_events table not provisioned yet
            </span>
          )}
          {orchError && !orchestrationMissing && (
            <span className="text-red-400">orchestration: {orchError}</span>
          )}
          {lcError && (
            <span className="text-red-400">lifecycle: {lcError}</span>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] p-2">
        <SegGroup<ActorFilter>
          value={actorFilter}
          onChange={setActorFilter}
          options={[
            ["all", "All actors"],
            ["scripts", "Scripts"],
            ["agents", "Agents"]
          ]}
        />
        <SegGroup<EventFilter>
          value={eventFilter}
          onChange={setEventFilter}
          options={[
            ["all", "All events"],
            ["decisions", "Decisions"],
            ["dispatches", "Dispatches"],
            ["acts", "Acts"],
            ["errors", "Errors"]
          ]}
        />
        <select
          value={personaFilter}
          onChange={(e) => setPersonaFilter(e.target.value)}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs"
        >
          <option value="all">All personas</option>
          {PERSONAS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search summary / reasoning / directive"
          className="min-w-[240px] flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs"
        />
      </div>

      {/* Stream */}
      {loading && !orchestration && !lifecycle ? (
        <div className="flex h-40 items-center justify-center text-xs text-[var(--muted)]">
          Loading stream…
        </div>
      ) : feed.length === 0 ? (
        <div className="rounded-md border border-[var(--border)] p-6 text-center text-xs text-[var(--muted)]">
          {orchestrationMissing
            ? "Waiting on migration 0004 + VPS orchestration emitter. Lifecycle acts will appear once the scanner ingests a new cycle."
            : `No stream events in the last ${WINDOW_HOURS}h yet.`}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-[var(--border)] p-6 text-center text-xs text-[var(--muted)]">
          No rows match the current filters.
        </div>
      ) : (
        <ol className="space-y-2">
          {grouped.map((g, gi) => {
            const showHeader = !!g.cycleId && g.rows.length > 1;
            const dispatches = g.rows.filter(
              (r) => r.eventType === "dispatch"
            ).length;
            const acts = g.rows.filter((r) => r.eventType === "act").length;
            const cycleTime = g.rows[0]?.at;
            return (
              <li key={`g-${gi}`}>
                {showHeader && (
                  <div className="mb-1 pl-1 text-[10px] uppercase tracking-widest text-zinc-500">
                    {g.source || "cycle"} ·{" "}
                    {cycleTime
                      ? new Date(cycleTime).toLocaleTimeString()
                      : ""}{" "}
                    · {g.rows.length} events
                    {dispatches ? ` · ${dispatches} dispatches` : ""}
                    {acts ? ` · ${acts} on-chain acts` : ""}
                  </div>
                )}
                <ol className="space-y-2">
                  {g.rows.map((r) => (
                    <OrchestrationRow key={r.key} row={r} />
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function SegGroup<T extends string>({
  value,
  onChange,
  options
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<[T, string]>;
}) {
  return (
    <div className="inline-flex rounded border border-[var(--border)] text-xs">
      {options.map(([v, label], i) => {
        const active = v === value;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={`px-2 py-1.5 ${i > 0 ? "border-l border-[var(--border)]" : ""} ${
              active
                ? "bg-white/10 text-white"
                : "text-[var(--muted)] hover:text-white"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
