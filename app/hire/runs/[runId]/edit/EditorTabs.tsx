"use client";

import { useCallback, useEffect, useState } from "react";
import { MatrixEditor } from "@/components/MatrixEditor";
import { ScenarioCardEditor } from "@/components/ScenarioCardEditor";
import { RulesBacklog } from "@/components/RulesBacklog";
import {
  applyEdits,
  type Axis,
  type Scenario,
  type Rule,
  type EditRow,
  type AppliedState,
} from "@/lib/onboarding-patches";

type DataResponse = {
  runId: string;
  slug: string | null;
  status: string;
  baseline: { axes: Axis[]; scenarios: Scenario[]; rules: Rule[] };
  edits: EditRow[];
  auditDoc: string | null;
};

type CutoverPreview = {
  runId: string;
  slug: string;
  editCount: number;
  diff: {
    matrix: { addedAxes: string[]; removedAxes: string[]; modifiedAxes: { name: string; fieldsChanged: string[] }[] };
    scenarios: { modified: { id: string; fieldsChanged: string[] }[] };
    rules: { flaggedCount: number; missingReportedCount: number };
  };
  applied: { axisCount: number; scenarioCount: number; ruleCount: number; ruleFlagCount: number; ruleMissingCount: number };
  cutoverTarget: { libPath: string; clientsPath: string; userShort: string };
};

type Tab = "matrix" | "scenarios" | "rules" | "cutover";

export function EditorTabs({ runId }: { runId: string }) {
  const [tab, setTab] = useState<Tab>("matrix");
  const [data, setData] = useState<DataResponse | null>(null);
  const [preview, setPreview] = useState<CutoverPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/onboarding/data/${encodeURIComponent(runId)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [runId]);

  const refreshPreview = useCallback(async () => {
    try {
      const r = await fetch(`/api/onboarding/cutover-preview/${encodeURIComponent(runId)}`);
      const j = await r.json();
      if (r.ok) setPreview(j);
    } catch { /* preview is optional */ }
  }, [runId]);

  useEffect(() => {
    refresh();
    refreshPreview();
  }, [refresh, refreshPreview]);

  const onPatch = useCallback(
    async (patch: Record<string, unknown>) => {
      const target =
        tab === "matrix" ? "matrix" :
        tab === "scenarios" ? "scenarios" :
        "rules-backlog";
      const r = await fetch("/api/onboarding/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, target, patch_json: patch }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      setSavedAt(new Date().toISOString());
      // Re-fetch data + preview so the UI reflects the new state.
      await refresh();
      await refreshPreview();
    },
    [runId, tab, refresh, refreshPreview]
  );

  if (error) {
    return (
      <div className="rounded-md border border-red-900 bg-red-950/30 p-4 text-sm text-red-200">
        Failed to load: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-[var(--muted)]">Loading…</div>;
  }

  // Apply customer edits to baseline to derive the live state shown in each editor.
  const applied: AppliedState = applyEdits(data.baseline, data.edits);

  return (
    <div>
      <nav className="mb-5 flex gap-1 border-b border-zinc-800">
        {([
          ["matrix", "Matrix"],
          ["scenarios", "Scenarios"],
          ["rules", "Rules backlog"],
          ["cutover", "Cutover preview"],
        ] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={
              "rounded-t-md border-b-2 px-3 py-2 text-sm " +
              (tab === id
                ? "border-accent text-zinc-100"
                : "border-transparent text-[var(--muted)] hover:text-zinc-200")
            }
          >
            {label}
          </button>
        ))}
        <div className="ml-auto self-center pr-2 text-xs text-[var(--muted)]">
          {savedAt ? `last saved: ${new Date(savedAt).toLocaleTimeString()}` : `${data.edits.length} edit${data.edits.length === 1 ? "" : "s"} stored`}
        </div>
      </nav>

      {tab === "matrix" && <MatrixEditor axes={applied.axes} onPatch={onPatch} />}
      {tab === "scenarios" && <ScenarioCardEditor scenarios={applied.scenarios} onPatch={onPatch} />}
      {tab === "rules" && (
        <RulesBacklog
          rules={applied.rules}
          flags={applied.ruleFlags}
          missing={applied.ruleMissing}
          onPatch={onPatch}
        />
      )}
      {tab === "cutover" && <CutoverView preview={preview} onRefresh={refreshPreview} />}
    </div>
  );
}

function CutoverView({ preview, onRefresh }: { preview: CutoverPreview | null; onRefresh: () => Promise<void> }) {
  if (!preview) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-[var(--muted)]">
          Loading preview…
        </div>
        <button type="button" onClick={onRefresh} className="text-sm text-accent hover:underline">refresh</button>
      </div>
    );
  }
  const { diff, applied, cutoverTarget, editCount } = preview;
  const empty =
    diff.matrix.addedAxes.length === 0 &&
    diff.matrix.removedAxes.length === 0 &&
    diff.matrix.modifiedAxes.length === 0 &&
    diff.scenarios.modified.length === 0 &&
    diff.rules.flaggedCount === 0 &&
    diff.rules.missingReportedCount === 0;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-sm font-semibold text-zinc-100">What greenlight will do</h2>
        <div className="mt-2 space-y-1 text-sm text-[var(--muted)]">
          <div>Copy from <code className="text-zinc-300">runs/{preview.runId}/output/</code> with {editCount} edit{editCount === 1 ? "" : "s"} applied →</div>
          <div className="ml-4">→ <code className="text-zinc-300">{cutoverTarget.libPath}</code> ({applied.axisCount} axes, {applied.scenarioCount} scenarios, {applied.ruleCount} rules)</div>
          <div className="ml-4">→ <code className="text-zinc-300">{cutoverTarget.clientsPath}</code></div>
          <div className="mt-2">User-short namespace: <code className="text-zinc-300">{cutoverTarget.userShort}</code></div>
        </div>
      </div>

      {empty ? (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-[var(--muted)]">
          No customer edits staged. Greenlight would copy engine output as-is.
        </div>
      ) : (
        <div className="space-y-3">
          {(diff.matrix.addedAxes.length > 0 || diff.matrix.removedAxes.length > 0 || diff.matrix.modifiedAxes.length > 0) && (
            <DiffBlock title="Matrix">
              {diff.matrix.addedAxes.map((n) => <DiffLine key={`add:${n}`} sigil="+" text={`add axis "${n}"`} tone="add" />)}
              {diff.matrix.removedAxes.map((n) => <DiffLine key={`rm:${n}`} sigil="−" text={`remove axis "${n}"`} tone="remove" />)}
              {diff.matrix.modifiedAxes.map((m) => <DiffLine key={`mod:${m.name}`} sigil="~" text={`edit axis "${m.name}" — ${m.fieldsChanged.join(", ")}`} tone="modify" />)}
            </DiffBlock>
          )}
          {diff.scenarios.modified.length > 0 && (
            <DiffBlock title="Scenarios">
              {diff.scenarios.modified.map((m) => <DiffLine key={`scen:${m.id}`} sigil="~" text={`edit ${m.id} — ${m.fieldsChanged.join(", ")}`} tone="modify" />)}
            </DiffBlock>
          )}
          {(diff.rules.flaggedCount > 0 || diff.rules.missingReportedCount > 0) && (
            <DiffBlock title="Rules">
              {diff.rules.flaggedCount > 0 && <DiffLine sigil="!" text={`${diff.rules.flaggedCount} rule${diff.rules.flaggedCount === 1 ? "" : "s"} flagged`} tone="modify" />}
              {diff.rules.missingReportedCount > 0 && <DiffLine sigil="!" text={`${diff.rules.missingReportedCount} missing-rule report${diff.rules.missingReportedCount === 1 ? "" : "s"} (will be appended to AUDIT-AND-DESIGN.md)`} tone="modify" />}
            </DiffBlock>
          )}
        </div>
      )}

      <div className="rounded-md border border-blue-900/40 bg-blue-950/10 p-4 text-sm">
        <h3 className="font-medium text-blue-200">Greenlight is C.7</h3>
        <p className="mt-1 text-blue-100/80">
          Greenlight (the &quot;Start swarm&quot; button) is shipped in C.7 — coming next. For now, this preview shows
          what greenlight will do once it lands. Isaiah greenlights the cutover at C.7, not here.
        </p>
      </div>
    </div>
  );
}

function DiffBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="text-xs uppercase tracking-widest text-[var(--muted)]">{title}</div>
      <div className="mt-2 space-y-1">{children}</div>
    </div>
  );
}

function DiffLine({ sigil, text, tone }: { sigil: string; text: string; tone: "add" | "remove" | "modify" }) {
  const cls =
    tone === "add" ? "text-emerald-300" :
    tone === "remove" ? "text-red-300" :
    "text-amber-300";
  return (
    <div className={"font-mono text-sm " + cls}>
      <span className="mr-2">{sigil}</span>
      <span>{text}</span>
    </div>
  );
}
