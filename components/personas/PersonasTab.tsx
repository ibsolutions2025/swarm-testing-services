"use client";

import type { AgentDoc } from "@/lib/agents-fs";
import type { AuditReport } from "@/lib/insider-audit";
import { PersonaCard } from "./PersonaCard";

export interface PersonaBundle {
  agent: AgentDoc;
  audit: AuditReport;
}

/**
 * Grid of persona cards. The server component (detail page) does the
 * filesystem read + audit; this component is presentational and handles
 * only the tab-per-card interactivity inside PersonaCard.
 *
 * Phase 2 scope: AWP project only. Other projectKeys render an empty
 * state; Phase 3+ will pull personas from Supabase keyed by project_id.
 */
export function PersonasTab({
  personas,
  projectKey
}: {
  personas: PersonaBundle[];
  projectKey?: string;
}) {
  if (projectKey !== "awp") {
    return (
      <div className="rounded-md border border-[var(--border)] p-8 text-center text-[var(--muted)]">
        No personas configured for this project yet.
      </div>
    );
  }
  if (personas.length === 0) {
    return (
      <div className="rounded-md border border-[var(--border)] p-8 text-center text-[var(--muted)]">
        No agent directories found on disk. Run the mirror step to populate{" "}
        <code>agents/awp-test-1..7/</code>.
      </div>
    );
  }

  const totalFindings = personas.reduce(
    (acc, p) => acc + p.audit.findings.length,
    0
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4 text-sm text-[var(--muted)]">
        <p>
          Seven autonomous test agents that exercise AWP end-to-end. Each has
          its own wallet, on-disk identity, and role in the swarm.
        </p>
        <span className="shrink-0 text-xs">
          Audit:{" "}
          {totalFindings === 0 ? (
            <span className="text-emerald-400">all clean</span>
          ) : (
            <span className="text-red-400">
              {totalFindings} finding{totalFindings === 1 ? "" : "s"} across{" "}
              {personas.filter((p) => !p.audit.clean).length} agents
            </span>
          )}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {personas.map((p) => (
          <PersonaCard key={p.agent.name} agent={p.agent} audit={p.audit} />
        ))}
      </div>
    </div>
  );
}
