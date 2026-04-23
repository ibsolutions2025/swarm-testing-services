"use client";

import {
  formatRel,
  heartbeatHealth,
  type HealthTone
} from "@/lib/operations";
import type {
  Heartbeat,
  HeartbeatComponent,
  HeartbeatComponentState
} from "@/lib/heartbeat-types";
import { EXPECTED_CADENCE_SEC } from "@/lib/heartbeat-types";

const COMPONENT_LABEL: Record<HeartbeatComponent, string> = {
  "swarm-drain": "swarm-drain",
  "swarm-create": "swarm-create",
  "sts-scanner": "sts-scanner"
};

const CADENCE_LABEL: Record<HeartbeatComponent, string> = {
  "swarm-drain": "every 5 min",
  "swarm-create": "every 15 min",
  "sts-scanner": "every 15 min"
};

const TONE_CLASS: Record<HealthTone, string> = {
  green: "border-emerald-600 bg-emerald-900/15",
  amber: "border-amber-600 bg-amber-900/15",
  red: "border-red-600 bg-red-900/15",
  idle: "border-[var(--border)] bg-zinc-900/40"
};

const TONE_DOT: Record<HealthTone, string> = {
  green: "bg-emerald-400",
  amber: "bg-amber-400",
  red: "bg-red-400",
  idle: "bg-zinc-600"
};

function headline(last: Heartbeat | null): string {
  if (!last) return "—";
  const { component, outcome, actions_count, note } = last;
  if (typeof actions_count === "number" && actions_count > 0) {
    if (component === "swarm-create") return `${outcome ?? "ok"} created #${actions_count}`;
    if (component === "sts-scanner") return `${outcome ?? "ok"} +${actions_count} rows`;
    return `${outcome ?? "ok"} ${actions_count} actions`;
  }
  if (note) return note;
  return outcome ?? "ran";
}

export function HeartbeatCard({
  component,
  state
}: {
  component: HeartbeatComponent;
  state: HeartbeatComponentState;
}) {
  const expected = EXPECTED_CADENCE_SEC[component];
  const tone = heartbeatHealth(state.last?.ran_at ?? null, expected);
  const ok = state.last?.outcome ? state.last.outcome === "ok" : null;

  return (
    <div className={`rounded-xl border p-4 ${TONE_CLASS[tone]}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`}
          />
          <span className="font-mono text-sm text-zinc-200">
            [ {COMPONENT_LABEL[component]} ]
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">
          {CADENCE_LABEL[component]}
        </span>
      </div>

      <div className="mt-3 text-lg font-semibold text-zinc-100">
        {state.last ? formatRel(state.last.ran_at) : "No heartbeat yet"}
      </div>

      <div className="mt-1 text-sm text-zinc-400">
        {state.last ? (
          <>
            <span
              className={ok === false ? "text-red-400" : "text-emerald-400"}
            >
              {ok === false ? "✗" : "✓"}
            </span>{" "}
            {headline(state.last)}
          </>
        ) : (
          <span className="italic text-zinc-500">
            waiting for first run
          </span>
        )}
      </div>

      <div className="mt-3 text-[11px] text-zinc-500">
        {state.count24h} run{state.count24h === 1 ? "" : "s"} in last 24h
      </div>
    </div>
  );
}
