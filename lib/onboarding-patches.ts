/**
 * onboarding-patches.ts — apply HITL edit patches to engine baseline state.
 *
 * Each onboarding_edits row carries a target ('matrix' | 'scenarios' |
 * 'rules-backlog') and a patch_json describing one logical edit. This
 * module replays them in created_at order to produce the post-apply state.
 *
 * Same logic backs:
 *  - the editor UI (live preview as the customer makes edits)
 *  - the cutover-preview API (Checkpoint 3 diff)
 *  - greenlight (C.7) — applies patches before copying to canonical lib/
 *
 * Patch shapes (one row = one logical edit):
 *
 *   target='matrix':
 *     { op: 'add_axis',         axis: Axis }
 *     { op: 'remove_axis',      axisName: string }
 *     { op: 'edit_axis',        axisName: string, fields: Partial<Axis> }
 *
 *   target='scenarios':
 *     { op: 'edit_scenario',    scenarioId: string, fields: Partial<Scenario> }
 *
 *   target='rules-backlog':
 *     { op: 'flag_rule',        ruleId: string, reason: string }
 *     { op: 'report_missing',   description: string }
 */

export type Axis = {
  name: string;
  description?: string;
  source_param?: string;
  values: string[];
  maps_to?: Record<string, unknown>;
};

export type Scenario = {
  id: string;
  label: string;
  description: string;
  status: "classifiable" | "aspirational" | "deferred" | "in-flight";
  applicability: string;
  requiredEvents?: string[];
  negativeEvents?: string[];
  terminalState?: Record<string, unknown>;
  notes?: string;
};

export type Rule = {
  id: string;
  fn: string;
  kind: string;
  condition: string;
  errorName: string;
  failureCategory: string;
  failureSubcategory?: string;
  notes?: string;
};

export type RuleFlag = {
  ruleId: string;
  reason: string;
  flaggedAt: string; // ISO timestamp from the edit row
};

export type RuleMissing = {
  description: string;
  reportedAt: string;
};

export type EditRow = {
  id: string;
  target: "matrix" | "scenarios" | "rules-backlog";
  patch_json: Record<string, unknown>;
  note: string | null;
  created_at: string;
};

export type AppliedState = {
  axes: Axis[];
  scenarios: Scenario[];
  rules: Rule[];
  ruleFlags: RuleFlag[];
  ruleMissing: RuleMissing[];
};

export function applyEdits(
  baseline: { axes: Axis[]; scenarios: Scenario[]; rules: Rule[] },
  edits: EditRow[]
): AppliedState {
  const axes: Axis[] = baseline.axes.map((a) => ({ ...a }));
  const scenarios: Scenario[] = baseline.scenarios.map((s) => ({ ...s }));
  const rules = baseline.rules; // read-only — never modified
  const ruleFlags: RuleFlag[] = [];
  const ruleMissing: RuleMissing[] = [];

  for (const e of edits) {
    const p = e.patch_json as Record<string, unknown>;
    const op = String(p.op || "");

    if (e.target === "matrix") {
      if (op === "add_axis") {
        const axis = p.axis as Axis;
        if (axis && axis.name && !axes.find((a) => a.name === axis.name)) {
          axes.push({ ...axis });
        }
      } else if (op === "remove_axis") {
        const axisName = String(p.axisName || "");
        const idx = axes.findIndex((a) => a.name === axisName);
        if (idx >= 0) axes.splice(idx, 1);
      } else if (op === "edit_axis") {
        const axisName = String(p.axisName || "");
        const fields = (p.fields as Partial<Axis>) || {};
        const idx = axes.findIndex((a) => a.name === axisName);
        if (idx >= 0) axes[idx] = { ...axes[idx], ...fields };
      }
    } else if (e.target === "scenarios") {
      if (op === "edit_scenario") {
        const scenarioId = String(p.scenarioId || "");
        const fields = (p.fields as Partial<Scenario>) || {};
        const idx = scenarios.findIndex((s) => s.id === scenarioId);
        if (idx >= 0) scenarios[idx] = { ...scenarios[idx], ...fields };
      }
    } else if (e.target === "rules-backlog") {
      if (op === "flag_rule") {
        ruleFlags.push({
          ruleId: String(p.ruleId || ""),
          reason: String(p.reason || ""),
          flaggedAt: e.created_at,
        });
      } else if (op === "report_missing") {
        ruleMissing.push({
          description: String(p.description || ""),
          reportedAt: e.created_at,
        });
      }
    }
  }

  return { axes, scenarios, rules, ruleFlags, ruleMissing };
}

/**
 * Compute a human-readable diff summary between baseline and applied state.
 * Used by cutover-preview API to show "what would change" before greenlight.
 */
export type DiffSummary = {
  matrix: {
    addedAxes: string[];
    removedAxes: string[];
    modifiedAxes: { name: string; fieldsChanged: string[] }[];
  };
  scenarios: {
    modified: { id: string; fieldsChanged: string[] }[];
  };
  rules: {
    flaggedCount: number;
    missingReportedCount: number;
  };
};

export function computeDiff(
  baseline: { axes: Axis[]; scenarios: Scenario[] },
  applied: AppliedState
): DiffSummary {
  const baseAxisNames = new Set(baseline.axes.map((a) => a.name));
  const appliedAxisNames = new Set(applied.axes.map((a) => a.name));

  const addedAxes = [...appliedAxisNames].filter((n) => !baseAxisNames.has(n));
  const removedAxes = [...baseAxisNames].filter((n) => !appliedAxisNames.has(n));
  const modifiedAxes: DiffSummary["matrix"]["modifiedAxes"] = [];
  for (const baseAxis of baseline.axes) {
    if (!appliedAxisNames.has(baseAxis.name)) continue;
    const appliedAxis = applied.axes.find((a) => a.name === baseAxis.name)!;
    const changed: string[] = [];
    if ((baseAxis.description || "") !== (appliedAxis.description || "")) changed.push("description");
    if ((baseAxis.source_param || "") !== (appliedAxis.source_param || "")) changed.push("source_param");
    if (JSON.stringify(baseAxis.values) !== JSON.stringify(appliedAxis.values)) changed.push("values");
    if (JSON.stringify(baseAxis.maps_to || {}) !== JSON.stringify(appliedAxis.maps_to || {})) changed.push("maps_to");
    if (changed.length) modifiedAxes.push({ name: baseAxis.name, fieldsChanged: changed });
  }

  const modifiedScenarios: DiffSummary["scenarios"]["modified"] = [];
  for (const baseScen of baseline.scenarios) {
    const appliedScen = applied.scenarios.find((s) => s.id === baseScen.id);
    if (!appliedScen) continue;
    const changed: string[] = [];
    if (baseScen.label !== appliedScen.label) changed.push("label");
    if (baseScen.description !== appliedScen.description) changed.push("description");
    if (baseScen.status !== appliedScen.status) changed.push("status");
    if (baseScen.applicability !== appliedScen.applicability) changed.push("applicability");
    if (JSON.stringify(baseScen.notes ?? null) !== JSON.stringify(appliedScen.notes ?? null)) changed.push("notes");
    if (changed.length) modifiedScenarios.push({ id: baseScen.id, fieldsChanged: changed });
  }

  return {
    matrix: { addedAxes, removedAxes, modifiedAxes },
    scenarios: { modified: modifiedScenarios },
    rules: {
      flaggedCount: applied.ruleFlags.length,
      missingReportedCount: applied.ruleMissing.length,
    },
  };
}
