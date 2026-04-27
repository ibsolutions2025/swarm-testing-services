You are a protocol-lifecycle analyst. Given the protocol's primary contract source + event list + state-changing function list, enumerate the SCENARIOS the protocol can produce.

A SCENARIO is a coherent end-to-end lifecycle TRAJECTORY of the protocol's central asset (job, campaign, order, etc.) from creation to a terminal state. Examples:
  - happy path: post → claim → submit → approve → completed
  - rejection path: post → claim → submit → reject → resubmit → approve
  - no-show path: post → window expires with zero submissions → cancel/finalize
  - validator-rotation path: post → claim → timeout → rotate → claim → ...

# CRITICAL — branch scenarios by LIFECYCLE PATH, NOT by config mode

A scenario describes the SEQUENCE of state transitions a job goes through. Configuration modes (HARD_ONLY vs SOFT_ONLY vs HARD_THEN_SOFT, FCFS vs TIMED, open vs approved-list, etc.) are ALREADY enumerated by the matrix axes. They are NOT what distinguishes one scenario from another.

**Wrong (don't do this):**
  - s01-happy-path-hard-only
  - s02-happy-path-soft-only
  - s03-happy-path-hardsift
This triples the scenario count without adding any lifecycle insight — all three describe the same trajectory (post → submit → approve → completed). The classifier will pick the right CELL (config combination) at scan time; the scenario stays the same.

**Right:**
  - s01-happy-path (applicability: "any" — all three validation modes hit this trajectory)
  - s02-validator-first (applicability: "validationMode != HARD_ONLY" — validator claims before any worker submits)
  - s03-competitive-workers (applicability: "submissionMode == FCFS" — multiple workers race; one wins, others get not_selected)
  - s04-rejection-loop (applicability: "allowResubmission == true" — submit→reject→resubmit→approve)
  - s05-validator-waitlist (applicability: "validationMode != HARD_ONLY" — second validator queues when first claims)
  - s06-validator-rotation (applicability: "validationMode != HARD_ONLY" — first validator times out, second rotates in)
  - s07-zero-submissions-cancelled (timed window expires with no work; zombie-job-fix path or poster cancel)

Each of these is a DIFFERENT TRAJECTORY through the state machine. Notice each scenario has a different sequence of events, not just different params on createJob.

# Use `applicability` to filter configs, not branched scenario IDs

When a trajectory only applies to certain configs, encode that in `applicability` (free-form filter expression on config axes). Do NOT clone the scenario into N variants. Examples:
  - "validationMode != HARD_ONLY" — scenario requires a validator to exist
  - "submissionMode == FCFS" — scenario depends on FCFS race semantics
  - "allowResubmission == true" — scenario requires the resubmission flag enabled
  - "any" — applies to every config

# What counts as a separate scenario

Two scenarios are DIFFERENT if they have different:
  - sequence of contract function calls (post → claim → submit vs post → submit → claim)
  - count of intermediate events (one rejection vs many)
  - branching decisions (validator approves vs rejects, worker resubmits vs gives up)
  - terminal states (completed vs cancelled vs cancelled-with-refund)

Two scenarios are the SAME if they only differ by:
  - which validation mode the job used (those become matrix cells)
  - which submission mode the job used
  - which access-control mode (open vs approved-list vs rating-gate)
  - parameter values that don't change the call graph

# Test for "config artifact" branching — apply BEFORE emitting

Rename the candidate scenario by stripping any mode/config suffix (-fcfs, -timed, -hard-only, -soft-only, -approved, -rating-gate). Does the renamed ID become a duplicate of another scenario you've already drafted? If yes, they are the SAME scenario — pick one ID and use `applicability` to restrict configs.

Worked examples (AWP):
  - `s01-happy-path-fcfs` renamed → `s01-happy-path` = same as `s02-happy-path-timed` renamed → `s01-happy-path`. SAME SCENARIO. Merge into one `s01-happy-path` with `applicability: "any"`. The fact that TIMED also emits `TimedJobFinalized` is a CONFIG ARTIFACT, not a different trajectory — that extra event becomes part of the scenario's `requiredEvents` only when the cell is TIMED, encoded via applicability.
  - `s07-competitive-workers-fcfs` renamed → `s07-competitive-workers` remains distinct (timed doesn't have the FCFS race semantics — TIMED finalization picks the first passing submission deterministically, not racewise). KEEP, set `applicability: "submissionMode == FCFS"`.
  - `s12-timed-hard-only-auto-finalize` is genuinely a different trajectory (auto-finalize on timeout with no validator interaction, distinct from happy-path's validator-approves call graph). KEEP DISTINCT.

Subset rule: if scenario A's event set is a SUPERSET of scenario B's because of a config switch (TIMED has TimedJobFinalized that FCFS lacks; rest identical), A and B are the SAME scenario. Encode the extra event with applicability, do not split.

# Output

For each scenario, output:
  - id: stable kebab-case ID, prefixed with sequential s00..sN (e.g. "s01-happy-path")
       s00 is reserved for "in-flight" — the catch-all for jobs that haven't reached a terminal state.
  - label: short title-case label
  - description: 1-2 sentence summary of the TRAJECTORY (what events happen, in what order)
  - status: "classifiable" | "aspirational" | "deferred"
       classifiable = scanner can recognize it from observable on-chain events alone
       aspirational = needs trace-level data (debug_traceTransaction), internal state reads, or off-chain inputs
       deferred     = needs a future contract version

Mark scenarios `aspirational` when the trajectory CANNOT be classified from event logs alone. Concrete AWP examples that MUST be aspirational:
  - `s17-rating-gate-worker-blocked` — depends on `RatingGateFailed` being observable, but that event is emitted INSIDE submitWork BEFORE its revert. The revert rolls back all logs. Only `debug_traceTransaction` can see it.
  - `s18-rating-gate-validator-blocked` — same pattern in claimJobAsValidator.
  - Any scenario whose trigger is "tx reverted with X" — failed transactions emit no logs to a normal scanner.
  - Any scenario depending on `pastValidators[jobId][addr]`, `hasBeenValidator[jobId][addr]`, `mustReview[jobId][r][e]` — internal mappings the scanner doesn't index.
  - Any scenario depending on off-chain inputs (IPFS content of a deliverable, validator reasoning) — out of scope for the chain scanner.

If a scenario's trajectory passes the lifecycle test (it's a real distinct path, not a config artifact) but its detection requires any of the above, status is `aspirational`, NOT `classifiable`.
  - applicability: free-form filter expression on config axes (e.g. "validationMode != HARD_ONLY"). Use "any" for scenarios applicable to all configs.
  - requiredEvents: array of event names that MUST appear (e.g. ["JobCreated", "WorkSubmitted", "SubmissionApproved"])
  - negativeEvents: array of events that MUST NOT appear for this scenario to apply (often empty)
  - terminalState: object describing the final on-chain state (e.g. { "job.status": "Completed", "approvedCount": 1 })
  - notes: optional clarification (especially for aspirational ones)

Aim for 15-25 scenarios that cover DISTINCT lifecycle trajectories. If you have 24+ scenarios and most differ only in config mode, you've branched wrong — collapse and re-derive.

Output JSON ONLY:
{
  "scenarios": [...]
}

Contract source + event names + function names follow.
