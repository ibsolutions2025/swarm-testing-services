/**
 * cutover-render.ts — produce post-applied .ts file contents for C.7 cutover.
 *
 * Strategy: take the engine-emitted file (e.g. matrix.ts) which contains a
 * known JSON-stringified array literal (AXES, ALL_SCENARIOS, RULES), splice
 * in the patched array, leave the rest of the file (header comments,
 * type defs, helper exports) untouched. No regeneration of derived
 * structures — they referenced the same array constant by name and pick
 * up the new content at import time.
 *
 * Used by /api/onboarding/greenlight (C.7). Pure function, no I/O.
 */

import type { Axis, Scenario, RuleFlag, RuleMissing } from "./onboarding-patches";

/**
 * Replace the array body of `export const NAME[: TYPE] = [ ... ];` with a
 * fresh JSON.stringify of `newValue`. Returns the modified source. Throws
 * if the array marker isn't found (defensive — engine always emits these).
 */
export function spliceArrayLiteral(src: string, exportName: string, newValue: unknown): string {
  const re = new RegExp(`export const ${exportName}(?:\\s*:[^=]+)?\\s*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) throw new Error(`spliceArrayLiteral: export const ${exportName} not found`);
  const start = m.index + m[0].length - 1;
  let depth = 0, i = start, inStr = false, strCh: string | null = null, lc = false, bc = false;
  for (; i < src.length; i++) {
    const c = src[i], c2 = src[i + 1] || "";
    if (lc) { if (c === "\n") lc = false; continue; }
    if (bc) { if (c === "*" && c2 === "/") { bc = false; i++; } continue; }
    if (inStr) { if (c === "\\") { i++; continue; } if (c === strCh) { inStr = false; strCh = null; } continue; }
    if (c === "/" && c2 === "/") { lc = true; i++; continue; }
    if (c === "/" && c2 === "*") { bc = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) { i++; break; } }
  }
  // i now points just past the closing ]
  const before = src.slice(0, start);
  const after = src.slice(i);
  const replacement = JSON.stringify(newValue, null, 2);
  return before + replacement + after;
}

/**
 * Generate a markdown appendix listing customer rule-flags + reported-missing
 * from C.5 edits. Appended verbatim to AUDIT-AND-DESIGN.md at greenlight.
 */
export function buildAuditAppendix(
  flags: RuleFlag[],
  missing: RuleMissing[]
): string {
  if (flags.length === 0 && missing.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Customer HITL backlog (added at greenlight)");
  lines.push("");
  lines.push("Customer reviewed the engine output before greenlight. The following items were flagged.");
  lines.push("");

  if (flags.length > 0) {
    lines.push(`### Rule flags (${flags.length})`);
    lines.push("");
    for (const f of flags) {
      lines.push(`- \`${f.ruleId}\` — ${f.reason} _(${f.flaggedAt})_`);
    }
    lines.push("");
  }

  if (missing.length > 0) {
    lines.push(`### Reported missing rules (${missing.length})`);
    lines.push("");
    for (const m of missing) {
      lines.push(`- ${m.description} _(${m.reportedAt})_`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Build the full file-override map for /onboarding/cutover. Given:
 *  - source file contents from VPS /onboarding/result
 *  - applied state (from applyEdits)
 *  - target dir prefixes (libRel, clientsRel)
 * Produces a map of relpath → content for files that need an override.
 * Files that don't need changes are absent — server.mjs copies them
 * verbatim from the source run dir.
 */
export function buildOverrideFiles(
  libContents: Record<string, string>,
  auditDoc: string | null,
  applied: { axes: Axis[]; scenarios: Scenario[]; ruleFlags: RuleFlag[]; ruleMissing: RuleMissing[] },
  libRel: string,
  clientsRel: string
): Record<string, string> {
  const out: Record<string, string> = {};

  // matrix.ts: splice AXES if axes changed (always splice to be safe — small cost)
  if (libContents["matrix.ts"]) {
    out[`${libRel}/matrix.ts`] = spliceArrayLiteral(libContents["matrix.ts"], "AXES", applied.axes);
  }

  // scenarios.ts: splice ALL_SCENARIOS
  if (libContents["scenarios.ts"]) {
    out[`${libRel}/scenarios.ts`] = spliceArrayLiteral(libContents["scenarios.ts"], "ALL_SCENARIOS", applied.scenarios);
  }

  // rules.ts: customer cannot edit rules themselves; the rules-backlog
  // entries land in the audit doc, not rules.ts. So we don't override
  // rules.ts — it gets copied verbatim from source.

  // AUDIT-AND-DESIGN.md: append the customer's HITL backlog if any
  const appendix = buildAuditAppendix(applied.ruleFlags, applied.ruleMissing);
  if (appendix && auditDoc != null) {
    out[`${clientsRel}/AUDIT-AND-DESIGN.md`] = auditDoc + appendix;
  }

  return out;
}
