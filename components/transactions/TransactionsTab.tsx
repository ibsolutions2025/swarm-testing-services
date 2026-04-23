"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AWP_JOBNFT,
  BASESCAN_BASE
} from "@/lib/awp-contracts";
import {
  LIFECYCLE_STATUSES,
  RUN_OUTCOME_COLORS,
  type LifecycleStatus
} from "@/lib/constants";
import type {
  LifecycleListResponse,
  LifecycleResult,
  LifecycleStep
} from "@/lib/lifecycle-types";

const POLL_MS = 30_000;

function short(addr: string | null | undefined): string {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatRel(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (isNaN(d)) return "—";
  const diff = Date.now() - d;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function extractAgentWallets(
  agentWallets: LifecycleResult["agent_wallets"]
): string[] {
  if (!agentWallets) return [];
  if (Array.isArray(agentWallets)) {
    return agentWallets.filter((s): s is string => typeof s === "string");
  }
  const out: string[] = [];
  if (agentWallets.poster) out.push(agentWallets.poster);
  if (agentWallets.worker) out.push(agentWallets.worker);
  if (agentWallets.validator) out.push(agentWallets.validator);
  if (agentWallets.actor_map && typeof agentWallets.actor_map === "object") {
    for (const v of Object.values(agentWallets.actor_map)) {
      if (typeof v === "string") out.push(v);
    }
  }
  return Array.from(new Set(out));
}

function statusBadgeClass(status: string): string {
  const c =
    RUN_OUTCOME_COLORS[status] ?? "bg-zinc-500/20 border-zinc-400/30";
  return `inline-flex rounded-full border px-2.5 py-0.5 text-xs ${c}`;
}

interface Filters {
  statuses: Set<string>;
  configKey: string | null;
  scenarioKey: string | null;
  search: string;
}

function parseFilters(params: URLSearchParams): Filters {
  const status = params.get("status");
  const statuses = new Set<string>(
    status
      ? status
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []
  );
  return {
    statuses,
    configKey: params.get("config") || null,
    scenarioKey: params.get("scenario") || null,
    search: params.get("q") || ""
  };
}

function serializeFilters(f: Filters, debug?: boolean): string {
  const p = new URLSearchParams();
  if (f.statuses.size) p.set("status", Array.from(f.statuses).join(","));
  if (f.configKey) p.set("config", f.configKey);
  if (f.scenarioKey) p.set("scenario", f.scenarioKey);
  if (f.search) p.set("q", f.search);
  void debug;
  return p.toString();
}

export function TransactionsTab({ projectKey }: { projectKey: "awp" }) {
  void projectKey;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [response, setResponse] = useState<LifecycleListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LifecycleResult | null>(null);

  const filters = useMemo(
    () => parseFilters(new URLSearchParams(searchParams.toString())),
    [searchParams]
  );

  const setFilters = useCallback(
    (next: Filters) => {
      const qs = serializeFilters(next);
      // Preserve path, replace query only.
      router.replace(
        qs ? `${window.location.pathname}?${qs}` : window.location.pathname,
        { scroll: false }
      );
    },
    [router]
  );

  // Fetch + poll.
  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const res = await fetch(
          "/api/test-results/lifecycle?limit=5000",
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body: LifecycleListResponse = await res.json();
        if (cancelled) return;
        setResponse(body);
        setError(null);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Failed to load transactions");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchOnce();
    const t = setInterval(fetchOnce, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const results = response?.results ?? [];
  const tableMissing = response?.table_missing === true;

  const configOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of results) s.add(r.config_key);
    return Array.from(s).sort();
  }, [results]);

  const scenarioOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of results) s.add(r.scenario_key);
    return Array.from(s).sort();
  }, [results]);

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return results.filter((r) => {
      if (filters.statuses.size && !filters.statuses.has(r.status))
        return false;
      if (filters.configKey && r.config_key !== filters.configKey)
        return false;
      if (filters.scenarioKey && r.scenario_key !== filters.scenarioKey)
        return false;
      if (q) {
        const wallets = extractAgentWallets(r.agent_wallets);
        const hay = [
          r.run_id,
          r.onchain_job_id?.toString(),
          ...wallets
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [results, filters]);

  const counts = useMemo(() => {
    const base: Record<string, number> = { total: 0 };
    for (const s of LIFECYCLE_STATUSES) base[s] = 0;
    for (const r of results) {
      base.total++;
      if (base[r.status] !== undefined) base[r.status]++;
      else base[r.status] = 1;
    }
    return base;
  }, [results]);

  if (tableMissing) {
    return (
      <div className="rounded-md border border-[var(--border)] p-8 text-center">
        <div className="text-3xl">⏳</div>
        <p className="mt-3 text-sm text-[var(--muted)]">
          STS <code>lifecycle_results</code> table not provisioned yet.
        </p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Rows will appear here within 15 minutes of the scanner's next run.
        </p>
      </div>
    );
  }

  if (loading && !response) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-[var(--muted)]">
        Loading transactions…
      </div>
    );
  }

  if (error && !response) {
    return (
      <div className="rounded-md border border-red-500/40 p-4 text-sm text-red-300">
        {error}
      </div>
    );
  }

  return (
    <div>
      {/* Aggregate counters */}
      <div className="grid grid-cols-3 gap-3 md:grid-cols-7">
        <CounterCard label="Total" value={counts.total} />
        {LIFECYCLE_STATUSES.map((s) => (
          <CounterCard
            key={s}
            label={s}
            value={counts[s] || 0}
            tone={s as LifecycleStatus}
          />
        ))}
      </div>

      {/* Filter bar */}
      <div className="mt-6 flex flex-wrap items-end gap-3 rounded-md border border-[var(--border)] p-3">
        <div className="flex flex-wrap gap-1.5">
          {LIFECYCLE_STATUSES.map((s) => {
            const on = filters.statuses.has(s);
            return (
              <button
                key={s}
                onClick={() => {
                  const next = new Set(filters.statuses);
                  if (on) next.delete(s);
                  else next.add(s);
                  setFilters({ ...filters, statuses: next });
                }}
                className={`rounded-full border px-2.5 py-1 text-xs capitalize transition-colors ${
                  on
                    ? RUN_OUTCOME_COLORS[s] ?? "bg-white/10 border-white/20"
                    : "border-[var(--border)] text-[var(--muted)] hover:text-white"
                }`}
              >
                {s}
              </button>
            );
          })}
        </div>

        <select
          value={filters.configKey ?? ""}
          onChange={(e) =>
            setFilters({ ...filters, configKey: e.target.value || null })
          }
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs"
        >
          <option value="">All configs</option>
          {configOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={filters.scenarioKey ?? ""}
          onChange={(e) =>
            setFilters({ ...filters, scenarioKey: e.target.value || null })
          }
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs"
        >
          <option value="">All scenarios</option>
          {scenarioOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={filters.search}
          onChange={(e) =>
            setFilters({ ...filters, search: e.target.value })
          }
          placeholder="wallet 0x… or job id"
          className="min-w-[200px] flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs"
        />

        <div className="ml-auto flex items-center gap-2 text-xs text-[var(--muted)]">
          <span>
            {filtered.length} of {results.length} rows
          </span>
          {(filters.statuses.size > 0 ||
            filters.configKey ||
            filters.scenarioKey ||
            filters.search) && (
            <button
              onClick={() =>
                setFilters({
                  statuses: new Set(),
                  configKey: null,
                  scenarioKey: null,
                  search: ""
                })
              }
              className="rounded border border-[var(--border)] px-2 py-1 hover:text-white"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-md border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white/5 text-xs uppercase tracking-widest text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Cell</th>
              <th className="px-4 py-3 text-left font-medium">On-chain Job</th>
              <th className="px-4 py-3 text-left font-medium">Agent wallet</th>
              <th className="px-4 py-3 text-right font-medium">Steps</th>
              <th className="px-4 py-3 text-right font-medium">Created</th>
              <th className="px-4 py-3 text-right font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-[var(--muted)]"
                >
                  No transactions match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const wallets = extractAgentWallets(r.agent_wallets);
                return (
                  <tr
                    key={r.id}
                    onClick={() => setSelected(r)}
                    className="cursor-pointer border-t border-[var(--border)] transition-colors hover:bg-white/5"
                  >
                    <td className="px-4 py-3">
                      <span className={statusBadgeClass(r.status)}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-white">{r.config_key}</span>
                      <span className="text-[var(--muted)]"> × </span>
                      <span className="text-[var(--muted)]">
                        {r.scenario_key}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {r.onchain_job_id ? (
                        <a
                          href={`${BASESCAN_BASE}/token/${AWP_JOBNFT}?a=${r.onchain_job_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-blue-400 hover:text-blue-300 hover:underline"
                        >
                          #{r.onchain_job_id} ↗
                        </a>
                      ) : (
                        <span className="text-[var(--muted)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {wallets[0] ? (
                        <a
                          href={`${BASESCAN_BASE}/address/${wallets[0]}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-blue-400 hover:text-blue-300 hover:underline"
                        >
                          {short(wallets[0])}
                        </a>
                      ) : (
                        <span className="text-[var(--muted)]">—</span>
                      )}
                      {wallets.length > 1 && (
                        <span className="ml-1 text-xs text-[var(--muted)]">
                          +{wallets.length - 1}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--muted)]">
                      {r.steps?.length ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--muted)]">
                      {formatRel(r.started_at)}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--muted)]">
                      {formatRel(r.updated_at ?? r.completed_at)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer */}
      {selected && (
        <TransactionDrawer
          result={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function CounterCard({
  label,
  value,
  tone
}: {
  label: string;
  value: number;
  tone?: LifecycleStatus;
}) {
  return (
    <div className="rounded-md border border-[var(--border)] p-3">
      <div
        className={`text-[10px] uppercase tracking-widest ${
          tone ? "" : "text-[var(--muted)]"
        }`}
      >
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function TransactionDrawer({
  result,
  onClose
}: {
  result: LifecycleResult;
  onClose: () => void;
}) {
  const wallets = extractAgentWallets(result.agent_wallets);
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/60"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-[var(--border)] bg-[#0b0b0c]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={statusBadgeClass(result.status)}>
                {result.status}
              </span>
              <AuditStatusPill cellAudit={result.cell_audit} />
              <span className="font-mono text-xs text-[var(--muted)]">
                {result.run_id}
              </span>
            </div>
            <h3 className="mt-2 break-words text-sm">
              <span className="text-white">{result.config_key}</span>
              <span className="text-[var(--muted)]"> × </span>
              <span className="text-[var(--muted)]">{result.scenario_key}</span>
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--muted)] hover:text-white"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* On-chain job */}
          <section>
            <h4 className="text-xs uppercase tracking-widest text-[var(--muted)]">
              On-chain Job
            </h4>
            {result.onchain_job_id ? (
              <a
                href={`${BASESCAN_BASE}/token/${AWP_JOBNFT}?a=${result.onchain_job_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 hover:underline"
              >
                JobNFT #{result.onchain_job_id} ↗
              </a>
            ) : (
              <p className="mt-2 text-xs italic text-[var(--muted)]">
                No on-chain job tied to this run.
              </p>
            )}
          </section>

          {/* Roles */}
          <RolesSection wallets={result.wallets} />

          {/* All wallets touched (catch-all, de-duped against roles) */}
          {(() => {
            const roleSet = new Set(collectRoleAddresses(result.wallets));
            const extras = wallets.filter((w) => !roleSet.has(w.toLowerCase()));
            return (
              <section>
                <h4 className="text-xs uppercase tracking-widest text-[var(--muted)]">
                  All Wallets Touched
                </h4>
                {wallets.length === 0 ? (
                  <p className="mt-2 text-xs italic text-[var(--muted)]">
                    No agent wallets recorded.
                  </p>
                ) : extras.length === 0 ? (
                  <p className="mt-2 text-xs italic text-[var(--muted)]">
                    All labeled above.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1 text-xs">
                    {extras.map((w) => (
                      <li key={w}>
                        <a
                          href={`${BASESCAN_BASE}/address/${w}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
                        >
                          {w} ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })()}

          {/* Steps */}
          <section>
            <h4 className="text-xs uppercase tracking-widest text-[var(--muted)]">
              Steps ({result.steps?.length ?? 0})
            </h4>
            {(!result.steps || result.steps.length === 0) && (
              <p className="mt-2 text-xs italic text-[var(--muted)]">
                No steps recorded yet.
              </p>
            )}
            {result.steps && result.steps.length > 0 && (
              <ol className="mt-3 space-y-2">
                {result.steps.map((s, i) => {
                  const audit = Array.isArray(result.step_audits)
                    ? (result.step_audits as any[])[i]
                    : undefined;
                  return <StepRow key={i} step={s} audit={audit} />;
                })}
              </ol>
            )}
          </section>

          {/* Error */}
          {result.error_message && (
            <section className="rounded border border-red-900/40 bg-red-900/10 p-3">
              <h4 className="text-xs uppercase tracking-widest text-red-400">
                Error
              </h4>
              <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-red-300">
                {result.error_message}
              </p>
            </section>
          )}

          {/* cell_audit — terminal summary + JSON */}
          {result.cell_audit !== null && result.cell_audit !== undefined && (
            <section className="rounded border border-[var(--border)] p-3">
              <h4 className="text-xs uppercase tracking-widest text-[var(--muted)]">
                Cell audit
              </h4>
              <CellAuditSummary cellAudit={result.cell_audit} />
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-[var(--muted)] hover:text-white">
                  Raw JSON
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 font-mono text-[11px] text-zinc-300">
                  {JSON.stringify(result.cell_audit, null, 2)}
                </pre>
              </details>
            </section>
          )}

          {result.step_audits !== null && result.step_audits !== undefined && (
            <details className="rounded border border-[var(--border)] p-3">
              <summary className="cursor-pointer text-xs uppercase tracking-widest text-[var(--muted)]">
                Step audits
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 font-mono text-[11px] text-zinc-300">
                {JSON.stringify(result.step_audits, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </aside>
    </div>
  );
}

function StepRow({
  step,
  audit
}: {
  step: LifecycleStep;
  audit?: { onchain_confirmed?: boolean } | null;
}) {
  const tx = (step.details as any)?.txHash;
  const blockNumber = (step.details as any)?.blockNumber;
  const confirmed = audit?.onchain_confirmed;
  return (
    <li className="rounded border border-[var(--border)] p-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[var(--muted)]">#{step.step}</span>
        <span className="font-medium">{step.name}</span>
        <span className={statusBadgeClass(step.status)}>{step.status}</span>
        {confirmed === true && (
          <span className="rounded-full border border-emerald-400/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300">
            ⛓ confirmed
          </span>
        )}
        {confirmed === false && (
          <span className="rounded-full border border-red-400/40 bg-red-500/20 px-2 py-0.5 text-[10px] text-red-300">
            ⚠ not confirmed
          </span>
        )}
        {typeof step.duration_ms === "number" && step.duration_ms > 0 && (
          <span className="text-[var(--muted)]">
            {step.duration_ms}ms
          </span>
        )}
      </div>
      {tx && typeof tx === "string" && (
        <div className="mt-1 font-mono">
          <a
            href={`${BASESCAN_BASE}/tx/${tx}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 hover:underline"
          >
            tx {short(tx)} ↗
          </a>
          {typeof blockNumber === "number" && (
            <span className="ml-2 text-[var(--muted)]">
              block {blockNumber}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

// ──────────────────────────────────────────────────────────────
// Drawer helpers (Track 2 + 3)
// ──────────────────────────────────────────────────────────────

function AuditStatusPill({ cellAudit }: { cellAudit: unknown }) {
  const audited = cellAudit !== null && cellAudit !== undefined;
  if (audited) {
    return (
      <span className="inline-flex rounded-full border border-emerald-400/40 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
        Audited ✓
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
      Audit pending
    </span>
  );
}

function collectRoleAddresses(wallets: LifecycleResult["wallets"]): string[] {
  if (!wallets || typeof wallets !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(wallets)) {
    if (k === "actor_map") continue;
    if (typeof v === "string" && v.startsWith("0x")) {
      out.push(v.toLowerCase());
    } else if (v && typeof v === "object" && "address" in (v as object)) {
      const a = (v as any).address;
      if (typeof a === "string") out.push(a.toLowerCase());
    }
  }
  return out;
}

function RolesSection({ wallets }: { wallets: LifecycleResult["wallets"] }) {
  if (!wallets || typeof wallets !== "object") return null;

  const rows: Array<{ label: string; addr: string }> = [];
  const pushAddr = (label: string, v: unknown) => {
    if (typeof v === "string" && v.startsWith("0x")) {
      rows.push({ label, addr: v });
    } else if (v && typeof v === "object" && "address" in (v as object)) {
      const a = (v as any).address;
      if (typeof a === "string") rows.push({ label, addr: a });
    }
  };

  // Canonical roles first (title-cased).
  const CANON = ["poster", "worker", "validator", "employer"];
  for (const k of CANON) {
    if ((wallets as any)[k]) {
      pushAddr(k.charAt(0).toUpperCase() + k.slice(1), (wallets as any)[k]);
    }
  }
  // Any other string-valued role keys.
  for (const [k, v] of Object.entries(wallets)) {
    if (CANON.includes(k) || k === "actor_map") continue;
    if (typeof v === "string" && v.startsWith("0x")) {
      pushAddr(k.charAt(0).toUpperCase() + k.slice(1), v);
    }
  }

  if (rows.length === 0) return null;

  return (
    <section>
      <h4 className="text-xs uppercase tracking-widest text-[var(--muted)]">
        Roles
      </h4>
      <ul className="mt-2 space-y-1 text-xs">
        {rows.map((r, i) => (
          <RoleRow key={`${r.label}-${i}`} label={r.label} addr={r.addr} />
        ))}
      </ul>
    </section>
  );
}

function RoleRow({ label, addr }: { label: string; addr: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className="w-20 text-[var(--muted)]">{label}:</span>
      <a
        href={`${BASESCAN_BASE}/address/${addr}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-blue-400 hover:text-blue-300 hover:underline"
      >
        {short(addr)} ↗
      </a>
    </li>
  );
}

function CellAuditSummary({ cellAudit }: { cellAudit: unknown }) {
  if (!cellAudit || typeof cellAudit !== "object") return null;
  const a = cellAudit as Record<string, any>;
  const terminal: string | undefined = a.terminal_status;
  const confirmed: number | undefined = a.confirmed_steps ?? a.steps_confirmed;
  const total: number | undefined = a.total_steps ?? a.steps_total;

  if (!terminal) return null;
  const parts: string[] = [];
  if (typeof confirmed === "number" && typeof total === "number") {
    parts.push(`${confirmed}/${total} steps confirmed on-chain`);
  }
  return (
    <p className="mt-2 text-sm text-zinc-200">
      Terminal: <span className="font-medium">{String(terminal)}</span>
      {parts.length > 0 && (
        <span className="text-[var(--muted)]"> ({parts.join(", ")})</span>
      )}
    </p>
  );
}
