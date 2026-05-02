// lib/awp/generate-lifecycle.ts
//
// Per-cell lifecycle generator. Given (scenarioId, configKey | ConfigParams),
// returns the structured StepDef[] that a cell-passing job must satisfy.
//
// Each StepDef encodes:
//   - the expected event signature (or expected revert action for negative scenarios)
//   - the actor role (poster | worker | worker1 | worker2 | validator | reviewer | contract)
//   - cardinality constraints
//   - an optional ordering predicate
//   - an args predicate (for filtering matching events)
//
// The verifier (framework/verifier.mjs) consumes a CellLifecycle and checks
// each StepDef against indexed events + tx_attempts.
//
// See clients/.shared/PHASE-B-VERIFIER-SPEC.md for the design contract.

import { parseConfigKey, type ConfigParams } from "./matrix.js";
import { isCellApplicable } from "./cell-defs.js";
import type { EventName } from "./events.js";

// ============================================================================
// Types
// ============================================================================

export type ActorRole =
  | "poster"
  | "worker"
  | "worker1"
  | "worker2"
  | "validator"
  | "validator2"
  | "reviewer"
  | "contract"  // address(0) or contract-self for HARD_ONLY auto-approve
  | "any";      // any wallet (for sweep-style steps)

export type StepKind = "event" | "revert";

export type ContractAction =
  | "createJob"
  | "claimJobAsValidator"
  | "submitWork"
  | "approveSubmission"
  | "rejectSubmission"
  | "rejectAllSubmissions"
  | "cancelJob"
  | "submitReview"
  | "rotateValidator"
  | "finalizeTimedJob"
  | "recordScriptResult";

export interface StepDef {
  index: number;
  name: string;                                       // human-readable description ("worker submits")
  kind: StepKind;

  // For event-required (positive) steps:
  event?: EventName;
  cardinality_min?: number;                           // default 1
  cardinality_max?: number;                           // unbounded if absent
  actor_role?: ActorRole;
  args_predicate?: (args: any) => boolean;
  order_predicate_id?: string;                        // verifier resolves these

  // For revert-required (negative) steps:
  action?: ContractAction;
  expected_actor_role?: ActorRole;
  expected_error?: string;                            // V15/V4 custom error name
}

export interface CellLifecycle {
  config_key: string;
  scenario_id: string;
  applicable: boolean;                                // false when isCellApplicable === false
  steps: StepDef[];
  notes?: string;
}

// ============================================================================
// Helpers — config-driven shape parameters
// ============================================================================

function isHardOnly(p: ConfigParams): boolean { return p.validationMode === 0; }
function isSoftOnly(p: ConfigParams): boolean { return p.validationMode === 1; }
function isHardThenSoft(p: ConfigParams): boolean { return p.validationMode === 2; }
function isTimed(p: ConfigParams): boolean { return p.submissionMode === 1; }

// Per-validationMode review count required by V4 ReviewGate.
// HARD_ONLY: 2 reviews per job (peer-rating on script result)
// SOFT_ONLY / HARD_THEN_SOFT: 5 reviews per job (peer-rating on validator decision)
function reviewCardinality(p: ConfigParams): number {
  return isHardOnly(p) ? 2 : 5;
}

// ============================================================================
// Generator
// ============================================================================

export function generateLifecycle(
  scenarioId: string,
  config: ConfigParams | string,
): CellLifecycle {
  const params = typeof config === "string" ? parseConfigKey(config) : config;
  const configKey = typeof config === "string"
    ? config
    : `${params.valMode}-${params.deadline}-${params.subMode}-${params.workerAccess}-${params.validatorAccess}`;

  const applicable = isCellApplicable(params, scenarioId);
  if (!applicable) {
    return {
      config_key: configKey,
      scenario_id: scenarioId,
      applicable: false,
      steps: [],
      notes: `cell (${configKey}, ${scenarioId}) is not applicable per V15 axis rules`,
    };
  }

  let steps: StepDef[] = [];
  let notes: string | undefined;

  switch (scenarioId) {
    case "s00-in-flight":
      steps = [];
      notes = "in-flight scenarios are NOT verified for terminal correctness";
      break;

    case "s01-happy-path":
      steps = stepsHappyPath(params);
      break;

    case "s02-validator-first":
      steps = stepsValidatorFirst(params);
      break;

    case "s03-competitive-workers":
      steps = stepsCompetitiveWorkers(params);
      break;

    case "s04-rejection-loop":
      steps = stepsRejectionLoop(params);
      break;

    case "s05-total-rejection":
      steps = stepsTotalRejection(params);
      break;

    case "s06-validator-waitlist":
      steps = stepsValidatorWaitlist(params);
      break;

    case "s07-validator-rotation":
      steps = stepsValidatorRotation(params);
      notes = "aspirational — verifier accepts when ValidatorRotated event fires";
      break;

    case "s08-worker-no-show":
      steps = stepsWorkerNoShow(params);
      break;

    case "s09-validator-no-show":
      steps = stepsValidatorNoShow(params);
      break;

    case "s10-reject-all-cancel":
      steps = stepsRejectAllCancel(params);
      break;

    case "s11-deadline-expiry":
      steps = stepsDeadlineExpiry(params);
      notes = "aspirational — TimedJobFinalized winnerIndex must not be max(uint256)";
      break;

    case "s12-rating-gate-pass":
      steps = stepsRatingGatePass(params);
      break;

    case "s13-rating-gate-fail":
      steps = stepsRatingGateFail(params);
      notes = "negative scenario — verified via tx_attempts.outcome=reverted";
      break;

    case "s14-rating-gate-new-user":
      steps = stepsRatingGateNewUser(params);
      notes = "negative scenario — reviewCount<3 triggers gate";
      break;

    case "s15-approved-not-approved":
      steps = stepsApprovedNotApproved(params);
      notes = "negative scenario — non-allowlisted wallet attempts";
      break;

    case "s16-multiple-submissions":
      steps = stepsMultipleSubmissions(params);
      break;

    case "s17-hard-validation-auto":
      steps = stepsHardValidationAuto(params);
      break;

    case "s18-hard-then-soft":
      steps = stepsHardThenSoft(params);
      break;

    case "s19-hard-script-retry":
    case "s20-hard-script-fail":
      steps = [];
      notes = "v16-deferred — V15 doesn't support script retry / no zombie cancel";
      break;

    default:
      steps = [];
      notes = `unknown scenario id "${scenarioId}"`;
  }

  return { config_key: configKey, scenario_id: scenarioId, applicable, steps, notes };
}

// ============================================================================
// Per-scenario step builders
// ============================================================================

function reviewSteps(startIndex: number, params: ConfigParams): StepDef[] {
  const required = reviewCardinality(params);
  return [
    {
      index: startIndex,
      name: `peer-review submissions (${required} required)`,
      kind: "event",
      event: "ReviewSubmitted",
      cardinality_min: required,
      actor_role: "reviewer",
    },
  ];
}

function approveStep(index: number, params: ConfigParams): StepDef {
  if (isHardOnly(params)) {
    return {
      index,
      name: "auto-approve via script",
      kind: "event",
      event: "SubmissionApproved",
      actor_role: "contract",
    };
  }
  return {
    index,
    name: "validator approves",
    kind: "event",
    event: "SubmissionApproved",
    actor_role: "validator",
  };
}

// s01 happy path — config-applicable for any config
function stepsHappyPath(params: ConfigParams): StepDef[] {
  const out: StepDef[] = [];
  let idx = 1;
  out.push({ index: idx++, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" });
  out.push({ index: idx++, name: "worker submits", kind: "event", event: "WorkSubmitted", actor_role: "worker" });

  if (isHardOnly(params)) {
    out.push({
      index: idx++,
      name: "script records pass",
      kind: "event",
      event: "ScriptResultRecorded",
      actor_role: "contract",
      args_predicate: (args: any) => args?.scriptPassed === true || args?.passed === true,
    });
  } else if (isHardThenSoft(params)) {
    out.push({
      index: idx++,
      name: "script passes (precondition for validator)",
      kind: "event",
      event: "ScriptResultRecorded",
      actor_role: "contract",
      args_predicate: (args: any) => args?.scriptPassed === true || args?.passed === true,
      order_predicate_id: "before-validator-claim",
    });
    out.push({ index: idx++, name: "validator claims", kind: "event", event: "ValidatorClaimed", actor_role: "validator" });
  } else {
    // SOFT_ONLY
    out.push({ index: idx++, name: "validator claims", kind: "event", event: "ValidatorClaimed", actor_role: "validator", cardinality_max: 1 });
  }

  out.push(approveStep(idx++, params));
  out.push(...reviewSteps(idx, params));
  return out;
}

// s02 — validator claims BEFORE work is submitted
function stepsValidatorFirst(params: ConfigParams): StepDef[] {
  const out: StepDef[] = [];
  let idx = 1;
  out.push({ index: idx++, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" });
  out.push({
    index: idx++,
    name: "validator claims (before any work)",
    kind: "event",
    event: "ValidatorClaimed",
    actor_role: "validator",
    cardinality_max: 1,
    order_predicate_id: "validator-claim-before-first-work",
  });
  out.push({ index: idx++, name: "worker submits (after validator)", kind: "event", event: "WorkSubmitted", actor_role: "worker" });
  out.push(approveStep(idx++, params));
  out.push(...reviewSteps(idx, params));
  return out;
}

// s03 — multiple distinct workers
function stepsCompetitiveWorkers(params: ConfigParams): StepDef[] {
  const out: StepDef[] = [];
  let idx = 1;
  out.push({ index: idx++, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" });
  out.push({
    index: idx++,
    name: "worker A submits",
    kind: "event",
    event: "WorkSubmitted",
    actor_role: "worker1",
    cardinality_min: 1,
  });
  out.push({
    index: idx++,
    name: "worker B submits (distinct from A)",
    kind: "event",
    event: "WorkSubmitted",
    actor_role: "worker2",
    cardinality_min: 1,
    order_predicate_id: "distinct-worker-from-prev-step",
  });
  if (!isHardOnly(params)) {
    out.push({ index: idx++, name: "validator claims", kind: "event", event: "ValidatorClaimed", actor_role: "validator", cardinality_max: 1 });
  }
  out.push(approveStep(idx++, params));
  out.push(...reviewSteps(idx, params));
  return out;
}

// s04 — at least one rejected, then approved (resubmission flow)
function stepsRejectionLoop(params: ConfigParams): StepDef[] {
  const out: StepDef[] = [];
  let idx = 1;
  out.push({ index: idx++, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" });
  out.push({
    index: idx++,
    name: "first work submission",
    kind: "event",
    event: "WorkSubmitted",
    actor_role: "worker",
    cardinality_min: 1,
  });
  out.push({ index: idx++, name: "validator claims", kind: "event", event: "ValidatorClaimed", actor_role: "validator", cardinality_max: 1 });
  out.push({
    index: idx++,
    name: "validator rejects (at least one)",
    kind: "event",
    event: "SubmissionRejected",
    cardinality_min: 1,
    actor_role: "validator",
    order_predicate_id: "before-final-approve",
  });
  out.push({
    index: idx++,
    name: "later approve",
    kind: "event",
    event: "SubmissionApproved",
    actor_role: "validator",
  });
  out.push(...reviewSteps(idx, params));
  return out;
}

// s05 — AllSubmissionsRejected, no JobCancelled (job stays Active per V15 C1)
function stepsTotalRejection(params: ConfigParams): StepDef[] {
  const out: StepDef[] = [];
  let idx = 1;
  out.push({ index: idx++, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" });
  out.push({
    index: idx++,
    name: "submissions arrive",
    kind: "event",
    event: "WorkSubmitted",
    actor_role: "worker",
    cardinality_min: 1,
  });
  out.push({ index: idx++, name: "validator claims", kind: "event", event: "ValidatorClaimed", actor_role: "validator", cardinality_max: 1 });
  out.push({
    index: idx++,
    name: "validator sweeps with rejectAll",
    kind: "event",
    event: "AllSubmissionsRejected",
    actor_role: "validator",
  });
  return out;
}

// s06 — multiple validators claim (waitlist)
function stepsValidatorWaitlist(params: ConfigParams): StepDef[] {
  const out: StepDef[] = [];
  let idx = 1;
  out.push({ index: idx++, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" });
  out.push({
    index: idx++,
    name: "first validator claims (becomes active)",
    kind: "event",
    event: "ValidatorClaimed",
    actor_role: "validator",
    cardinality_min: 2,
    order_predicate_id: "distinct-validators",
  });
  out.push({ index: idx++, name: "worker submits", kind: "event", event: "WorkSubmitted", actor_role: "worker", cardinality_min: 1 });
  out.push(approveStep(idx++, params));
  out.push(...reviewSteps(idx, params));
  return out;
}

// s07 — validator rotation (aspirational)
function stepsValidatorRotation(params: ConfigParams): StepDef[] {
  const out: StepDef[] = [];
  let idx = 1;
  out.push({ index: idx++, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" });
  out.push({
    index: idx++,
    name: "first validator claims",
    kind: "event",
    event: "ValidatorClaimed",
    actor_role: "validator",
  });
  out.push({
    index: idx++,
    name: "rotation fires",
    kind: "event",
    event: "ValidatorRotated",
    actor_role: "any",
  });
  out.push({
    index: idx++,
    name: "second distinct validator claims",
    kind: "event",
    event: "ValidatorClaimed",
    actor_role: "validator2",
    cardinality_min: 2,
    order_predicate_id: "second-validator-after-rotation",
  });
  out.push(approveStep(idx++, params));
  out.push(...reviewSteps(idx, params));
  return out;
}

// s08 — worker no-show (TIMED). Zero submissions, JobCancelled fires.
function stepsWorkerNoShow(_params: ConfigParams): StepDef[] {
  return [
    { index: 1, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" },
    { index: 2, name: "no work submissions", kind: "event", event: "WorkSubmitted", cardinality_max: 0, actor_role: "any" },
    { index: 3, name: "job cancelled (deadline-driven)", kind: "event", event: "JobCancelled", actor_role: "any" },
  ];
}

// s09 — validator no-show (TIMED, !HARD_ONLY)
function stepsValidatorNoShow(_params: ConfigParams): StepDef[] {
  return [
    { index: 1, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" },
    { index: 2, name: "worker submits", kind: "event", event: "WorkSubmitted", actor_role: "worker", cardinality_min: 1 },
    { index: 3, name: "no validator claim", kind: "event", event: "ValidatorClaimed", cardinality_max: 0, actor_role: "any" },
    { index: 4, name: "job cancelled", kind: "event", event: "JobCancelled", actor_role: "any" },
  ];
}

// s10 — reject all → cancel
function stepsRejectAllCancel(_params: ConfigParams): StepDef[] {
  return [
    { index: 1, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" },
    { index: 2, name: "submissions arrive", kind: "event", event: "WorkSubmitted", actor_role: "worker", cardinality_min: 1 },
    { index: 3, name: "validator claims", kind: "event", event: "ValidatorClaimed", actor_role: "validator", cardinality_max: 1 },
    { index: 4, name: "validator rejects all", kind: "event", event: "AllSubmissionsRejected", actor_role: "validator" },
    {
      index: 5,
      name: "poster cancels (after rejectAll)",
      kind: "event",
      event: "JobCancelled",
      actor_role: "poster",
      order_predicate_id: "cancel-after-rejectAll",
    },
  ];
}

// s11 — deadline-expiry auto-win (HARD_ONLY + TIMED)
function stepsDeadlineExpiry(_params: ConfigParams): StepDef[] {
  return [
    { index: 1, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" },
    { index: 2, name: "at least one submission", kind: "event", event: "WorkSubmitted", actor_role: "worker", cardinality_min: 1 },
    {
      index: 3,
      name: "timed-finalize picks winner",
      kind: "event",
      event: "TimedJobFinalized",
      actor_role: "any",
      args_predicate: (args: any) => {
        // winnerIndex must NOT be max(uint256) — that signals zero-passing path
        if (args?.winnerIndex == null) return true;
        const w = BigInt(args.winnerIndex);
        return w !== BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
      },
    },
  ];
}

// s12 — rating gate pass (worker or validator with rating ≥ threshold completes)
function stepsRatingGatePass(params: ConfigParams): StepDef[] {
  // Skeleton mirrors s01 happy path; the cell predicate (cell-defs.ts) verifies
  // the config has minWorkerRating>0 || minValidatorRating>0. The verifier could
  // additionally check on-chain rating at action block, but that's diagnostic.
  return stepsHappyPath(params);
}

// s13 — rating gate fail (negative scenario — expected revert)
function stepsRatingGateFail(_params: ConfigParams): StepDef[] {
  return [
    {
      index: 1,
      name: "underqualified agent attempts (revert expected)",
      kind: "revert",
      action: "submitWork",
      expected_actor_role: "worker",
      expected_error: "RatingGateFailed",
    },
  ];
}

// s14 — rating gate new user (reviewCount < 3)
function stepsRatingGateNewUser(_params: ConfigParams): StepDef[] {
  return [
    {
      index: 1,
      name: "new-user agent attempts (revert expected)",
      kind: "revert",
      action: "submitWork",
      expected_actor_role: "worker",
      expected_error: "RatingGateFailed",
    },
  ];
}

// s15 — approved-not-approved (negative)
function stepsApprovedNotApproved(params: ConfigParams): StepDef[] {
  if (params.needsApprovedWorkers) {
    return [
      {
        index: 1,
        name: "non-allowlisted worker attempts (revert expected)",
        kind: "revert",
        action: "submitWork",
        expected_actor_role: "worker",
        expected_error: "NotApprovedWorker",
      },
    ];
  }
  if (params.needsApprovedValidators) {
    return [
      {
        index: 1,
        name: "non-allowlisted validator attempts (revert expected)",
        kind: "revert",
        action: "claimJobAsValidator",
        expected_actor_role: "validator",
        expected_error: "NotApprovedValidator",
      },
    ];
  }
  return [];
}

// s16 — multiple submissions from same worker
function stepsMultipleSubmissions(params: ConfigParams): StepDef[] {
  const out: StepDef[] = [];
  let idx = 1;
  out.push({ index: idx++, name: "poster creates job", kind: "event", event: "JobCreated", actor_role: "poster" });
  out.push({
    index: idx++,
    name: "worker submits twice (same wallet)",
    kind: "event",
    event: "WorkSubmitted",
    actor_role: "worker",
    cardinality_min: 2,
    order_predicate_id: "same-worker-resubmission",
  });
  out.push({ index: idx++, name: "validator claims", kind: "event", event: "ValidatorClaimed", actor_role: "validator", cardinality_max: 1 });
  out.push(approveStep(idx++, params));
  out.push(...reviewSteps(idx, params));
  return out;
}

// s17 — HARD_ONLY auto-approve
function stepsHardValidationAuto(params: ConfigParams): StepDef[] {
  return [
    { index: 1, name: "poster creates HARD_ONLY job", kind: "event", event: "JobCreated", actor_role: "poster" },
    { index: 2, name: "worker submits", kind: "event", event: "WorkSubmitted", actor_role: "worker" },
    {
      index: 3,
      name: "script records pass",
      kind: "event",
      event: "ScriptResultRecorded",
      actor_role: "contract",
      args_predicate: (args: any) => args?.scriptPassed === true || args?.passed === true,
    },
    {
      index: 4,
      name: "auto-approve (no validator)",
      kind: "event",
      event: "SubmissionApproved",
      actor_role: "contract",
    },
    {
      index: 5,
      name: "no validator claim (HARD_ONLY forbids)",
      kind: "event",
      event: "ValidatorClaimed",
      cardinality_max: 0,
      actor_role: "any",
    },
    ...reviewSteps(6, params),
  ];
}

// s18 — HARD_THEN_SOFT
function stepsHardThenSoft(params: ConfigParams): StepDef[] {
  return [
    { index: 1, name: "poster creates HARDSIFT job", kind: "event", event: "JobCreated", actor_role: "poster" },
    { index: 2, name: "worker submits", kind: "event", event: "WorkSubmitted", actor_role: "worker" },
    {
      index: 3,
      name: "script passes",
      kind: "event",
      event: "ScriptResultRecorded",
      actor_role: "contract",
      args_predicate: (args: any) => args?.scriptPassed === true || args?.passed === true,
      order_predicate_id: "before-validator-claim",
    },
    { index: 4, name: "validator claims (after script pass)", kind: "event", event: "ValidatorClaimed", actor_role: "validator", cardinality_max: 1 },
    { index: 5, name: "validator approves (NOT contract — soft phase)", kind: "event", event: "SubmissionApproved", actor_role: "validator" },
    ...reviewSteps(6, params),
  ];
}
