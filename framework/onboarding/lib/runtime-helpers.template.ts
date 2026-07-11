// runtime-helpers.ts
//
// AUTO-INJECTED by the Phase C.7 greenlight cutover (lib/cutover-render.ts).
// Lives at lib/<slug>-<userShort>/runtime-helpers.ts inside every greenlit
// lib. The lib's index.ts re-exports the 4 functions HLO daemon imports:
//
//   parseConfigKey, configToParams, isCellApplicable, checkAgentEligibility
//
// This is the E.4 Path B fix: the engine emits structured data (AXES with
// maps_to, ALL_SCENARIOS with applicability strings, RULES) but doesn't
// emit the runtime helpers HLO walks that data with. The fixture
// (lib/awp/) hand-writes equivalent helpers tailored to AWP semantics;
// the engine output gets these GENERIC helpers stitched in at greenlight.
//
// Pure functions, no I/O, no closure over module state beyond the lib's
// own exports. Safe to cache.

import { AXES } from "./matrix.js";
import { ALL_SCENARIOS } from "./scenarios.js";

// Both AXES shapes are accepted:
//   engine: AXES = [{ name, source_param, values, maps_to }, ...]
//   fixture: AXES = { axisName: [...values] }   // no maps_to
// Internal helper normalizes to engine-style. Uses `any` to bridge the
// two shapes since the cast is genuinely heterogeneous.
function normalizeAxes(): Array<{ name: string; values: readonly string[]; maps_to?: Record<string, Record<string, unknown>> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a: any = AXES;
  if (Array.isArray(a)) return a;
  return Object.entries(a as Record<string, readonly string[]>).map(([name, values]) => ({ name, values }));
}

/**
 * parseConfigKey(key) — split a hyphenated config key into a typed params
 * object. Walks AXES one axis at a time, longest-match-first to handle
 * values that themselves contain hyphens ("approved-list", "rating-gate").
 *
 * For each matched axis value, merges the axis's maps_to[value] (if any)
 * so the returned object includes the V15 createJob params alongside the
 * raw axis name → value pairs.
 *
 * Throws if the key shape doesn't match AXES (defensive — caller should
 * only pass keys from ALL_CONFIGS).
 */
export function parseConfigKey(key: string): Record<string, unknown> {
  const axes = normalizeAxes();
  let remaining = key;
  const params: Record<string, unknown> = {};

  for (const axis of axes) {
    let matched: string | null = null;
    // Sort longest-first so "approved-list" wins over "approved" if both existed.
    const sortedValues = [...axis.values].sort((a, b) => b.length - a.length);
    for (const v of sortedValues) {
      if (remaining === v || remaining.startsWith(v + "-")) { matched = v; break; }
    }
    if (matched === null) {
      throw new Error(`parseConfigKey: no value of axis "${axis.name}" matches remaining="${remaining}" (key=${key})`);
    }
    params[axis.name] = matched;
    if (axis.maps_to && axis.maps_to[matched]) {
      Object.assign(params, axis.maps_to[matched]);
    }
    remaining = remaining === matched ? "" : remaining.slice(matched.length + 1);
  }

  if (remaining !== "") {
    throw new Error(`parseConfigKey: trailing "${remaining}" after walking all axes (key=${key})`);
  }
  return params;
}

/**
 * configToParams(key) — alias for parseConfigKey on engine-shaped libs
 * (where AXES.maps_to is the source of V15 param mapping). The fixture
 * has a separate hand-coded configToParams that derives V15 fields via
 * if/else logic; this generic version reads them from data.
 */
export function configToParams(key: string): Record<string, unknown> {
  return parseConfigKey(key);
}

/**
 * isCellApplicable(configParams, scenarioId) — does the scenario apply to
 * this cell? Evaluates the scenario's applicability expression as a
 * restricted boolean predicate over configParams.
 *
 * Applicability strings come from engine output (LLM-derived) or HITL
 * edits (customer-typed). They reference V15 param names like
 * `validationMode`, `submissionMode`, `allowResubmission`. The parser only
 * accepts identifiers, literals, comparisons, parentheses, and boolean
 * operators. Unsupported syntax fails closed.
 *
 * Common identifier substitutions (HARD_ONLY → 0, etc.) are applied as a
 * fallback if the first eval throws on an undefined reference.
 */
const APPLICABILITY_ENUMS: Record<string, string | number | boolean> = {
  HARD_ONLY: 0,
  SOFT_ONLY: 1,
  HARD_THEN_SOFT: 2,
  HARDSIFT: 2,
  FCFS: 0,
  TIMED: 1,
  true: true,
  false: false,
};

function stripOuterParens(value: string): string {
  let expr = value.trim();
  while (expr.startsWith("(") && expr.endsWith(")")) {
    let depth = 0;
    let wrapsAll = true;
    let quote = "";
    for (let i = 0; i < expr.length; i++) {
      const char = expr[i];
      if (quote) {
        if (char === "\\") i++;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (depth === 0 && i < expr.length - 1) { wrapsAll = false; break; }
      if (depth < 0) throw new Error("unbalanced applicability expression");
    }
    if (!wrapsAll || depth !== 0 || quote) break;
    expr = expr.slice(1, -1).trim();
  }
  return expr;
}

function splitTopLevel(expr: string, operator: "||" | "&&"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const char = expr[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    if (depth < 0) throw new Error("unbalanced applicability expression");
    if (depth === 0 && expr.slice(i, i + 2) === operator) {
      parts.push(expr.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  if (depth !== 0 || quote) throw new Error("invalid applicability expression");
  if (parts.length) parts.push(expr.slice(start));
  return parts;
}

function resolveApplicabilityValue(token: string, params: Record<string, unknown>): unknown {
  const value = stripOuterParens(token);
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\([\\'\"])/g, "$1");
  }
  if (Object.prototype.hasOwnProperty.call(APPLICABILITY_ENUMS, value)) return APPLICABILITY_ENUMS[value];
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && Object.prototype.hasOwnProperty.call(params, value)) {
    return params[value];
  }
  throw new Error("unsupported applicability operand");
}

function safeEvaluateApplicability(expression: string, params: Record<string, unknown>): boolean {
  const expr = stripOuterParens(expression);
  const orParts = splitTopLevel(expr, "||");
  if (orParts.length) return orParts.some((part) => safeEvaluateApplicability(part, params));
  const andParts = splitTopLevel(expr, "&&");
  if (andParts.length) return andParts.every((part) => safeEvaluateApplicability(part, params));
  if (expr.startsWith("!")) return !safeEvaluateApplicability(expr.slice(1), params);

  const comparison = expr.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!comparison) return Boolean(resolveApplicabilityValue(expr, params));
  const left = resolveApplicabilityValue(comparison[1], params);
  const right = resolveApplicabilityValue(comparison[3], params);
  switch (comparison[2]) {
    case "===": case "==": return left === right;
    case "!==": case "!=": return left !== right;
    case ">": return typeof left === "number" && typeof right === "number" && left > right;
    case "<": return typeof left === "number" && typeof right === "number" && left < right;
    case ">=": return typeof left === "number" && typeof right === "number" && left >= right;
    case "<=": return typeof left === "number" && typeof right === "number" && left <= right;
    default: return false;
  }
}

export function isCellApplicable(configParams: Record<string, unknown>, scenarioId: string): boolean {
  const scenario = ALL_SCENARIOS.find((s: { id: string }) => s.id === scenarioId);
  if (!scenario) return false;
  const applicability = (scenario as { applicability?: string }).applicability;
  if (!applicability || applicability === "any" || applicability === "") return true;

  // Build a closure that evaluates the expression with configParams in scope.
  // `with` is reachable here because runtime-helpers.ts compiles to ES2022
  // (per tsconfig.lib.json) which permits `with` in non-strict mode. We wrap
  // the body in a try/catch + retry-with-enum-substitution.
  const tryEval = (expr: string): boolean => {
    return safeEvaluateApplicability(expr, configParams);
  };

  try {
    return tryEval(applicability);
  } catch {
    // Common AWP enum names referenced in applicability text — substitute and retry.
    const substituted = applicability
      .replace(/\bHARD_ONLY\b/g, "0")
      .replace(/\bSOFT_ONLY\b/g, "1")
      .replace(/\bHARD_THEN_SOFT\b/g, "2")
      .replace(/\bHARDSIFT\b/g, "2")
      .replace(/\bFCFS\b/g, "0")
      .replace(/\bTIMED\b/g, "1");
    try { return tryEval(substituted); } catch { return false; }
  }
}

/**
 * checkAgentEligibility(agent, job, action) — does this agent have the
 * preconditions to perform `action`? Returns a structured result so the
 * caller can surface failure reasons.
 *
 * Universal gates implemented (mirroring fixture):
 *   - V4 review-gate cap (pending reviews ≥ 5 blocks all but submit_review)
 *   - Low ETH warning (non-blocking)
 *
 * Action-specific gates encoded in the engine's RULES are NOT executed
 * here because RULES.condition is human-readable (e.g. "msg.sender !=
 * job.poster") not executable. HLO's caller does additional gates
 * (USDC balance, role separation) inline; this helper covers the
 * universal-and-cheap subset. The fixture's hand-coded version covers
 * more action-specific gates; a future iteration could compile RULES
 * conditions to predicates.
 */
export function checkAgentEligibility(
  agent: { pendingReviewCount?: number; ethWei?: bigint } | null,
  _job: unknown,
  action: string,
  options: { reviewGateMaxPending?: number } = {}
): { eligible: boolean; reasons: Array<{ ruleId: string; condition: string; errorName: string }>; warnings: string[] } {
  const reasons: Array<{ ruleId: string; condition: string; errorName: string }> = [];
  const warnings: string[] = [];
  const cap = options.reviewGateMaxPending ?? 5;

  if (action !== "submit_review" && agent && (agent.pendingReviewCount ?? 0) >= cap) {
    reasons.push({
      ruleId:
        action === "create_job" ? "V4.isBlocked.cap"
        : action === "claim_validator" ? "V4.isBlocked.cap"
        : action === "submit_work" ? "V4.isBlocked.cap"
        : "V4.isBlocked.cap",
      condition: `pendingReviewCount(${agent.pendingReviewCount}) < ${cap}`,
      errorName: "ReviewGate: too many pending reviews",
    });
  }

  if (agent && typeof agent.ethWei === "bigint" && agent.ethWei < 200_000_000_000_000n) {
    warnings.push(`low ETH: ${(Number(agent.ethWei) / 1e18).toFixed(6)}`);
  }

  return { eligible: reasons.length === 0, reasons, warnings };
}
