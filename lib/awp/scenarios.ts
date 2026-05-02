// lib/awp/scenarios.ts
//
// 21 scenarios (s00 + s01..s20) for the AWP V15 + V4 lifecycle. Each scenario
// describes a terminal (or ongoing) job pattern the swarm should drive
// toward. Scanner classifies observed jobs against these; HLO targets
// untested cells using the (config, scenario) pair as its goal.
//
// Source of truth: clients/awp/matrix/cell-definitions.json + the master
// design's section 7.4. This is the TS port — predicates live in cell-defs.ts.
//
// Status legend:
//   classifiable       — predicate exists in cell-defs.ts; scanner can match
//   aspirational       — designed but no working predicate yet; needs trace
//                         indexing or future contract feature
//   v16-deferred       — V15 doesn't support; tracked for V16 (script retry)

export type ScenarioStatus = "classifiable" | "aspirational" | "v16-deferred" | "in-flight";

export interface Scenario {
  id: string;
  label: string;
  description: string;
  status: ScenarioStatus;
  applicability: string; // free-form filter expression matching configs
  requiredEvents?: string[];
  negativeEvents?: string[];
  terminalState?: Record<string, string | number | boolean>;
  notes?: string;
}

export const ALL_SCENARIOS: Scenario[] = [
  {
    id: "s00-in-flight",
    label: "In-flight",
    description: "Job exists but has not reached a terminal scenario yet. Catch-all bucket for active jobs.",
    status: "in-flight",
    applicability: "any",
    notes: "Not a terminal classification. Dashboard renders these in their HLO-intended cell using orchestration_events.meta.intended_scenario.",
  },
  {
    id: "s01-happy-path",
    label: "Happy Path",
    description: "Post → claim → submit → approve. Single submission, no friction.",
    status: "classifiable",
    applicability: "any",
    requiredEvents: ["JobCreated", "WorkSubmitted", "SubmissionApproved"],
    terminalState: { "job.status": "Completed", "approvedCount": 1, "rejectedCount": 0 },
  },
  {
    id: "s02-validator-first",
    label: "Validator-First Claim",
    description: "Validator claims the job before any work submission lands.",
    status: "classifiable",
    applicability: "validationMode != HARD_ONLY",
    requiredEvents: ["ValidatorClaimed", "WorkSubmitted", "SubmissionApproved"],
    terminalState: { "job.status": "Completed" },
    notes: "Order constraint: first(ValidatorClaimed).block < first(WorkSubmitted).block",
  },
  {
    id: "s03-competitive-workers",
    label: "Competitive Workers",
    description: "Multiple distinct workers submit; validator picks one.",
    status: "classifiable",
    applicability: "submissionMode == TIMED || allowResubmission == true",
    requiredEvents: ["JobCreated", "WorkSubmitted x 2+", "SubmissionApproved"],
    terminalState: { "job.status": "Completed", "distinctWorkerCount": "2+" },
  },
  {
    id: "s04-rejection-loop",
    label: "Rejection Loop",
    description: "Validator rejects at least one submission, then approves a later one.",
    status: "classifiable",
    applicability: "validationMode != HARD_ONLY && allowResubmission == true",
    requiredEvents: ["SubmissionRejected x 1+", "SubmissionApproved"],
    terminalState: { "job.status": "Completed", "rejectedCount": "1+" },
  },
  {
    id: "s05-total-rejection",
    label: "Total Rejection (non-terminal)",
    description: "Validator rejectAll. Per V15 C1, job stays Active — poster does NOT cancel.",
    status: "classifiable",
    applicability: "validationMode == SOFT_ONLY && allowRejectAll == true",
    requiredEvents: ["AllSubmissionsRejected"],
    negativeEvents: ["JobCancelled"],
    terminalState: { "allSubsRejected": true, "AllSubmissionsRejected_event": true, "JobCancelled_event": false },
    notes: "V15 C1 distinguishes s05 vs s10 by whether JobCancelled fires after AllSubmissionsRejected.",
  },
  {
    id: "s06-validator-waitlist",
    label: "Validator Waitlist",
    description: "Multiple validators claim; only the first becomes active, others queue.",
    status: "classifiable",
    applicability: "validationMode != HARD_ONLY && openValidation == true",
    requiredEvents: ["ValidatorClaimed x 2+"],
    terminalState: { "job.status": "Completed or Cancelled", "distinctValidatorClaimedCount": "2+" },
  },
  {
    id: "s07-validator-rotation",
    label: "Validator Rotation",
    description: "Validator timeout fires; rotateValidator pulls next from waitlist.",
    status: "aspirational",
    applicability: "validationMode != HARD_ONLY",
    notes: "V15 path: rotateValidator after validatorTimeout. Add ValidatorRotated event watcher to predicate.",
  },
  {
    id: "s08-worker-no-show",
    label: "Worker No-Show",
    description: "TIMED job with zero submissions reaches deadline; finalize cancels.",
    status: "classifiable",
    applicability: "submissionMode == TIMED",
    requiredEvents: ["JobCreated"],
    terminalState: { "job.status": "Cancelled", "submissionCount": 0 },
    notes: "Reached via cancelJob (any) OR V15 C6 finalizeTimedJob (HARD_ONLY zero-passing path).",
  },
  {
    id: "s09-validator-no-show",
    label: "Validator No-Show",
    description: "Worker submits but no validator ever claims. Deadline passes, job is cancelled.",
    status: "classifiable",
    applicability: "submissionMode == TIMED && validationMode != HARD_ONLY",
    requiredEvents: ["JobCreated", "WorkSubmitted"],
    terminalState: { "job.status": "Cancelled", "activeValidator": "0x0", "submissionCount": "1+" },
  },
  {
    id: "s10-reject-all-cancel",
    label: "RejectAll + Cancel",
    description: "Validator rejectAll; then poster explicitly cancelJob (V15 C2 allows because all subs are rejected).",
    status: "classifiable",
    applicability: "validationMode == SOFT_ONLY && allowRejectAll == true",
    requiredEvents: ["AllSubmissionsRejected", "JobCancelled"],
    terminalState: { "job.status": "Cancelled" },
    notes: "Order: AllSubmissionsRejected.block < JobCancelled.block. Distinguishes from s05 by JobCancelled presence.",
  },
  {
    id: "s11-deadline-expiry",
    label: "Deadline-Expiry Auto-Win",
    description: "TIMED HARD_ONLY job's deadline passes with at least one passing submission; finalize picks winner.",
    status: "aspirational",
    applicability: "submissionMode == TIMED && validationMode == HARD_ONLY",
    notes: "V15 emits TimedJobFinalized(jobId, winnerIndex, winner) — needs winnerIndex != type(uint256).max.",
  },
  {
    id: "s12-rating-gate-pass",
    label: "Rating Gate Pass",
    description: "Rating-gated config; qualified worker (or validator) successfully participates.",
    status: "classifiable",
    applicability: "minWorkerRating > 0 || minValidatorRating > 0",
    requiredEvents: ["JobCreated", "WorkSubmitted", "SubmissionApproved"],
    negativeEvents: ["RatingGateFailed"],
    terminalState: { "job.status": "Completed" },
  },
  {
    id: "s13-rating-gate-fail",
    label: "Rating Gate Fail",
    description: "Underqualified agent attempts; contract reverts with RatingGateFailed event in trace.",
    status: "aspirational",
    applicability: "minWorkerRating > 0 || minValidatorRating > 0",
    notes: "Requires debug_traceTransaction to surface RatingGateFailed (only emitted in reverted tx).",
  },
  {
    id: "s14-rating-gate-new-user",
    label: "Rating Gate — New User",
    description: "Agent with reviewCount < 3 blocked from rating-gated job (failed gate cnt threshold).",
    status: "aspirational",
    applicability: "minWorkerRating > 0 || minValidatorRating > 0",
    notes: "V15 C5: gate fails when reviewCount < MIN_REVIEWS_FOR_RATING_GATE (3). Same trace requirement.",
  },
  {
    id: "s15-approved-not-approved",
    label: "Approved-Worker Gate",
    description: "Non-allowlisted wallet attempts to submit on an approved-only job; reverts.",
    status: "aspirational",
    applicability: "approvedWorkers.length > 0 || approvedValidators.length > 0",
    notes: "Trace-level — the revert is NotApprovedWorker / NotApprovedValidator from a reverted call.",
  },
  {
    id: "s16-multiple-submissions",
    label: "Resubmission Path",
    description: "allowResubmission=true; same worker submits twice and one is approved.",
    status: "classifiable",
    applicability: "allowResubmission == true && validationMode != HARD_ONLY",
    requiredEvents: ["WorkSubmitted x 2+", "SubmissionApproved"],
    terminalState: { "submissionCount": "2+", "approvedCount": 1 },
  },
  {
    id: "s17-hard-validation-auto",
    label: "HARD_ONLY Auto-Approve",
    description: "FCFS HARD_ONLY: ScriptResultRecorded(passed=true) triggers _autoApprove in same tx.",
    status: "aspirational",
    applicability: "validationMode == HARD_ONLY && submissionMode == FCFS",
    notes: "V15 path: recordScriptResult → SubmissionApproved without human validator.",
  },
  {
    id: "s18-hard-then-soft",
    label: "HARDSIFT Two-Stage",
    description: "HARD_THEN_SOFT: script passes, then validator approves.",
    status: "aspirational",
    applicability: "validationMode == HARD_THEN_SOFT",
    notes: "Predicate: ScriptResultRecorded(passed=true) BEFORE SubmissionApproved on same submission.",
  },
  {
    id: "s19-hard-script-retry",
    label: "HARD_ONLY Script Retry",
    description: "Script first fails, retried, eventually passes.",
    status: "v16-deferred",
    applicability: "validationMode == HARD_ONLY",
    notes: "V15 = one attempt per submission. Deferred to V16.",
  },
  {
    id: "s20-hard-script-fail",
    label: "HARD_ONLY Total Script Failure",
    description: "All HARD_ONLY submissions fail the script; finalize cancels (V15 C6 zombie-job fix).",
    status: "v16-deferred",
    applicability: "validationMode == HARD_ONLY && submissionMode == TIMED",
    notes: "C6 covers the zero-passing terminal path; broader V16 scope adds retries.",
  },
];

// ============================================================================
// Lookup helpers
// ============================================================================
const BY_ID: Record<string, Scenario> = (() => {
  const map: Record<string, Scenario> = {};
  for (const s of ALL_SCENARIOS) map[s.id] = s;
  return map;
})();

export function getScenarioById(id: string): Scenario | undefined {
  return BY_ID[id];
}

export function isScenarioClassifiable(id: string): boolean {
  const s = BY_ID[id];
  return Boolean(s && s.status === "classifiable");
}

/**
 * Returns the scenario IDs HLO can plausibly drive toward today
 * (classifiable status only). Used by the priority-C "create in untested cell"
 * step.
 */
export const CLASSIFIABLE_SCENARIO_IDS: string[] = ALL_SCENARIOS
  .filter((s) => s.status === "classifiable" && s.id !== "s00-in-flight")
  .map((s) => s.id);

export const ASPIRATIONAL_SCENARIO_IDS: string[] = ALL_SCENARIOS
  .filter((s) => s.status === "aspirational")
  .map((s) => s.id);

export const V16_DEFERRED_SCENARIO_IDS: string[] = ALL_SCENARIOS
  .filter((s) => s.status === "v16-deferred")
  .map((s) => s.id);

export const SCENARIO_COUNT = ALL_SCENARIOS.length;
