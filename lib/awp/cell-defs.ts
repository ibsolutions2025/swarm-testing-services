// lib/awp/cell-defs.ts
//
// Per-scenario predicate functions. Phase B requires the predicate set to be
// DISJOINT (no two predicates match the same terminal lifecycle) and
// EXHAUSTIVE (every terminal lifecycle matches at least one).
//
// The verifier (framework/verifier.mjs) calls classifyTerminal(ctx) to map an
// observed terminal-state job to its observed scenario. PRIORITY-based
// first-match-wins is preserved as a fallback for ambiguous edge cases, but
// the predicates below are tightened so the priority order rarely matters.
//
// Source: clients/.shared/PHASE-B-VERIFIER-SPEC.md § "Disjoint + exhaustive"

import type { ConfigParams } from "./matrix.js";
import type { DecodedEvent } from "./events.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface JobView {
  id: number;
  poster: `0x${string}`;
  status: number;            // 0=Open 1=Active 2=Completed 3=Cancelled
  activeValidator: `0x${string}`;
  validationMode: number;    // 0=HARD_ONLY 1=SOFT_ONLY 2=HARD_THEN_SOFT
  submissionMode: number;    // 0=FCFS 1=TIMED
  submissionWindow: number;
  submissionDeadline: number;
  allowResubmission: boolean;
  allowRejectAll: boolean;
  approvedWorkers: `0x${string}`[];
  minWorkerRating: number;
  minValidatorRating: number;
  openValidation: boolean;
  title?: string;
  description?: string;
  requirementsJson?: string;
}

export interface SubmissionView {
  worker: `0x${string}`;
  deliverableUrl: string;
  timestamp: number;
  status: number;            // 0=pending 1=approved 2=rejected 3=not_selected
  scriptPassed: boolean;
  scriptScore: number;
}

export interface ClassificationCounts {
  approved: number;
  rejected: number;
  pending: number;
  notSel: number;
  distinctWorkers: number;
  distinctValidators: number;
  all_rejected: boolean;
}

// A minimal tx attempt record (filled by indexer; consumed by negative-scenario
// predicates). The verifier still does the heavy lifting; this is a small
// summary so a quick predicate can detect "this lifecycle had a reverted gate".
export interface TxAttemptSummary {
  intended_action: string;
  actor: string;
  outcome: "success" | "reverted" | "pending" | "timeout";
  revert_reason: string | null;
}

export interface ClassificationContext {
  job: JobView;
  submissions: SubmissionView[];
  events: Record<string, DecodedEvent[]>;
  counts: ClassificationCounts;
  configParams: ConfigParams;
  txAttempts?: TxAttemptSummary[];
}

export type ScenarioPredicate = (ctx: ClassificationContext) => boolean;

// ============================================================================
// Disjoint+exhaustive predicates.
//
// Each predicate returns true ONLY when the terminal lifecycle uniquely
// matches that scenario. Tightening notes per Phase B spec § disjoint:
//
//   s01 — happy-path: status=2, approved=1, rejected=0, distinctWorkers=1,
//         vc<=1, NO rating gates set (those go to s12), NOT
//         AllSubmissionsRejected, NOT validator-first ordering.
//   s02 — validator-first: validator-claim BEFORE work-submitted AND single
//         validator (waitlist disqualifies → s06). Excluded for HARD_ONLY.
//   s03 — competitive-workers: distinct workers >= 2, no rejection (s04).
//   s04 — rejection-loop: rejected >= 1 AND approved == 1.
//   s05 — total-rejection: AllSubmissionsRejected emitted, no JobCancelled.
//   s06 — validator-waitlist: distinct ValidatorClaimed >= 2.
//   s07 — validator-rotation: ValidatorRotated event present.
//   s08 — worker-no-show: status=Cancelled, zero submissions.
//   s09 — validator-no-show: status=Cancelled, submissions present, zero VC.
//   s10 — reject-all-cancel: AllSubmissionsRejected then JobCancelled.
//   s11 — deadline-expiry: TimedJobFinalized with valid winnerIndex.
//   s12 — rating-gate-pass: rating-gated config + completed (steals from s01).
//   s13 — rating-gate-fail: tx_attempts.outcome=reverted with RatingGateFailed.
//   s14 — rating-gate-new-user: same as s13 (V15 maps both to RatingGateFailed).
//   s15 — approved-not-approved: tx_attempts revert with NotApproved*.
//   s16 — multiple-submissions: same worker submits >= 2.
//   s17 — hard-validation-auto: HARD_ONLY + ScriptResultRecorded(true) + auto.
//   s18 — hard-then-soft: HARDSIFT + script pass before validator-claim.
// ============================================================================

function vcCount(c: ClassificationContext): number {
  return c.events.ValidatorClaimed?.length ?? 0;
}
function wsCount(c: ClassificationContext): number {
  return c.events.WorkSubmitted?.length ?? 0;
}
function sarCount(c: ClassificationContext): number {
  return c.events.AllSubmissionsRejected?.length ?? 0;
}
function jcCount(c: ClassificationContext): number {
  return c.events.JobCancelled?.length ?? 0;
}
function srrCount(c: ClassificationContext): number {
  return c.events.ScriptResultRecorded?.length ?? 0;
}
function vrCount(c: ClassificationContext): number {
  return c.events.ValidatorRotated?.length ?? 0;
}
function tjfCount(c: ClassificationContext): number {
  return c.events.TimedJobFinalized?.length ?? 0;
}

function hasRatingGate(p: ConfigParams): boolean {
  return p.minWorkerRating > 0 || p.minValidatorRating > 0;
}

function distinctValidators(c: ClassificationContext): number {
  const claims = c.events.ValidatorClaimed ?? [];
  const set = new Set<string>();
  for (const e of claims) {
    if (e.validator) set.add(e.validator.toLowerCase());
  }
  return set.size || claims.length;
}

function hasReverted(c: ClassificationContext, action: string, errorIncludes: string[]): boolean {
  if (!c.txAttempts) return false;
  return c.txAttempts.some(t =>
    t.outcome === "reverted" &&
    t.intended_action === action &&
    !!t.revert_reason &&
    errorIncludes.some(needle => (t.revert_reason ?? "").includes(needle))
  );
}

export const PREDICATES: Record<string, ScenarioPredicate> = {
  // --- Negative scenarios (driven by tx_attempts.outcome=reverted) ---
  // These come FIRST in priority to claim revert lifecycles before any
  // positive scenario can match.
  "s13-rating-gate-fail": (c) =>
    hasRatingGate(c.configParams) &&
    hasReverted(c, "submitWork", ["RatingGateFailed", "rating below threshold"]),

  "s14-rating-gate-new-user": (c) =>
    hasRatingGate(c.configParams) &&
    hasReverted(c, "submitWork", ["RatingGateFailed", "reviewCount", "new user"]),

  "s15-approved-not-approved": (c) =>
    (c.configParams.needsApprovedWorkers || c.configParams.needsApprovedValidators) &&
    (
      hasReverted(c, "submitWork", ["NotApprovedWorker"]) ||
      hasReverted(c, "claimJobAsValidator", ["NotApprovedValidator"])
    ),

  // --- Cancelled-state scenarios (status=3) ---
  "s08-worker-no-show": (c) =>
    c.job.status === 3 &&
    c.submissions.length === 0 &&
    wsCount(c) === 0,

  "s09-validator-no-show": (c) =>
    c.job.status === 3 &&
    c.submissions.length >= 1 &&
    vcCount(c) === 0 &&
    c.configParams.validationMode !== 0,

  "s10-reject-all-cancel": (c) => {
    const ar = c.events.AllSubmissionsRejected?.[0];
    const jc = c.events.JobCancelled?.[0];
    return Boolean(ar && jc && ar.blockNumber <= jc.blockNumber && c.job.status === 3);
  },

  // --- Active-state non-terminal (s05 stays Active per V15 C1) ---
  "s05-total-rejection": (c) =>
    sarCount(c) > 0 &&
    jcCount(c) === 0 &&
    c.counts.all_rejected === true,

  // --- Completed-state scenarios (status=2) ---
  "s11-deadline-expiry": (c) =>
    c.job.status === 2 &&
    tjfCount(c) > 0 &&
    c.configParams.validationMode === 0 &&
    c.configParams.submissionMode === 1,

  "s06-validator-waitlist": (c) =>
    (c.job.status === 2 || c.job.status === 3) &&
    distinctValidators(c) >= 2 &&
    c.configParams.validationMode !== 0 &&
    c.configParams.openValidation === true,

  "s07-validator-rotation": (c) =>
    (c.job.status === 2 || c.job.status === 3) &&
    vrCount(c) > 0 &&
    c.configParams.validationMode !== 0,

  "s17-hard-validation-auto": (c) =>
    c.job.status === 2 &&
    c.configParams.validationMode === 0 &&
    srrCount(c) > 0 &&
    vcCount(c) === 0,

  "s18-hard-then-soft": (c) => {
    if (c.job.status !== 2) return false;
    if (c.configParams.validationMode !== 2) return false;
    const srr = c.events.ScriptResultRecorded?.[0];
    const vc = c.events.ValidatorClaimed?.[0];
    if (!srr || !vc) return false;
    return srr.blockNumber <= vc.blockNumber;
  },

  "s04-rejection-loop": (c) =>
    c.job.status === 2 &&
    c.counts.rejected >= 1 &&
    c.counts.approved === 1 &&
    c.configParams.validationMode !== 0 &&
    c.configParams.allowResubmission,

  "s16-multiple-submissions": (c) =>
    c.job.status === 2 &&
    c.counts.approved === 1 &&
    c.submissions.length >= 2 &&
    c.counts.distinctWorkers === 1 &&
    c.configParams.allowResubmission &&
    c.configParams.validationMode !== 0,

  "s03-competitive-workers": (c) =>
    c.job.status === 2 &&
    c.counts.distinctWorkers >= 2 &&
    c.counts.approved === 1 &&
    c.counts.rejected === 0,

  "s02-validator-first": (c) => {
    if (c.job.status !== 2) return false;
    if (c.configParams.validationMode === 0) return false;
    const vc = c.events.ValidatorClaimed;
    const ws = c.events.WorkSubmitted;
    if (!vc?.length || !ws?.length) return false;
    if (distinctValidators(c) >= 2) return false;
    if (c.counts.distinctWorkers >= 2) return false;
    if (c.counts.rejected > 0) return false;
    return vc[0].blockNumber < ws[0].blockNumber && c.counts.approved === 1;
  },

  "s12-rating-gate-pass": (c) =>
    c.job.status === 2 &&
    hasRatingGate(c.configParams) &&
    c.counts.approved === 1 &&
    c.counts.rejected === 0 &&
    c.counts.distinctWorkers === 1 &&
    sarCount(c) === 0,

  // s01 catch-all — happy path AFTER the more-specific predicates have had a
  // chance. Tightened so it doesn't steal s12 (rating-gated cells) or s02
  // (validator-first ordering).
  "s01-happy-path": (c) => {
    if (c.job.status !== 2) return false;
    if (c.counts.approved !== 1) return false;
    if (c.counts.rejected !== 0) return false;
    if (c.counts.distinctWorkers !== 1) return false;
    if (vcCount(c) > 1) return false;
    if (wsCount(c) !== 1) return false;
    if (hasRatingGate(c.configParams)) return false; // s12 territory
    if (sarCount(c) > 0) return false;               // s05/s10 territory
    // validator-first ordering (s02) — exclude when validator claim block precedes first work
    const vc = c.events.ValidatorClaimed;
    const ws = c.events.WorkSubmitted;
    if (vc?.[0] && ws?.[0] && vc[0].blockNumber < ws[0].blockNumber) return false;
    return true;
  },
};

/**
 * Priority order for first-match-wins fallback. Negative scenarios first
 * (revert lifecycles bypass positive matching), then strictest positive
 * predicates, then catch-alls.
 */
export const PRIORITY: string[] = [
  "s13-rating-gate-fail",
  "s14-rating-gate-new-user",
  "s15-approved-not-approved",
  "s10-reject-all-cancel",
  "s05-total-rejection",
  "s08-worker-no-show",
  "s09-validator-no-show",
  "s11-deadline-expiry",
  "s07-validator-rotation",
  "s06-validator-waitlist",
  "s17-hard-validation-auto",
  "s18-hard-then-soft",
  "s04-rejection-loop",
  "s16-multiple-submissions",
  "s03-competitive-workers",
  "s02-validator-first",
  "s12-rating-gate-pass",
  "s01-happy-path",
];

/**
 * Run predicates in priority order. Returns the first matching scenario id
 * or `s00-in-flight` if no terminal predicate matches but the job is still
 * Open or Active. Returns `unclassified` if the job is in a terminal state
 * (Completed/Cancelled) but no predicate matched — this is a signal that
 * cell-defs needs a new predicate.
 */
export function classify(ctx: ClassificationContext): string {
  const matches = classifyAllMatches(ctx);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Multiple matches — first in PRIORITY wins, but the verifier will log
    // this as a disjointness violation.
    return matches[0];
  }
  if (ctx.job.status === 2 || ctx.job.status === 3) return "unclassified";
  return "s00-in-flight";
}

/**
 * Returns ALL scenario IDs whose predicate matches. Used by the verifier to
 * detect non-disjoint predicates (length > 1 means a bug).
 */
export function classifyAllMatches(ctx: ClassificationContext): string[] {
  const out: string[] = [];
  for (const key of PRIORITY) {
    const pred = PREDICATES[key];
    try {
      if (pred(ctx)) out.push(key);
    } catch {
      /* missing field — skip */
    }
  }
  return out;
}

/**
 * Compute counts from a list of submissions.
 */
export function computeCounts(submissions: SubmissionView[]): ClassificationCounts {
  return {
    approved: submissions.filter((s) => s.status === 1).length,
    rejected: submissions.filter((s) => s.status === 2).length,
    pending:  submissions.filter((s) => s.status === 0).length,
    notSel:   submissions.filter((s) => s.status === 3).length,
    distinctWorkers: new Set(submissions.map((s) => s.worker.toLowerCase())).size,
    distinctValidators: 0, // populated by callers from events
    all_rejected:
      submissions.length > 0 && submissions.every((s) => s.status === 2),
  };
}

// ============================================================================
// Cell applicability — (config, scenario) tuples.
// ============================================================================

export interface CellKey {
  configKey: string;
  scenarioId: string;
}

export function isCellApplicable(configParams: ConfigParams, scenarioId: string): boolean {
  const isHardOnly = configParams.validationMode === 0;
  const isSoftOnly = configParams.validationMode === 1;
  const isTimed = configParams.submissionMode === 1;

  switch (scenarioId) {
    case "s00-in-flight":
    case "s01-happy-path":
    case "s03-competitive-workers":
      return true;

    case "s02-validator-first":
      return !isHardOnly;

    case "s04-rejection-loop":
      return !isHardOnly && configParams.allowResubmission;

    case "s05-total-rejection":
    case "s10-reject-all-cancel":
      return isSoftOnly && configParams.allowRejectAll;

    case "s06-validator-waitlist":
      return !isHardOnly && configParams.openValidation;

    case "s07-validator-rotation":
      return !isHardOnly;

    case "s08-worker-no-show":
      return isTimed;

    case "s09-validator-no-show":
      return isTimed && !isHardOnly;

    case "s11-deadline-expiry":
      return isTimed && isHardOnly;

    case "s12-rating-gate-pass":
    case "s13-rating-gate-fail":
    case "s14-rating-gate-new-user":
      return configParams.minWorkerRating > 0 || configParams.minValidatorRating > 0;

    case "s15-approved-not-approved":
      return configParams.needsApprovedWorkers || configParams.needsApprovedValidators;

    case "s16-multiple-submissions":
      return configParams.allowResubmission && !isHardOnly;

    case "s17-hard-validation-auto":
      return isHardOnly && !isTimed;
    case "s18-hard-then-soft":
      return configParams.validationMode === 2;
    case "s19-hard-script-retry":
    case "s20-hard-script-fail":
      return isHardOnly;

    default:
      return false;
  }
}

export function applicableScenarios(configParams: ConfigParams, scenarioIds: string[]): string[] {
  return scenarioIds.filter((id) => isCellApplicable(configParams, id));
}
