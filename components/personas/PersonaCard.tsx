"use client";

import { useState } from "react";
import { BASESCAN_BASE } from "@/lib/awp-contracts";
import type { AgentDoc } from "@/lib/agents-fs";
import type { AuditReport } from "@/lib/insider-audit";

type TabKey = "soul" | "identity" | "user" | "audit";

function short(addr: string | null): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function PersonaCard({
  agent,
  audit
}: {
  agent: AgentDoc;
  audit: AuditReport;
}) {
  const [tab, setTab] = useState<TabKey>("soul");

  const badgeClass = audit.clean
    ? "bg-emerald-900/20 text-emerald-400 border-emerald-700"
    : "bg-red-900/20 text-red-400 border-red-700";
  const badgeLabel = audit.clean
    ? "✓ No insider info"
    : `✗ ${audit.findings.length} finding${audit.findings.length === 1 ? "" : "s"}`;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-lg font-semibold text-zinc-100">
              {agent.persona}
            </h3>
            <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-400">
              {agent.name}
            </span>
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            {agent.wallet ? (
              <a
                href={`${BASESCAN_BASE}/address/${agent.wallet}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
              >
                {short(agent.wallet)} ↗
              </a>
            ) : (
              <span className="italic text-zinc-600">no wallet on file</span>
            )}
            {agent.model && (
              <>
                <span className="mx-2 text-zinc-700">·</span>
                <span>{agent.model}</span>
              </>
            )}
            {agent.missing.length > 0 && (
              <>
                <span className="mx-2 text-zinc-700">·</span>
                <span
                  className="text-amber-400"
                  title={`Missing: ${agent.missing.join(", ")}`}
                >
                  scrubbed ({agent.missing.length})
                </span>
              </>
            )}
          </div>
        </div>
        <button
          onClick={() => setTab("audit")}
          className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${badgeClass}`}
          title="Open insider-info audit"
        >
          {badgeLabel}
        </button>
      </div>

      <div className="mt-4 flex items-center gap-1 border-b border-zinc-800 text-sm">
        {(
          [
            ["soul", "SOUL"],
            ["identity", "IDENTITY"],
            ["user", "USER"],
            ["audit", "Audit"]
          ] as Array<[TabKey, string]>
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`relative px-3 py-2 transition-colors ${
              tab === k
                ? "text-zinc-100"
                : "text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {label}
            {tab === k && (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-accent" />
            )}
          </button>
        ))}
      </div>

      <div className="mt-4 min-h-[140px] text-sm">
        {tab === "soul" && <DocView content={agent.soul_md} empty="SOUL.md not on disk (scrubbed)." />}
        {tab === "identity" && (
          <DocView content={agent.identity_md} empty="IDENTITY.md not on disk." />
        )}
        {tab === "user" && <DocView content={agent.user_md} empty="USER.md not on disk." />}
        {tab === "audit" && <AuditView audit={audit} />}
      </div>
    </div>
  );
}

function DocView({ content, empty }: { content: string; empty: string }) {
  if (!content.trim()) {
    return <p className="text-xs italic text-zinc-600">{empty}</p>;
  }
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-300">
      {content}
    </pre>
  );
}

function AuditView({ audit }: { audit: AuditReport }) {
  if (audit.clean) {
    return (
      <div className="rounded border border-emerald-700 bg-emerald-900/10 p-3">
        <p className="text-sm text-emerald-400">
          ✓ No insider-info leakage detected.
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          Scanned SOUL.md and USER.md for scenario IDs, expected outcomes,
          validation-mode keywords, and assertion references.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-400">
        {audit.findings.length} potential leak
        {audit.findings.length === 1 ? "" : "s"}. These would bias the swarm
        if left in place.
      </p>
      <ul className="space-y-1 text-xs">
        {audit.findings.map((f, i) => (
          <li
            key={i}
            className="rounded border border-red-900/40 bg-red-900/10 p-2"
          >
            <div className="flex flex-wrap items-center gap-x-2 font-mono text-red-300">
              <span>{f.file}:{f.line}</span>
              <span className="rounded bg-red-900/40 px-1 text-[10px] uppercase">
                {f.pattern}
              </span>
              <span className="text-red-400">matched "{f.match}"</span>
            </div>
            <div className="mt-1 font-mono text-zinc-400">{f.snippet}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
