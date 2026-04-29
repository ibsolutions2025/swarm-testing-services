"use client";

import { useState } from "react";
import type { Axis } from "@/lib/onboarding-patches";

type Props = {
  axes: Axis[];
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
};

export function MatrixEditor({ axes, onPatch }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftAxis, setDraftAxis] = useState<Axis>({ name: "", description: "", source_param: "", values: [] });

  async function emitPatch(label: string, patch: Record<string, unknown>) {
    setBusy(label);
    try {
      await onPatch(patch);
    } finally {
      setBusy(null);
    }
  }

  async function removeAxis(name: string) {
    if (!confirm(`Remove axis "${name}"? This stages a removal patch — engine output stays untouched until greenlight.`)) return;
    await emitPatch(`remove:${name}`, { op: "remove_axis", axisName: name });
  }

  async function editAxisValues(axisName: string, csv: string) {
    const values = csv.split(",").map((s) => s.trim()).filter(Boolean);
    if (!values.length) return;
    await emitPatch(`edit:${axisName}`, { op: "edit_axis", axisName, fields: { values } });
  }

  async function editAxisDescription(axisName: string, description: string) {
    await emitPatch(`desc:${axisName}`, { op: "edit_axis", axisName, fields: { description } });
  }

  async function submitAdd() {
    if (!draftAxis.name.trim()) return;
    await emitPatch(`add:${draftAxis.name}`, { op: "add_axis", axis: { ...draftAxis } });
    setAdding(false);
    setDraftAxis({ name: "", description: "", source_param: "", values: [] });
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Matrix axes</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {axes.length} axes. Edits are staged as patches and applied at greenlight.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-md border border-zinc-800 px-3 py-1 text-sm text-zinc-100 hover:bg-white/5"
          disabled={adding}
        >
          + Add axis
        </button>
      </header>

      {adding && (
        <div className="rounded-md border border-accent/40 bg-accent/5 p-4">
          <h3 className="text-sm font-medium text-zinc-100">New axis</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Field label="Name" value={draftAxis.name} onChange={(v) => setDraftAxis({ ...draftAxis, name: v })} />
            <Field label="Source param" value={draftAxis.source_param ?? ""} onChange={(v) => setDraftAxis({ ...draftAxis, source_param: v })} />
          </div>
          <Field label="Description" value={draftAxis.description ?? ""} onChange={(v) => setDraftAxis({ ...draftAxis, description: v })} />
          <Field label="Values (comma-separated)" value={(draftAxis.values || []).join(", ")} onChange={(v) => setDraftAxis({ ...draftAxis, values: v.split(",").map((s) => s.trim()).filter(Boolean) })} />
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={submitAdd} disabled={!draftAxis.name.trim() || !!busy} className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50">
              {busy === `add:${draftAxis.name}` ? "Adding…" : "Add"}
            </button>
            <button type="button" onClick={() => { setAdding(false); setDraftAxis({ name: "", description: "", source_param: "", values: [] }); }} className="rounded-md border border-zinc-800 px-3 py-1 text-sm text-zinc-300 hover:bg-white/5">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {axes.length === 0 && <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-[var(--muted)]">No axes yet.</div>}
        {axes.map((axis) => (
          <div key={axis.name} className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-mono text-zinc-100">{axis.name}</h3>
                  {axis.source_param && <span className="text-xs text-[var(--muted)]">source: {axis.source_param}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeAxis(axis.name)}
                disabled={busy === `remove:${axis.name}`}
                className="rounded-md border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/20 disabled:opacity-50"
              >
                {busy === `remove:${axis.name}` ? "…" : "Remove"}
              </button>
            </div>
            <Field
              label="Description"
              value={axis.description ?? ""}
              onChange={(v) => editAxisDescription(axis.name, v)}
              busy={busy === `desc:${axis.name}`}
              debounce
            />
            <Field
              label="Values (comma-separated)"
              value={(axis.values || []).join(", ")}
              onChange={(v) => editAxisValues(axis.name, v)}
              busy={busy === `edit:${axis.name}`}
              debounce
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, busy, debounce }: { label: string; value: string; onChange: (v: string) => void; busy?: boolean; debounce?: boolean }) {
  const [localValue, setLocalValue] = useState(value);
  // Keep local in sync if parent value changes (e.g. after a successful patch reload)
  if (localValue !== value && !busy) {
    // best-effort sync — only updates when local hasn't been edited away from value
  }
  return (
    <label className="mt-3 block">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <input
        type="text"
        defaultValue={value}
        onBlur={(e) => {
          const v = e.target.value;
          setLocalValue(v);
          if (debounce && v === value) return;
          onChange(v);
        }}
        disabled={busy}
        className="mt-1 w-full rounded-md border border-zinc-800 bg-black px-2 py-1 text-sm text-zinc-100 disabled:opacity-50"
      />
    </label>
  );
}
