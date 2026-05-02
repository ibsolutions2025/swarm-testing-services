// lib/awp/state-machine.ts
//
// Pure decision logic: given an on-chain job's current state + the HLO's
// intended scenario + the agent's eligibility constraints, return the next
// action that progresses the job toward its target.
//
// HLO calls this every tick to pick what to dispatch. State is read from
// chain; intent is the HLO's private goal (stored in
// orchestration_events.meta.intended_scenario, never on-chain).
//
// This module is data-driven and side-effect free. It does NOT call viem,
// touch the database, or talk to OpenClaw.

import type { ConfigParams } from "./matrix.js";

export type AgentAction =
  | "claim_validator"
  | "submit_work"
  | "approve_submission"
  | "reject_submission"
  | "reject_all"
  | "cancel_job"
  | "finalize_timed_job"
  | "submit_review"
  | "wait"
  | "none";

export interface JobStateForDecision {
  status: number;            // 0=Open 1=Active 2=Completed 3=Cancelled
  validationMode: number;    // 0=HARD_ONLY 1=SOFT_ONLY 2=HARD_THEN_SOFT
  submissionMode: number;    // 0=FCFS 1=TIMED
  submissionDeadline: number;
  submissionWindow: number;
  activeValidator: `0x${string}`;
  validatorWaitlist: `0x${string}`[];
  approvedWorkers: `0x${string}`[];
  approvedValidators: `0x${string}`[];
  openValidation: boolean;
  allowRejectAll: boolean;
  allowResubmission: boolean;
  poster: `0x${string}`;
  minWorkerRating: number;
  minValidatorRating: number;
}

export interface SubmissionStateForDecision {
  worker: `0x${string}`;
  status: number;            // 0=pending 1=approved 2=rejected 3=not_selected
  scriptPassed: boolean;
}

export interface AgentEligibilityForDecision {
  // Has-passed checkAgentEligibility for the indicated action.
  // Used as a hint; daemon already filtered.
  ethSufficient: boolean;
  usdcSufficient: boolean; // for createJob; ignored elsewhere
  isPendingReviewBlocked: boolean;
  ratingBps: number;
  reviewCount: number;
}

export interface DecisionInput {
  job: JobStateForDecision;
  submissions: SubmissionStateForDecision[];
  intendedScenario?: string; // HLO's target scenario (e.g. "s05-total-rejection")
  configParams: ConfigParams;
  // Reviews this agent owes other parties (V4 ReviewGate). If non-empty,
  // submit_review takes priority A.
  pendingReviewsOwed?: number;
  // Now (unix seconds) — passed in for deterministic testing
  nowSeconds: number;
}

export interface DecisionResult {
  action: AgentAction;
  reason: string;
  // Optional payload hints (e.g. submissionIndex for approve/reject)
  submissionIndex?: number;
  // If we chose `wait`, when should we re-check?
  nextCheckSeconds?: number;
}

/**
 * Determines the next action that, when performed, would move this job
 * toward its `intendedScenario`. Used by HLO's "progress stuck job"
 * priority.
 *
 * Returned `action` is one of the V15 functions (or 'submit_review' for V4,
 * 'wait' if nothing's actionable yet, 'none' if the job is terminal).
 */
export function nextRequiredAction(input: DecisionInput): DecisionResult {
  const { job, submissions, intendedScenario, configParams, nowSeconds } = input;

  // Priority A — clear pending reviews if owed
  if ((input.pendingReviewsOwed ?? 0) > 0) {
    return {
      action: "submit_review",
      reason: `agent owes ${input.pendingReviewsOwed} review(s); blocked from other actions if cap reached`,
    };
  }

  // Job already terminal
  if (job.status === 2) return { action: "none", reason: "job is Completed" };
  if (job.status === 3) return { action: "none", reason: "job is Cancelled" };

  // Helpers
  const hasValidator = job.activeValidator !== "0x0000000000000000000000000000000000000000";
  const isTimed = job.submissionMode === 1;
  const deadlinePassed = isTimed && job.submissionDeadline > 0 && nowSeconds >= job.submissionDeadline;
  const windowOpen = !isTimed || job.submissionDeadline === 0 || nowSeconds < job.submissionDeadline;

  const pending = submissions.filter((s) => s.status === 0);
  const approved = submissions.filter((s) => s.status === 1);
  const rejected = submissions.filter((s) => s.status === 2);
  const allTerminal = submissions.length > 0 && submissions.every((s) => s.status === 2 || s.status === 3);

  // Switch on intended scenario when HLO is steering
  switch (intendedScenario) {
    case "s01-happy-path":
      return decideHappyPath();
    case "s02-validator-first":
      // We need validator BEFORE worker submission; if no validator yet, claim.
      if (!hasValidator && job.validationMode !== 0) {
        return { action: "claim_validator", reason: "s02 needs validator-first; no validator yet" };
      }
      return decideHappyPath();
    case "s03-competitive-workers":
      // Need 2+ submissions then approval. Drive new submissions until count >= 2.
      if (submissions.length < 2 && windowOpen) {
        return { action: "submit_work", reason: "s03 needs ≥2 distinct workers; submitting" };
      }
      return decideApproveOne();
    case "s04-rejection-loop":
      // Need at least one rejection then approval.
      if (pending.length > 0 && rejected.length === 0 && hasValidator) {
        return { action: "reject_submission", reason: "s04 needs ≥1 rejection before approve", submissionIndex: pending[0] ? submissions.indexOf(pending[0]) : 0 };
      }
      if (pending.length > 0 && rejected.length >= 1 && hasValidator) {
        return { action: "approve_submission", reason: "s04 already has rejection; approving next pending", submissionIndex: pending[0] ? submissions.indexOf(pending[0]) : 0 };
      }
      // Need a fresh submission to reject/approve
      if (windowOpen) return { action: "submit_work", reason: "s04 needs more submissions to reject/approve" };
      return { action: "wait", reason: "s04 waiting for window or validator", nextCheckSeconds: 60 };
    case "s05-total-rejection":
      // SOFT_ONLY + allowRejectAll. Need >=1 sub, then validator rejectAll, then DON'T cancel.
      if (!hasValidator) return { action: "claim_validator", reason: "s05 needs validator before rejectAll" };
      if (submissions.length === 0 && windowOpen) return { action: "submit_work", reason: "s05 needs ≥1 submission before rejectAll" };
      if (submissions.length > 0 && pending.length > 0 && (!isTimed || deadlinePassed)) {
        return { action: "reject_all", reason: "s05 ready for rejectAll (subs exist, window expired or FCFS)" };
      }
      if (isTimed && !deadlinePassed) return { action: "wait", reason: "s05 waiting for TIMED window to close before rejectAll", nextCheckSeconds: Math.max(60, job.submissionDeadline - nowSeconds) };
      return { action: "wait", reason: "s05 awaiting more submissions", nextCheckSeconds: 60 };
    case "s06-validator-waitlist":
      // Need 2+ ValidatorClaimed events → next claim adds to waitlist.
      // HLO's job is to dispatch a SECOND validator. Outside this function.
      if (!hasValidator) return { action: "claim_validator", reason: "s06 needs first validator" };
      // The dispatcher will pick a second validator separately; from THIS agent's perspective, fall through.
      return decideHappyPath();
    case "s08-worker-no-show":
      // TIMED, no submissions. Wait for deadline, then finalize OR cancel.
      if (submissions.length === 0 && isTimed && deadlinePassed) {
        // HARD_ONLY → finalizeTimedJob does V15 C6 cancel+refund
        if (job.validationMode === 0) return { action: "finalize_timed_job", reason: "s08 HARD_ONLY zero-passing → C6 cancel+refund" };
        // Otherwise poster cancels
        return { action: "cancel_job", reason: "s08 deadline passed with zero subs; poster cancel" };
      }
      if (submissions.length === 0 && isTimed && !deadlinePassed) {
        return { action: "wait", reason: "s08 waiting for deadline", nextCheckSeconds: Math.max(60, job.submissionDeadline - nowSeconds) };
      }
      if (submissions.length > 0) return { action: "none", reason: "s08 violated: a submission already exists" };
      break;
    case "s09-validator-no-show":
      // Need at least one submission then deadline passes with no validator.
      if (submissions.length === 0 && windowOpen) return { action: "submit_work", reason: "s09 needs a submission before validator-noshow" };
      if (submissions.length >= 1 && isTimed && deadlinePassed && !hasValidator) {
        return { action: "cancel_job", reason: "s09 deadline passed, no validator, ≥1 sub; poster cancels" };
      }
      if (submissions.length >= 1 && isTimed && !deadlinePassed && !hasValidator) {
        return { action: "wait", reason: "s09 waiting for deadline (no validator yet)", nextCheckSeconds: Math.max(60, job.submissionDeadline - nowSeconds) };
      }
      if (hasValidator) return { action: "none", reason: "s09 violated: validator claimed already" };
      break;
    case "s10-reject-all-cancel":
      // After s05 setup: validator rejectAll, then poster cancel.
      if (!hasValidator) return { action: "claim_validator", reason: "s10 needs validator first" };
      if (submissions.length === 0 && windowOpen) return { action: "submit_work", reason: "s10 needs subs before rejectAll" };
      if (pending.length > 0 && (!isTimed || deadlinePassed)) {
        return { action: "reject_all", reason: "s10 step 1: rejectAll" };
      }
      if (allTerminal && submissions.length > 0 && job.status === 1) {
        return { action: "cancel_job", reason: "s10 step 2: poster cancel after all subs rejected" };
      }
      return { action: "wait", reason: "s10 awaiting next step", nextCheckSeconds: 60 };
    case "s12-rating-gate-pass":
      // Same as happy path but config has rating gate set. Action selection is identical.
      return decideHappyPath();
    case "s16-multiple-submissions":
      // Need 2+ submissions from same OR diff workers, then approve.
      if (submissions.length < 2 && windowOpen) return { action: "submit_work", reason: "s16 needs ≥2 submissions" };
      return decideApproveOne();
    default:
      // No specific intent or aspirational scenario — fall through to default.
      break;
  }

  // No specific scenario, or scenario fell through. Drive whatever's stuck.
  return decideStuckJob();

  // ──────────────────── helpers ────────────────────

  function decideHappyPath(): DecisionResult {
    if (!hasValidator && job.validationMode !== 0) {
      return { action: "claim_validator", reason: "happy path: claim validator" };
    }
    if (submissions.length === 0 && windowOpen) {
      return { action: "submit_work", reason: "happy path: post submission" };
    }
    if (pending.length > 0 && hasValidator && (!isTimed || deadlinePassed)) {
      return { action: "approve_submission", reason: "happy path: approve pending sub", submissionIndex: submissions.indexOf(pending[0]) };
    }
    if (pending.length > 0 && hasValidator && isTimed && !deadlinePassed) {
      return { action: "wait", reason: "happy path: TIMED window open, can't approve until deadline", nextCheckSeconds: Math.max(60, job.submissionDeadline - nowSeconds) };
    }
    return { action: "wait", reason: "happy path: nothing actionable yet", nextCheckSeconds: 60 };
  }

  function decideApproveOne(): DecisionResult {
    if (!hasValidator) return { action: "claim_validator", reason: "need validator to approve" };
    if (pending.length > 0 && (!isTimed || deadlinePassed)) {
      return { action: "approve_submission", reason: "approve next pending", submissionIndex: submissions.indexOf(pending[0]) };
    }
    return { action: "wait", reason: "waiting for window or validator", nextCheckSeconds: 60 };
  }

  function decideStuckJob(): DecisionResult {
    // No intent — just nudge the most-likely-stuck dimension.
    if (!hasValidator && job.validationMode !== 0) {
      return { action: "claim_validator", reason: "no intent; job lacks validator" };
    }
    if (submissions.length === 0 && windowOpen) {
      return { action: "submit_work", reason: "no intent; job lacks submissions" };
    }
    if (pending.length > 0 && hasValidator && (!isTimed || deadlinePassed)) {
      return { action: "approve_submission", reason: "no intent; approve next pending", submissionIndex: submissions.indexOf(pending[0]) };
    }
    if (isTimed && deadlinePassed && submissions.length === 0) {
      // Nobody showed; cancel
      return { action: "cancel_job", reason: "no intent; TIMED with zero subs after deadline" };
    }
    return { action: "wait", reason: "no actionable step right now", nextCheckSeconds: 60 };
  }
}

/**
 * Cheap "is this job worth dispatching to today?" check used by HLO's
 * priority-B "progress stuck job" step. Returns true if there's a
 * deterministic next action other than `wait` or `none`.
 */
export function isJobStuck(input: DecisionInput): boolean {
  const r = nextRequiredAction(input);
  return r.action !== "none" && r.action !== "wait";
}
