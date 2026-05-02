// lib/awp/rules.ts
//
// Encodes every V15 + V4 require/revert/gate-condition as structured data so
// the HLO can pre-check eligibility before dispatching, the Auditor can
// categorize "correct_enforcement" failures, and Phase B's Onboarding Engine
// has a structural target to validate against.
//
// Source of truth: contracts/JobNFTv15.sol + contracts/ReviewGateV4.sol
// (mirrored to clients/awp/contracts/ in this repo).
//
// Each `Rule` has:
//   - id              stable identifier ("V15.createJob.rewardZero")
//   - fn              which contract function it gates
//   - kind            'precondition' | 'state' | 'gate' | 'access'
//   - condition       human-readable predicate
//   - errorName       Solidity custom error or revert string emitted on violation
//   - failureCategory auditor's failure category if violated
//   - check?          (optional) data-driven predicate over (jobState, agent, params)
//                     so HLO can pre-check before dispatching
//
// Convention: rules are READ-ONLY data. The functions at the bottom
// (`getRulesForFunction`, `checkAgentEligibility`, `decodeRevertReason`) are
// pure and depend on this catalog. Adding a rule = appending to RULES.

export type RuleKind = "precondition" | "state" | "gate" | "access" | "constraint";
export type AuditFailureCategory =
  | "agent_too_dumb"
  | "mcp_product_gap"
  | "docs_product_gap"
  | "correct_enforcement"
  | "contract_flaw"
  | "infra_issue";

export interface Rule {
  id: string;
  fn: string;            // function name on JobNFT or ReviewGate (e.g. "createJob")
  kind: RuleKind;
  condition: string;     // human description (e.g. "rewardAmount > 0")
  errorName: string;     // Solidity custom error name OR revert string
  failureCategory: AuditFailureCategory;
  failureSubcategory?: string;
  v15Constraint?: "C1" | "C2" | "C3" | "C4" | "C5" | "C6";
  notes?: string;
}

// ============================================================================
// JobNFT V15 — createJob preconditions
// ============================================================================
const CREATE_JOB_RULES: Rule[] = [
  {
    id: "V15.createJob.reviewGateNotBlocked",
    fn: "createJob",
    kind: "gate",
    condition: "!reviewGate.isBlocked(poster)",
    errorName: "ReviewGate: too many pending reviews",
    failureCategory: "correct_enforcement",
    failureSubcategory: "pending_review_cap",
    notes: "ReviewGate.isBlocked returns true when pendingReviewCount[poster] >= maxPendingReviews (default 5).",
  },
  { id: "V15.createJob.rewardZero",      fn: "createJob", kind: "precondition", condition: "rewardAmount > 0",                          errorName: "RewardZero",          failureCategory: "agent_too_dumb" },
  { id: "V15.createJob.titleEmpty",      fn: "createJob", kind: "precondition", condition: "title.length > 0",                          errorName: "TitleRequired",       failureCategory: "agent_too_dumb" },
  { id: "V15.createJob.descriptionEmpty",fn: "createJob", kind: "precondition", condition: "description.length > 0",                    errorName: "DescriptionRequired", failureCategory: "agent_too_dumb" },
  { id: "V15.createJob.requirementsEmpty",fn:"createJob", kind: "precondition", condition: "requirementsJson.length > 2",               errorName: "RequirementsRequired",failureCategory: "agent_too_dumb", notes: "Length > 2 means '{}' is REJECTED — needs at least one field." },
  { id: "V15.createJob.invalidValMode",  fn: "createJob", kind: "precondition", condition: "validationMode in {0,1,2}",                  errorName: "InvalidValidationMode",failureCategory: "agent_too_dumb" },
  { id: "V15.createJob.invalidSubMode",  fn: "createJob", kind: "precondition", condition: "submissionMode in {0,1}",                    errorName: "InvalidSubmissionMode",failureCategory: "agent_too_dumb" },

  { id: "V15.createJob.scriptCidRequired",fn:"createJob", kind: "precondition", condition: "validationMode in {HARD_ONLY,HARD_THEN_SOFT} ⇒ validationScriptCID.length > 0", errorName: "ScriptCIDRequired",  failureCategory: "agent_too_dumb" },
  { id: "V15.createJob.scriptCidForbidden",fn:"createJob",kind: "precondition", condition: "validationMode == SOFT_ONLY ⇒ validationScriptCID.length == 0",                  errorName: "ScriptCIDNotAllowed",failureCategory: "agent_too_dumb" },
  { id: "V15.createJob.instructionsRequired",fn:"createJob",kind:"precondition", condition: "validationInstructions.length > 0",                                              errorName: "InstructionsRequired",failureCategory: "agent_too_dumb" },

  { id: "V15.createJob.timedNeedsWindow",fn: "createJob", kind: "precondition", condition: "submissionMode == TIMED ⇒ submissionWindow > 0",                                  errorName: "WindowRequiredTimed", failureCategory: "agent_too_dumb" },
  { id: "V15.createJob.fcfsForbidsWindow",fn:"createJob", kind: "precondition", condition: "submissionMode == FCFS  ⇒ submissionWindow == 0",                                  errorName: "WindowMustBeZero",    failureCategory: "agent_too_dumb" },

  // C4 — HARD_ONLY rejects validator-axis config
  { id: "V15.createJob.hardOnlyForbidsValRating", fn:"createJob", kind:"constraint", condition: "validationMode == HARD_ONLY ⇒ minValidatorRating == 0",  errorName: "HardOnlyValRating",  failureCategory: "correct_enforcement", failureSubcategory: "hard_only_validator_config", v15Constraint: "C4" },
  { id: "V15.createJob.hardOnlyForbidsApprovedVal", fn:"createJob", kind:"constraint", condition: "validationMode == HARD_ONLY ⇒ approvedValidators.length == 0", errorName: "HardOnlyApprovedVal", failureCategory: "correct_enforcement", failureSubcategory: "hard_only_validator_config", v15Constraint: "C4" },

  { id: "V15.createJob.allowance",       fn: "createJob", kind: "precondition", condition: "USDC.allowance(poster, JobNFT) >= rewardAmount",  errorName: "InsufficientAllowance",failureCategory: "agent_too_dumb",   failureSubcategory: "no_approval" },
  { id: "V15.createJob.balance",         fn: "createJob", kind: "precondition", condition: "USDC.balanceOf(poster) >= rewardAmount",          errorName: "InsufficientBalance",  failureCategory: "infra_issue",      failureSubcategory: "insufficient_usdc" },
  { id: "V15.createJob.transferSucceeds",fn: "createJob", kind: "precondition", condition: "USDC.transferFrom(poster,JobNFT,rewardAmount)",   errorName: "TransferFromFailed",   failureCategory: "infra_issue" },
];

// ============================================================================
// JobNFT V15 — claimJobAsValidator
// ============================================================================
const CLAIM_VALIDATOR_RULES: Rule[] = [
  { id: "V15.claim.reviewGateNotBlocked", fn:"claimJobAsValidator", kind:"gate",        condition:"!reviewGate.isBlocked(msg.sender)",                  errorName:"ReviewGate: too many pending reviews", failureCategory:"correct_enforcement", failureSubcategory:"pending_review_cap" },
  { id: "V15.claim.jobExists",            fn:"claimJobAsValidator", kind:"state",       condition:"job.poster != 0x0",                                   errorName:"JobNotFound",                          failureCategory:"agent_too_dumb" },
  { id: "V15.claim.statusOpenOrActive",   fn:"claimJobAsValidator", kind:"state",       condition:"job.status in {Open,Active}",                         errorName:"JobNotOpenForValidators",              failureCategory:"correct_enforcement", failureSubcategory:"job_not_open_for_validators" },
  { id: "V15.claim.notPoster",            fn:"claimJobAsValidator", kind:"access",      condition:"msg.sender != job.poster",                            errorName:"PosterCannotValidate",                 failureCategory:"correct_enforcement", failureSubcategory:"poster_cannot_validate" },
  { id: "V15.claim.validationModeNotHardOnly", fn:"claimJobAsValidator", kind:"constraint", condition:"validationMode != HARD_ONLY",                    errorName:"NoValidatorNeeded",                    failureCategory:"correct_enforcement", failureSubcategory:"hard_only_no_validator" },
  { id: "V15.claim.inApprovedValidators",  fn:"claimJobAsValidator", kind:"access",     condition:"!openValidation ⇒ msg.sender ∈ approvedValidators",   errorName:"NotApprovedValidator",                 failureCategory:"correct_enforcement", failureSubcategory:"not_in_approved_validators" },
  { id: "V15.claim.notAlreadyActive",      fn:"claimJobAsValidator", kind:"state",      condition:"msg.sender != job.activeValidator",                   errorName:"AlreadyActiveValidator",               failureCategory:"agent_too_dumb" },
  { id: "V15.claim.notInWaitlist",         fn:"claimJobAsValidator", kind:"state",      condition:"msg.sender ∉ job.validatorWaitlist",                  errorName:"AlreadyInWaitlist",                    failureCategory:"agent_too_dumb" },
  { id: "V15.claim.notPastValidator",      fn:"claimJobAsValidator", kind:"state",      condition:"!hasBeenValidator[jobId][msg.sender]",                errorName:"AlreadyServed",                        failureCategory:"correct_enforcement", failureSubcategory:"already_served_as_validator" },
  { id: "V15.claim.notWorkerOnJob",        fn:"claimJobAsValidator", kind:"access",     condition:"msg.sender ∉ workers(job)",                           errorName:"WorkerCannotValidate",                 failureCategory:"correct_enforcement", failureSubcategory:"worker_cannot_validate" },
  // C5 — rating gate
  { id: "V15.claim.ratingGateValidator",   fn:"claimJobAsValidator", kind:"gate",       condition:"minValidatorRating > 0 ⇒ reviewGate set ∧ getAgentRating(msg.sender) >= minValidatorRating ∧ reviewCount >= 3",
    errorName:"JobNFT: validator rating below threshold", failureCategory:"correct_enforcement", failureSubcategory:"rating_gate_validator", v15Constraint:"C5",
    notes:"Emits RatingGateFailed(jobId,agent,required,actual,'validator') BEFORE reverting. Visible only via debug_traceTransaction." },
  { id: "V15.claim.ratingGateNoReviewGate", fn:"claimJobAsValidator", kind:"gate",      condition:"minValidatorRating > 0 ⇒ address(reviewGate) != 0",   errorName:"RatingGateNoReviewGate",               failureCategory:"infra_issue", failureSubcategory:"review_gate_unset" },
];

// ============================================================================
// JobNFT V15 — submitWork
// ============================================================================
const SUBMIT_WORK_RULES: Rule[] = [
  { id: "V15.submit.reviewGateNotBlocked", fn:"submitWork", kind:"gate",        condition:"!reviewGate.isBlocked(msg.sender)",       errorName:"ReviewGate: too many pending reviews", failureCategory:"correct_enforcement", failureSubcategory:"pending_review_cap" },
  { id: "V15.submit.jobExists",            fn:"submitWork", kind:"state",       condition:"job.poster != 0x0",                        errorName:"JobNotFound",                  failureCategory:"agent_too_dumb" },
  { id: "V15.submit.notPoster",            fn:"submitWork", kind:"access",      condition:"msg.sender != job.poster",                 errorName:"PosterCannotSubmit",           failureCategory:"correct_enforcement", failureSubcategory:"poster_cannot_submit" },
  { id: "V15.submit.deliverableUrl",       fn:"submitWork", kind:"precondition",condition:"deliverableUrl.length > 0",                errorName:"DeliverableRequired",          failureCategory:"agent_too_dumb" },
  { id: "V15.submit.statusOpenOrActive",   fn:"submitWork", kind:"state",       condition:"job.status in {Open,Active}",              errorName:"JobNotOpenForSubmissions",     failureCategory:"correct_enforcement", failureSubcategory:"job_not_open_for_submissions" },
  // non-HARD_ONLY validator/waitlist exclusions
  { id: "V15.submit.notActiveValidator",   fn:"submitWork", kind:"access",      condition:"validationMode != HARD_ONLY ⇒ msg.sender != activeValidator", errorName:"ValidatorCannotSubmit", failureCategory:"correct_enforcement", failureSubcategory:"validator_cannot_submit" },
  { id: "V15.submit.notInWaitlist",        fn:"submitWork", kind:"access",      condition:"validationMode != HARD_ONLY ⇒ msg.sender ∉ validatorWaitlist", errorName:"ValidatorCannotSubmit", failureCategory:"correct_enforcement", failureSubcategory:"validator_cannot_submit" },
  { id: "V15.submit.notFormerValidator",   fn:"submitWork", kind:"access",      condition:"validationMode != HARD_ONLY ⇒ !pastValidators[jobId][msg.sender]", errorName:"FormerValidatorCannotSubmit", failureCategory:"correct_enforcement", failureSubcategory:"former_validator_cannot_submit" },
  { id: "V15.submit.inApprovedWorkers",    fn:"submitWork", kind:"access",      condition:"approvedWorkers.length > 0 ⇒ msg.sender ∈ approvedWorkers", errorName:"NotApprovedWorker", failureCategory:"correct_enforcement", failureSubcategory:"not_in_approved_workers" },
  { id: "V15.submit.windowOpen",           fn:"submitWork", kind:"state",       condition:"submissionMode == TIMED ⇒ block.timestamp <= submissionDeadline", errorName:"WindowClosed", failureCategory:"correct_enforcement", failureSubcategory:"submission_window_closed" },
  { id: "V15.submit.allowResubmission",    fn:"submitWork", kind:"state",       condition:"!allowResubmission ⇒ msg.sender hasn't already submitted",     errorName:"ResubmissionNotAllowed", failureCategory:"correct_enforcement", failureSubcategory:"resubmission_not_allowed" },
  // C5 — worker rating gate
  { id: "V15.submit.ratingGateWorker",     fn:"submitWork", kind:"gate",        condition:"minWorkerRating > 0 ⇒ reviewGate set ∧ getAgentRating(msg.sender) >= minWorkerRating ∧ reviewCount >= 3",
    errorName:"JobNFT: worker rating below threshold", failureCategory:"correct_enforcement", failureSubcategory:"rating_gate_worker", v15Constraint:"C5",
    notes:"Emits RatingGateFailed(jobId,agent,required,actual,'worker') BEFORE reverting." },
  { id: "V15.submit.ratingGateNoReviewGate", fn:"submitWork", kind:"gate",      condition:"minWorkerRating > 0 ⇒ address(reviewGate) != 0", errorName:"RatingGateNoReviewGate", failureCategory:"infra_issue", failureSubcategory:"review_gate_unset" },
];

// ============================================================================
// JobNFT V15 — approveSubmission
// ============================================================================
const APPROVE_RULES: Rule[] = [
  { id: "V15.approve.jobExists",         fn:"approveSubmission", kind:"state",  condition:"job.poster != 0x0",                            errorName:"JobNotFound",          failureCategory:"agent_too_dumb" },
  { id: "V15.approve.statusActive",      fn:"approveSubmission", kind:"state",  condition:"job.status == Active",                         errorName:"JobNotActive",         failureCategory:"correct_enforcement", failureSubcategory:"job_not_active" },
  { id: "V15.approve.onlyActiveValidator",fn:"approveSubmission",kind:"access", condition:"msg.sender == activeValidator",                errorName:"OnlyActiveValidator",  failureCategory:"correct_enforcement", failureSubcategory:"only_active_validator" },
  { id: "V15.approve.windowExpired",     fn:"approveSubmission", kind:"state",  condition:"submissionMode == TIMED ∧ deadline > 0 ⇒ block.timestamp >= deadline", errorName:"SubmissionWindowStillOpen", failureCategory:"correct_enforcement", failureSubcategory:"submission_window_still_open" },
  { id: "V15.approve.indexValid",        fn:"approveSubmission", kind:"precondition", condition:"submissionIndex < subs.length",          errorName:"InvalidSubmissionIndex", failureCategory:"agent_too_dumb" },
  { id: "V15.approve.notAlreadyReviewed",fn:"approveSubmission", kind:"state",  condition:"subs[idx].status == 0 (pending)",              errorName:"SubmissionAlreadyReviewed", failureCategory:"agent_too_dumb" },
  { id: "V15.approve.scriptPassed",      fn:"approveSubmission", kind:"state",  condition:"validationMode in {HARD_ONLY,HARD_THEN_SOFT} ⇒ scriptPassed", errorName:"ScriptValidationRequired", failureCategory:"correct_enforcement", failureSubcategory:"script_validation_required" },
  { id: "V15.approve.securityAudit",     fn:"approveSubmission", kind:"precondition", condition:"requireSecurityAudit ⇒ securityAuditCID.length > 0", errorName:"SecurityAuditRequired", failureCategory:"agent_too_dumb" },
];

// ============================================================================
// JobNFT V15 — rejectSubmission (C3: validator-only)
// ============================================================================
const REJECT_RULES: Rule[] = [
  { id: "V15.reject.jobExists",          fn:"rejectSubmission", kind:"state",  condition:"job.poster != 0x0",                            errorName:"JobNotFound",                  failureCategory:"agent_too_dumb" },
  { id: "V15.reject.onlyActiveValidator",fn:"rejectSubmission", kind:"access", condition:"msg.sender == activeValidator",                errorName:"OnlyActiveValidatorReject",    failureCategory:"correct_enforcement", failureSubcategory:"only_active_validator_can_reject", v15Constraint:"C3" },
  { id: "V15.reject.indexValid",         fn:"rejectSubmission", kind:"precondition", condition:"submissionIndex < subs.length",         errorName:"InvalidSubmissionIndex",       failureCategory:"agent_too_dumb" },
  { id: "V15.reject.notAlreadyReviewed", fn:"rejectSubmission", kind:"state",  condition:"subs[idx].status == 0 (pending)",              errorName:"SubmissionAlreadyReviewed",    failureCategory:"agent_too_dumb" },
];

// ============================================================================
// JobNFT V15 — rejectAllSubmissions (C1 non-terminal, C3 validator-only)
// ============================================================================
const REJECT_ALL_RULES: Rule[] = [
  { id: "V15.rejectAll.jobExists",        fn:"rejectAllSubmissions", kind:"state",  condition:"job.poster != 0x0",                       errorName:"JobNotFound",                   failureCategory:"agent_too_dumb" },
  { id: "V15.rejectAll.statusActive",     fn:"rejectAllSubmissions", kind:"state",  condition:"job.status == Active",                    errorName:"JobNotActive",                  failureCategory:"correct_enforcement", failureSubcategory:"job_not_active" },
  { id: "V15.rejectAll.notHardOnly",      fn:"rejectAllSubmissions", kind:"constraint", condition:"validationMode != HARD_ONLY",         errorName:"NoValidatorHardOnly",           failureCategory:"correct_enforcement", failureSubcategory:"hard_only_no_validator" },
  { id: "V15.rejectAll.onlyActiveValidator", fn:"rejectAllSubmissions", kind:"access", condition:"msg.sender == activeValidator",        errorName:"OnlyActiveValidatorOnly",       failureCategory:"correct_enforcement", failureSubcategory:"only_active_validator_can_reject", v15Constraint:"C3" },
  { id: "V15.rejectAll.allowed",          fn:"rejectAllSubmissions", kind:"state",  condition:"job.allowRejectAll == true",              errorName:"RejectAllNotAllowed",           failureCategory:"correct_enforcement", failureSubcategory:"reject_all_not_allowed" },
  { id: "V15.rejectAll.windowExpired",    fn:"rejectAllSubmissions", kind:"state",  condition:"submissionMode == TIMED ∧ deadline > 0 ⇒ block.timestamp >= deadline", errorName:"SubmissionWindowStillOpen", failureCategory:"correct_enforcement", failureSubcategory:"submission_window_still_open" },
  { id: "V15.rejectAll.subsExist",        fn:"rejectAllSubmissions", kind:"state",  condition:"subs.length > 0",                         errorName:"NoSubmissionsToReject",         failureCategory:"correct_enforcement", failureSubcategory:"no_submissions_to_reject" },
  // Non-terminal: this rule is informational — the function does NOT change job.status
  { id: "V15.rejectAll.nonTerminal",      fn:"rejectAllSubmissions", kind:"constraint", condition:"job.status remains Active after call (no refund)", errorName:"<n/a — design rule>", failureCategory:"correct_enforcement", failureSubcategory:"reject_all_non_terminal", v15Constraint:"C1", notes:"V15 C1: rejectAll marks subs rejected but does NOT cancel the job. Poster must call cancelJob separately." },
];

// ============================================================================
// JobNFT V15 — cancelJob (C2)
// ============================================================================
const CANCEL_JOB_RULES: Rule[] = [
  { id: "V15.cancel.jobExists",     fn:"cancelJob", kind:"state",  condition:"job.poster != 0x0",                              errorName:"JobNotFound",        failureCategory:"agent_too_dumb" },
  { id: "V15.cancel.onlyPoster",    fn:"cancelJob", kind:"access", condition:"msg.sender == job.poster",                       errorName:"OnlyPoster",         failureCategory:"correct_enforcement", failureSubcategory:"only_poster_can_cancel" },
  { id: "V15.cancel.statusOpenOrActive", fn:"cancelJob", kind:"state", condition:"job.status in {Open,Active}",                errorName:"JobNotCancellable",  failureCategory:"correct_enforcement", failureSubcategory:"job_not_cancellable" },
  { id: "V15.cancel.allSubsTerminal",fn:"cancelJob", kind:"state", condition:"every sub status in {rejected, not_selected}",   errorName:"HasPendingOrApproved", failureCategory:"correct_enforcement", failureSubcategory:"has_pending_or_approved", v15Constraint:"C2", notes:"V15 C2: pending=0 AND approved=0 (was: zero submissions in V14)." },
];

// ============================================================================
// JobNFT V15 — finalizeTimedJob (C6)
// ============================================================================
const FINALIZE_TIMED_RULES: Rule[] = [
  { id: "V15.finalize.timed",          fn:"finalizeTimedJob", kind:"state", condition:"submissionMode == TIMED",                    errorName:"NotTimed",           failureCategory:"correct_enforcement", failureSubcategory:"finalize_only_timed" },
  { id: "V15.finalize.deadlineSet",    fn:"finalizeTimedJob", kind:"state", condition:"submissionDeadline > 0",                     errorName:"NoSubmissionsYet",   failureCategory:"correct_enforcement", failureSubcategory:"no_submissions_yet" },
  { id: "V15.finalize.windowExpired",  fn:"finalizeTimedJob", kind:"state", condition:"block.timestamp >= submissionDeadline",      errorName:"WindowStillOpen",    failureCategory:"correct_enforcement", failureSubcategory:"submission_window_still_open" },
  { id: "V15.finalize.notDone",        fn:"finalizeTimedJob", kind:"state", condition:"job.status not in {Completed,Cancelled}",    errorName:"AlreadyFinalized",   failureCategory:"correct_enforcement", failureSubcategory:"already_finalized" },
  { id: "V15.finalize.zombieJobFix",   fn:"finalizeTimedJob", kind:"constraint", condition:"validationMode == HARD_ONLY ∧ no passing subs ⇒ Cancelled + refund + JobCancelled event",
    errorName:"<n/a — design rule>", failureCategory:"correct_enforcement", failureSubcategory:"timed_zombie_fix", v15Constraint:"C6",
    notes:"V15 C6: was a stuck-job bug in V14; V15 cancels + refunds." },
];

// ============================================================================
// ReviewGate V4 rules
// ============================================================================
const REVIEW_GATE_RULES: Rule[] = [
  { id: "V4.isBlocked.cap",        fn:"isBlocked", kind:"gate",  condition:"returns true if pendingReviewCount[addr] >= maxPendingReviews (default 5)", errorName:"<n/a — view>", failureCategory:"correct_enforcement", failureSubcategory:"pending_review_cap" },
  { id: "V4.setupJobReviews.auth", fn:"setupJobReviews", kind:"access", condition:"msg.sender ∈ authorized (typically the JobNFT contract)", errorName:"NotAuthorized", failureCategory:"correct_enforcement", failureSubcategory:"not_authorized_setup_reviews" },
  { id: "V4.setupJobReviews.lengthMatch", fn:"setupJobReviews", kind:"precondition", condition:"reviewers.length == reviewees.length", errorName:"LengthMismatch", failureCategory:"agent_too_dumb" },
  { id: "V4.setupJobReviews.notSelf", fn:"setupJobReviews", kind:"precondition", condition:"reviewer != reviewee for each pair", errorName:"SelfReviewPair", failureCategory:"agent_too_dumb" },
  { id: "V4.setupJobReviews.noDuplicate",fn:"setupJobReviews", kind:"precondition", condition:"!mustReview[jobId][r][e] (no duplicate pair)", errorName:"DuplicatePair", failureCategory:"agent_too_dumb" },
  { id: "V4.submitReview.scoreRange",fn:"submitReview", kind:"precondition", condition:"score in [1,5]", errorName:"InvalidScore", failureCategory:"agent_too_dumb" },
  { id: "V4.submitReview.notSelf",   fn:"submitReview", kind:"precondition", condition:"reviewee != msg.sender", errorName:"CannotReviewSelf", failureCategory:"agent_too_dumb" },
  { id: "V4.submitReview.pairAuthorized",fn:"submitReview", kind:"access", condition:"mustReview[jobId][msg.sender][reviewee] == true", errorName:"PairNotAuthorized", failureCategory:"correct_enforcement", failureSubcategory:"pair_not_authorized" },
  { id: "V4.setRatingWeights.sum100",fn:"setRatingWeights", kind:"precondition", condition:"localPct + erc8004Pct == 100", errorName:"WeightsMustSumTo100", failureCategory:"agent_too_dumb" },
  { id: "V4.getAgentRating.blend",  fn:"getAgentRating", kind:"constraint", condition:"blends local-weighted-avg (1..5×100bps) and ERC-8004 (0..10000bps→0..500bps), 60/40 default. Falls through to local-only if ERC-8004 disabled or registry unreachable.",
    errorName:"<n/a — view>", failureCategory:"correct_enforcement", failureSubcategory:"rating_blend",
    notes:"CURRENT STATE (2026-04-26): AgentIdentityRegistry at 0x8004A818 is NOT enumerable, so ERC-8004 blending is dormant; getAgentRating returns local-only. localBps = (sumOfScores * 100) / count, range 100..500." },
];

// ============================================================================
// All rules + lookup helpers
// ============================================================================
export const RULES: Rule[] = [
  ...CREATE_JOB_RULES,
  ...CLAIM_VALIDATOR_RULES,
  ...SUBMIT_WORK_RULES,
  ...APPROVE_RULES,
  ...REJECT_RULES,
  ...REJECT_ALL_RULES,
  ...CANCEL_JOB_RULES,
  ...FINALIZE_TIMED_RULES,
  ...REVIEW_GATE_RULES,
];

export function getRulesForFunction(fnName: string): Rule[] {
  return RULES.filter((r) => r.fn === fnName);
}

// ============================================================================
// Eligibility predicates — HLO uses these to pre-check before dispatching.
// "Soft" checks: doesn't have to be exhaustive (the chain enforces).
// Goal: avoid dispatching obvious-revert tx that wastes agent time + gas.
// ============================================================================

export interface AgentSnapshot {
  address: `0x${string}`;
  ethWei: bigint;            // current ETH balance
  usdcMicros: bigint;        // current USDC balance (6 decimals)
  pendingReviewCount: number;
  ratingBps: number;         // 0..500
  reviewCount: number;
}

export interface JobSnapshot {
  jobId: number;
  poster: `0x${string}`;
  status: number;            // 0=Open 1=Active 2=Completed 3=Cancelled
  validationMode: number;    // 0=HARD_ONLY 1=SOFT_ONLY 2=HARD_THEN_SOFT
  submissionMode: number;    // 0=FCFS 1=TIMED
  submissionDeadline: number; // unix ts
  activeValidator: `0x${string}`;
  validatorWaitlist: `0x${string}`[];
  approvedWorkers: `0x${string}`[];
  approvedValidators: `0x${string}`[];
  openValidation: boolean;
  allowResubmission: boolean;
  allowRejectAll: boolean;
  minWorkerRating: number;
  minValidatorRating: number;
  hasBeenValidator?: Record<string, boolean>; // optional — only checked if HLO has it cached
  pastValidators?: Record<string, boolean>;
  pastSubmittersByAddress?: Record<string, number>; // count of times this addr already submitted
}

export type AgentAction =
  | "create_job"
  | "claim_validator"
  | "submit_work"
  | "approve_submission"
  | "reject_submission"
  | "reject_all"
  | "cancel_job"
  | "finalize_timed_job"
  | "submit_review";

export interface EligibilityResult {
  eligible: boolean;
  reasons: Array<{ ruleId: string; condition: string; errorName: string }>;
  warnings: string[]; // non-blocking (e.g. low ETH)
}

/**
 * Pre-check whether `agent` could plausibly perform `action` on `job` without
 * an obvious revert. Conservative — true negatives are fine (chain enforces);
 * false negatives (saying eligible when chain reverts) waste a dispatch.
 *
 * Some checks (e.g. transferFrom, allowance) are NOT included because they
 * depend on agent intent and runtime state — the agent is responsible for
 * approving USDC etc. before submitting.
 *
 * Per V15-DESIGN section 2 + spec C-D priority: eligibility is checked AFTER
 * action selection, so the daemon can fall through to the next candidate.
 */
export function checkAgentEligibility(
  agent: AgentSnapshot,
  job: JobSnapshot | null,
  action: AgentAction,
  options: { rejectionReasonRules?: boolean; reviewGateMaxPending?: number } = {}
): EligibilityResult {
  const reasons: EligibilityResult["reasons"] = [];
  const warnings: string[] = [];
  const cap = options.reviewGateMaxPending ?? 5;

  // Universal: pending review cap (gates everything except submit_review itself)
  if (action !== "submit_review" && agent.pendingReviewCount >= cap) {
    reasons.push({
      ruleId: action === "create_job" ? "V15.createJob.reviewGateNotBlocked"
        : action === "claim_validator" ? "V15.claim.reviewGateNotBlocked"
        : action === "submit_work" ? "V15.submit.reviewGateNotBlocked"
        : "V4.isBlocked.cap",
      condition: `pendingReviewCount(${agent.pendingReviewCount}) < ${cap}`,
      errorName: "ReviewGate: too many pending reviews",
    });
  }

  // ETH for gas — warning, not block (auditor categorizes as infra_issue/insufficient_eth)
  if (agent.ethWei < 200_000_000_000_000n) { // 0.0002 ETH = ~5 std txs
    warnings.push(`low ETH: ${(Number(agent.ethWei) / 1e18).toFixed(6)}`);
  }

  if (action === "create_job") {
    // We don't know rewardAmount here — caller should also gate on USDC balance + allowance
    return { eligible: reasons.length === 0, reasons, warnings };
  }

  if (!job) {
    reasons.push({ ruleId: "any.jobRequired", condition: "job != null", errorName: "JobNotFound" });
    return { eligible: false, reasons, warnings };
  }

  const me = agent.address.toLowerCase();
  const poster = job.poster.toLowerCase();

  if (action === "claim_validator") {
    if (job.status !== 0 && job.status !== 1) reasons.push({ ruleId: "V15.claim.statusOpenOrActive", condition: "status in {Open,Active}", errorName: "JobNotOpenForValidators" });
    if (poster === me) reasons.push({ ruleId: "V15.claim.notPoster", condition: "msg.sender != poster", errorName: "PosterCannotValidate" });
    if (job.validationMode === 0) reasons.push({ ruleId: "V15.claim.validationModeNotHardOnly", condition: "validationMode != HARD_ONLY", errorName: "NoValidatorNeeded" });
    if (!job.openValidation && !job.approvedValidators.map((a) => a.toLowerCase()).includes(me)) {
      reasons.push({ ruleId: "V15.claim.inApprovedValidators", condition: "msg.sender ∈ approvedValidators", errorName: "NotApprovedValidator" });
    }
    if (job.activeValidator.toLowerCase() === me) reasons.push({ ruleId: "V15.claim.notAlreadyActive", condition: "msg.sender != activeValidator", errorName: "AlreadyActiveValidator" });
    if (job.validatorWaitlist.map((a) => a.toLowerCase()).includes(me)) reasons.push({ ruleId: "V15.claim.notInWaitlist", condition: "msg.sender ∉ waitlist", errorName: "AlreadyInWaitlist" });
    if (job.hasBeenValidator?.[me]) reasons.push({ ruleId: "V15.claim.notPastValidator", condition: "!hasBeenValidator", errorName: "AlreadyServed" });
    if (job.minValidatorRating > 0) {
      if (agent.reviewCount < 3) reasons.push({ ruleId: "V15.claim.ratingGateValidator", condition: `reviewCount(${agent.reviewCount}) >= 3`, errorName: "JobNFT: validator rating below threshold" });
      else if (agent.ratingBps < job.minValidatorRating) reasons.push({ ruleId: "V15.claim.ratingGateValidator", condition: `ratingBps(${agent.ratingBps}) >= ${job.minValidatorRating}`, errorName: "JobNFT: validator rating below threshold" });
    }
    return { eligible: reasons.length === 0, reasons, warnings };
  }

  if (action === "submit_work") {
    if (poster === me) reasons.push({ ruleId: "V15.submit.notPoster", condition: "msg.sender != poster", errorName: "PosterCannotSubmit" });
    if (job.status !== 0 && job.status !== 1) reasons.push({ ruleId: "V15.submit.statusOpenOrActive", condition: "status in {Open,Active}", errorName: "JobNotOpenForSubmissions" });
    if (job.validationMode !== 0) {
      if (job.activeValidator.toLowerCase() === me) reasons.push({ ruleId: "V15.submit.notActiveValidator", condition: "msg.sender != activeValidator", errorName: "ValidatorCannotSubmit" });
      if (job.validatorWaitlist.map((a) => a.toLowerCase()).includes(me)) reasons.push({ ruleId: "V15.submit.notInWaitlist", condition: "msg.sender ∉ waitlist", errorName: "ValidatorCannotSubmit" });
      if (job.pastValidators?.[me]) reasons.push({ ruleId: "V15.submit.notFormerValidator", condition: "!pastValidators", errorName: "FormerValidatorCannotSubmit" });
    }
    if (job.approvedWorkers.length > 0 && !job.approvedWorkers.map((a) => a.toLowerCase()).includes(me)) {
      reasons.push({ ruleId: "V15.submit.inApprovedWorkers", condition: "msg.sender ∈ approvedWorkers", errorName: "NotApprovedWorker" });
    }
    if (job.submissionMode === 1 && job.submissionDeadline > 0 && Date.now() / 1000 > job.submissionDeadline) {
      reasons.push({ ruleId: "V15.submit.windowOpen", condition: "block.timestamp <= submissionDeadline", errorName: "WindowClosed" });
    }
    if (!job.allowResubmission && (job.pastSubmittersByAddress?.[me] ?? 0) > 0) {
      reasons.push({ ruleId: "V15.submit.allowResubmission", condition: "!alreadySubmitted", errorName: "ResubmissionNotAllowed" });
    }
    if (job.minWorkerRating > 0) {
      if (agent.reviewCount < 3) reasons.push({ ruleId: "V15.submit.ratingGateWorker", condition: `reviewCount(${agent.reviewCount}) >= 3`, errorName: "JobNFT: worker rating below threshold" });
      else if (agent.ratingBps < job.minWorkerRating) reasons.push({ ruleId: "V15.submit.ratingGateWorker", condition: `ratingBps(${agent.ratingBps}) >= ${job.minWorkerRating}`, errorName: "JobNFT: worker rating below threshold" });
    }
    return { eligible: reasons.length === 0, reasons, warnings };
  }

  if (action === "approve_submission" || action === "reject_submission" || action === "reject_all") {
    if (job.status !== 1) reasons.push({ ruleId: "V15.approve.statusActive", condition: "status == Active", errorName: "JobNotActive" });
    if (job.activeValidator.toLowerCase() !== me) reasons.push({ ruleId: "V15.approve.onlyActiveValidator", condition: "msg.sender == activeValidator", errorName: "OnlyActiveValidator" });
    if (action === "reject_all") {
      if (job.validationMode === 0) reasons.push({ ruleId: "V15.rejectAll.notHardOnly", condition: "validationMode != HARD_ONLY", errorName: "NoValidatorHardOnly" });
      if (!job.allowRejectAll) reasons.push({ ruleId: "V15.rejectAll.allowed", condition: "allowRejectAll", errorName: "RejectAllNotAllowed" });
    }
    return { eligible: reasons.length === 0, reasons, warnings };
  }

  if (action === "cancel_job") {
    if (poster !== me) reasons.push({ ruleId: "V15.cancel.onlyPoster", condition: "msg.sender == poster", errorName: "OnlyPoster" });
    if (job.status !== 0 && job.status !== 1) reasons.push({ ruleId: "V15.cancel.statusOpenOrActive", condition: "status in {Open,Active}", errorName: "JobNotCancellable" });
    // C2 — caller must verify all subs are rejected/not_selected
    return { eligible: reasons.length === 0, reasons, warnings };
  }

  if (action === "finalize_timed_job") {
    if (job.submissionMode !== 1) reasons.push({ ruleId: "V15.finalize.timed", condition: "submissionMode == TIMED", errorName: "NotTimed" });
    if (job.submissionDeadline === 0) reasons.push({ ruleId: "V15.finalize.deadlineSet", condition: "deadline > 0", errorName: "NoSubmissionsYet" });
    if (Date.now() / 1000 < job.submissionDeadline) reasons.push({ ruleId: "V15.finalize.windowExpired", condition: "block.timestamp >= deadline", errorName: "WindowStillOpen" });
    if (job.status === 2 || job.status === 3) reasons.push({ ruleId: "V15.finalize.notDone", condition: "status not in {Completed,Cancelled}", errorName: "AlreadyFinalized" });
    return { eligible: reasons.length === 0, reasons, warnings };
  }

  if (action === "submit_review") {
    // No on-chain block here (the cap is on others, not the reviewer). Caller
    // ensures the reviewer is actually owed a review on this job.
    return { eligible: reasons.length === 0, reasons, warnings };
  }

  return { eligible: true, reasons, warnings };
}

// ============================================================================
// Revert decoder — given raw revert data, returns the matching rule (if any)
// ============================================================================

const ERROR_NAME_TO_RULES = (() => {
  const map: Record<string, Rule[]> = {};
  for (const r of RULES) {
    if (!map[r.errorName]) map[r.errorName] = [];
    map[r.errorName].push(r);
  }
  return map;
})();

/**
 * Best-effort revert decoder. Given a revert reason string (decoded by viem
 * with the full ABI from contracts.ts), returns the rule(s) that produced it
 * so the auditor can categorize.
 *
 * The actual viem-side decoding lives in framework/auditor.mjs (it has the
 * ABI to walk). This function is the lookup once you have the name/string.
 */
export function decodeRevertReason(errorNameOrString: string): Rule[] {
  if (!errorNameOrString) return [];
  // Exact match first
  if (ERROR_NAME_TO_RULES[errorNameOrString]) return ERROR_NAME_TO_RULES[errorNameOrString];
  // Substring search for revert strings (e.g. "JobNFT: validator rating below threshold")
  const norm = errorNameOrString.trim();
  for (const [name, rules] of Object.entries(ERROR_NAME_TO_RULES)) {
    if (name.includes(norm) || norm.includes(name)) return rules;
  }
  return [];
}

// ============================================================================
// Convenience exports
// ============================================================================
export const RULE_IDS = RULES.map((r) => r.id);
export const RULE_COUNT = RULES.length;

// All custom error names defined on V15 + V4 (for ABI sanity-check during deploy)
export const V15_ERROR_NAMES = [
  "AlreadyActiveValidator","AlreadyFinalized","AlreadyInWaitlist","AlreadyReviewed","AlreadyServed",
  "DeliverableRequired","DescriptionRequired","FormerValidatorCannotSubmit","HardOnlyApprovedVal",
  "HardOnlyValRating","HasPendingOrApproved","InstructionsRequired","InsufficientAllowance",
  "InsufficientBalance","InvalidSubmissionIndex","InvalidSubmissionMode","InvalidValidationMode",
  "JobNotActive","JobNotCancellable","JobNotFound","JobNotOpenForSubmissions","JobNotOpenForValidators",
  "NoActiveValidator","NoScriptSoftOnly","NoSubmissionsToReject","NoSubmissionsYet","NoValidatorHardOnly",
  "NoValidatorNeeded","NotApprovedValidator","NotApprovedWorker","NotTimed","OnlyActiveValidator",
  "OnlyActiveValidatorOnly","OnlyActiveValidatorReject","OnlyAutomation","OnlyPoster","PosterCannotSubmit",
  "PosterCannotValidate","RatingGateNoReviewGate","RefundFailed","RejectAllNotAllowed","RequirementsRequired",
  "ResubmissionNotAllowed","RewardZero","ScriptCIDNotAllowed","ScriptCIDRequired","ScriptValidationRequired",
  "SecurityAuditRequired","SubmissionAlreadyReviewed","SubmissionWindowStillOpen","TitleRequired",
  "TokenNotFound","TransferFailed","TransferFromFailed","ValidatorCannotSubmit","WindowClosed",
  "WindowMustBeZero","WindowRequiredTimed","WindowStillOpen","WorkerCannotValidate","WorkerTransferFailed",
];
export const V4_ERROR_NAMES = [
  "CannotReviewSelf","DuplicatePair","InvalidScore","LengthMismatch","NotAuthorized","PairNotAuthorized",
  "SelfReviewPair","WeightsMustSumTo100",
];
