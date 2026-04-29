"use client";

import { useMemo, useState } from "react";
import type { Rule, RuleFlag, RuleMissing } from "@/lib/onboarding-patches";

type Props = {
  rules: Rule[];
  flags: RuleFlag[];
  missing: RuleMissing[];
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
};

export function RulesBacklog({ rules, flags, missing, onPatch }: Props) {
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [missingDraft, setMissingDraft] = useState("");

  const flagsByRuleId = useMemo(() => {
    const m = new Map<string, RuleFlag[]>();
    for (const f of flags) {
      if (!m.has(f.ruleId)) m.set(f.ruleId, []);
      m.get(f.ruleId)!.push(f);
    }
    return m;
  }, [flags]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rules;
    return rules.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.fn.toLowerCase().includes(q) ||
        r.errorName.toLowerCase().includes(q) ||
        (r.condition || "").toLowerCase().includes(q)
    );
  }, [rules, search]);

  async function emit(label: string, patch: Record<string, unknown>) {
    setBusy(label);
    try { await onPatch(patch); } finally { setBusy(null); }
  }

  async function flagRule(ruleId: string) {
    const reason = prompt(`Flag rule "${ruleId}" — why? (e.g., "wrong condition", "doesn't exist in source")`);
    if (!reason || !reason.trim()) return;
    await emit(`flag:${ruleId}`, { op: "flag_rule", ruleId, reason: reason.trim() });
  }

  async function reportMissing() {
    const text = missingDraft.trim();
    if (!text) return;
    await emit("missing:new", { op: "report_missing", description: text });
    setMissingDraft("");
  }

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-semibold text-zinc-100">Rules backlog</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {rules.length} rules emitted by the engine. Flag any that are wrong; submit any the engine missed.
          Rules themselves are read-only — flags are tracked on the side and surfaced in the cutover diff.
        </p>
      </header>

      {(flags.length > 0 || missing.length > 0) && (
        <div className="rounded-md border border-amber-900/40 bg-amber-950/10 p-3 text-sm">
          <h3 className="font-medium text-amber-200">Backlog so far</h3>
          {flags.length > 0 && (
            <div className="mt-2">
              <div className="text-xs uppercase tracking-widest text-amber-300/70">Flagged ({flags.length})</div>
              <ul className="mt-1 space-y-0.5 text-zinc-200">
                {flags.map((f, i) => (
                  <li key={i}>
                    <code className="text-amber-200">{f.ruleId}</code> — {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {missing.length > 0 && (
            <div className="mt-3">
              <div className="text-xs uppercase tracking-widest text-amber-300/70">Reported missing ({missing.length})</div>
              <ul className="mt-1 space-y-0.5 text-zinc-200">
                {missing.map((m, i) => (
                  <li key={i}>· {m.description}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
        <h3 className="text-sm font-medium text-zinc-100">Report a rule the engine missed</h3>
        <textarea
          rows={2}
          value={missingDraft}
          onChange={(e) => setMissingDraft(e.target.value)}
          placeholder="e.g. createJob should require validationInstructions to be valid JSON, not just non-empty"
          className="mt-2 w-full rounded-md border border-zinc-800 bg-black px-2 py-1 text-sm text-zinc-100"
        />
        <button
          type="button"
          onClick={reportMissing}
          disabled={!missingDraft.trim() || busy === "missing:new"}
          className="mt-2 rounded-md bg-accent px-3 py-1 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
        >
          {busy === "missing:new" ? "Submitting…" : "Submit"}
        </button>
      </div>

      <div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search rules by id, fn, errorName, or condition…"
          className="w-full rounded-md border border-zinc-800 bg-black px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600"
        />
      </div>

      <div className="space-y-2">
        {filtered.map((r) => {
          const flagsForRule = flagsByRuleId.get(r.id) || [];
          return (
            <div key={r.id} className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <code className="text-sm text-zinc-100">{r.id}</code>
                  <div className="mt-0.5 text-xs text-[var(--muted)]">
                    {r.fn} · {r.kind} · errors: <code className="text-zinc-300">{r.errorName}</code>
                  </div>
                  <div className="mt-1 font-mono text-xs text-zinc-400">{r.condition}</div>
                  {flagsForRule.length > 0 && (
                    <div className="mt-1 text-xs text-amber-300">
                      flagged {flagsForRule.length}× — {flagsForRule.map((f) => f.reason).join("; ")}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => flagRule(r.id)}
                  disabled={busy === `flag:${r.id}`}
                  className="rounded-md border border-amber-900/60 px-2 py-1 text-xs text-amber-200 hover:bg-amber-950/20 disabled:opacity-50"
                >
                  Flag
                </button>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-[var(--muted)]">
            No rules match.
          </div>
        )}
      </div>
    </div>
  );
}
