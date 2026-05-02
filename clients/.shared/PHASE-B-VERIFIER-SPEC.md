# Phase B — Per-Cell Verifier (replaces Phase A's intent-driven classification)

**Status:** spec. Authored by Cowork session `nifty-gifted-mendel` after audit with Isaiah on 2026-05-01. Builds on the Phase A landing (`commit 0d80ef8`, deploy `dpl_E76kah1P26graDmVpJoMyGsWsQAT`) and replaces its scanner-side classifier.

**Why this exists.** Phase A made the dashboard truthful but not actually correct. "Passed" today verifies two things — `job.status === 2` on chain, and `observedReviews >= expectedReviews`. It does not verify that the cell's scenario actually played out. 30 of 130 currently-passed rows have `intent_matched = false`: HLO tried to steer toward scenario X but the on-chain lifecycle resolved to scenario Y, and Phase A credits cell (config, X) anyway because canonical `scenario_key` falls back to HLO's intent. That's wrong by Isaiah's reading: cell membership is determined by observation at terminal state, not by HLO's intent.

This phase rewrites classification + verification so that "passed" means "every required event for this (config, scenario) cell happened correctly, with the right actors, in the right order, with the right outcomes."

---

## Six design points (pre-agreed with Isaiah)

1. **Per-cell lifecycle definitions, programmatically generated.** A function `generateLifecycle(scenario, config) → CellLifecycle` produces 1680 distinct cell lifecycles from the cross product of 20 scenarios × 84 configs. The generator parameterizes scenario skeletons by config axes (`validationMode`, `submissionMode`, `openValidation`, `allowResubmission`, `allowRejectAll`, `minWorkerRating`, `minValidatorRating`, `workerAccess`, `validatorAccess`).

2. **Per-step pass/fail criteria with on-chain proof.** Each step in a cell's lifecycle has explicit verifications: required event signature, expected actor wallet (mapped to HLO's persona record), expected args, optional ordering constraint, optional revert-with-error for negative-scenario steps. Verification reads the on-chain receipt or the indexed event log; if any verification fails, that step's `status = 'failed' | 'missing' | 'unexpected'`.

3. **Job NFT passes only when ALL its steps pass.** No partial credit. Includes the contract setup verification (the on-chain `getJobV15(id)` config bytewise matches the cell's `config_key`) and the per-step lifecycle verification. Negative scenarios (s13, s15) "pass" via expected reverts being the right reverts.

4. **Cell membership = observed scenario at terminal.** Once a job reaches `job.status === 2 || 3`, the scanner runs the (now disjoint) scenario predicates and locks the row's canonical `scenario_key` to whichever predicate matched. Pre-terminal rows display under HLO's intended cell only for visualization; this is a UI hint, not coverage data.

5. **Cell passes when ≥1 job NFT, observed in that cell, has all-steps-passed.** Multiple jobs in flight or partial in the same cell don't matter; one observed-terminal-pass is sufficient.

6. **Disjoint + exhaustive predicates.** Any terminal lifecycle must match exactly one scenario predicate. No overlap, no gaps. The current `lib/awp/cell-defs.ts` PRIORITY-based first-match-wins is a workaround for non-disjoint predicates and must go. Predicates need to be tightened so first-match isn't necessary.

---

## Architecture — split scanner into three modules

Today: `framework/scanner.mjs` is one ~500-line monolith doing event indexing + classification + DB upsert.

After this spec:

```
framework/
├── indexer.mjs       Pure event/receipt indexing. No classification.
├── verifier.mjs      Per-job verdict logic. Owns lifecycle generation + step
│                     verification + scenario classification.
├── aggregator.mjs    Cell-level aggregation. Reads job verdicts, writes
│                     lifecycle_results rows.
└── scanner.mjs       Thin orchestrator: tick → indexer → verifier → aggregator.
                      Also handles error reporting + heartbeats.
```

Optional: keep `scanner.mjs` as the orchestrator (retain pm2 process name `sts-scanner`) but refactor internals to the three modules above. Avoids cron / pm2 churn.

### `framework/indexer.mjs`

**Responsibility:** pull on-chain data; emit normalized records.

**Outputs (in-memory or staging table):**

- `events[]` — every emitted event from `JOBNFT_V15` and `REVIEWGATE_V4` since the last cursor, decoded with `lib/awp/events.ts`. Includes `event_signature`, `args`, `tx_hash`, `block_number`, `log_index`, `actor` (extracted from indexed topic when applicable).
- `tx_attempts[]` — for every `tx_hash` recorded in `orchestration_events.meta.tx_hash`, fetch `eth_getTransactionReceipt`. Record `success | reverted`, plus revert reason decoded against the V15 + V4 custom error ABIs in `lib/awp/contracts.ts`. **This is new data flow** — required for negative scenarios (s13, s15) where "pass" means "the contract correctly reverted with the expected error."
- `job_state[]` — for every job touched in this tick, full `getJobV15(id)` + `getSubmissionV11(id, i) for all i`.

**Failure mode:** if a chunk of `eth_getLogs` fails, mark affected job IDs as `indexed = false` for this tick and skip them downstream. Don't write partial data.

### `framework/verifier.mjs`

**Responsibility:** for each job touched this tick, decide a verdict.

**Pseudocode:**

```js
async function verifyJob(jobId, indexedData) {
  const job = indexedData.job_state[jobId];
  const events = indexedData.events.filter(e => e.args.jobId === jobId);
  const txAttempts = indexedData.tx_attempts.filter(t => t.intended_job_id === jobId);

  // Step 1 — verify the on-chain config matches the cell's config_key.
  // Note: cell's config is locked at JobCreated time. We verify the contract
  // accepted the config HLO intended.
  const intent = await fetchIntentFromOrchEvents(jobId);
  const intendedConfig = intent?.intended_config || classifyJobKey(job);
  const onChainConfig = configFromGetJob(job);  // pure function: V15 fields → config_key
  const configValidated = (onChainConfig === intendedConfig);

  // Step 2 — determine observed scenario via disjoint predicates.
  // Pre-terminal: in-flight (use intent for cell display).
  // Terminal: exactly one scenario must match.
  const isTerminal = job.status === 2 || job.status === 3;
  let observedScenario;
  if (!isTerminal) {
    observedScenario = 's00-in-flight';
  } else {
    const matches = ALL_SCENARIOS.filter(s => s.predicate(events, job, txAttempts));
    if (matches.length === 0) {
      observedScenario = 'unclassified';  // gap in predicate set — flag for backlog
    } else if (matches.length > 1) {
      throw new VerifierError(`predicates not disjoint: job ${jobId} matches ${matches.map(m=>m.id)}`);
    } else {
      observedScenario = matches[0].id;
    }
  }

  // Step 3 — generate the cell's expected lifecycle.
  const cellLifecycle = generateLifecycle(observedScenario, onChainConfig);
  // cellLifecycle = { steps: [{ event, actor_role, args_predicate, order_predicate, revert_predicate? }, ...] }

  // Step 4 — verify each step against indexed data.
  const stepVerdicts = cellLifecycle.steps.map(stepDef =>
    verifyStep(stepDef, events, txAttempts, intent.persona_map)
  );

  // Step 5 — combine into row verdict.
  const allStepsPass = stepVerdicts.every(v => v.status === 'passed');
  let rowStatus;
  if (!isTerminal) rowStatus = 'running';
  else if (job.status === 3 && observedScenario.startsWith('s08-') === false /* ... */) rowStatus = 'failed';
  else if (!configValidated) rowStatus = 'config_mismatch';
  else if (allStepsPass) rowStatus = 'passed';
  else rowStatus = 'partial';

  return {
    onchain_job_id: jobId,
    config_key: onChainConfig,            // canonical = OBSERVED
    scenario_key: observedScenario,        // canonical = OBSERVED at terminal
    status: rowStatus,
    steps: stepVerdicts,                   // each has its own status: passed|failed|missing|unexpected
    intent_matched: isTerminal && intent
      ? (observedScenario === intent.intended_scenario && onChainConfig === intent.intended_config)
      : null,
    config_validated: configValidated,
    intended_config: intent?.intended_config || null,
    intended_scenario: intent?.intended_scenario || null,
    verification_failures: stepVerdicts.filter(v => v.status !== 'passed').map(v => ({
      step: v.step_index,
      reason: v.reason,
      expected: v.expected,
      observed: v.observed
    }))
  };
}
```

### `verifyStep(stepDef, events, txAttempts, persona_map)` — what each step checks

Per step, the verdict is `passed` only if EVERY assertion in `stepDef` holds.

**For positive (event-required) steps:**

```js
function verifyStep(stepDef, events, txAttempts, personaMap) {
  // 1. The expected event must exist.
  const matching = events.filter(e =>
    e.event === stepDef.event &&
    (stepDef.cardinality_min === undefined || true /* aggregate logic */) &&
    stepDef.args_predicate(e.args)
  );
  if (matching.length < (stepDef.cardinality_min ?? 1)) {
    return { status: 'missing', step_index: stepDef.index, expected: stepDef, reason: 'event_not_emitted' };
  }

  // 2. Actor verification — the wallet that emitted (or was indexed in)
  //    the event matches the role expected by the cell's persona map.
  for (const event of matching) {
    const expectedActor = personaMap[stepDef.actor_role];  // e.g., 'worker' → 0xd318...
    if (expectedActor && event.actor.toLowerCase() !== expectedActor.toLowerCase()) {
      // Allow some flexibility for s03-competitive-workers (any of {worker1, worker2})
      if (!(stepDef.actor_pool && stepDef.actor_pool.includes(event.actor.toLowerCase()))) {
        return { status: 'failed', step_index: stepDef.index, reason: 'wrong_actor',
                 expected: expectedActor, observed: event.actor };
      }
    }
  }

  // 3. Ordering — if step has order_predicate, verify against earlier events.
  if (stepDef.order_predicate) {
    const ok = stepDef.order_predicate(matching, events);
    if (!ok) return { status: 'failed', step_index: stepDef.index, reason: 'order_violation' };
  }

  return { status: 'passed', step_index: stepDef.index, tx_hash: matching[0].tx_hash, block: matching[0].block_number };
}
```

**For negative (revert-required) steps — used by s13, s15:**

```js
function verifyRevertStep(stepDef, txAttempts) {
  const matching = txAttempts.filter(t =>
    t.intended_action === stepDef.action &&
    t.actor.toLowerCase() === stepDef.expected_actor.toLowerCase()
  );
  if (matching.length === 0) {
    return { status: 'missing', step_index: stepDef.index, reason: 'no_attempt_indexed' };
  }
  const attempt = matching[0];
  if (attempt.outcome !== 'reverted') {
    return { status: 'failed', step_index: stepDef.index, reason: 'expected_revert_but_succeeded' };
  }
  if (attempt.revert_reason !== stepDef.expected_error) {
    return { status: 'failed', step_index: stepDef.index, reason: 'wrong_revert_error',
             expected: stepDef.expected_error, observed: attempt.revert_reason };
  }
  return { status: 'passed', step_index: stepDef.index, tx_hash: attempt.tx_hash };
}
```

### `framework/aggregator.mjs`

**Responsibility:** convert per-job verdicts into `lifecycle_results` rows AND per-cell `cells` aggregations.

**Cell aggregation rule:**

```
For cell (config_X, scenario_Y):
  rows_for_cell = lifecycle_results WHERE config_key = X AND scenario_key = Y
                  (canonical, observed, post-terminal-locking)
  cell.status =
    'passed'    if any row has status='passed' AND config_validated=true
    'partial'   if no passed but at least one row has status='partial'
    'failed'    if no passed/partial but at least one row has status='failed'
    'running'   if at least one in-flight row is being steered toward this cell
                (use orchestration_events.intended for in-flight bucketing)
    'untested'  if no rows
    'na'        if isCellApplicable(config_X, scenario_Y) === false
```

Pre-terminal rows render under HLO's intended cell. This is the only place intent enters the dashboard view.

---

## The lifecycle generator — `lib/awp/generate-lifecycle.ts`

Signature:

```ts
type StepDef = {
  index: number;
  name: string;
  event?: EventName;                                  // for positive steps
  cardinality_min?: number;
  cardinality_max?: number;
  actor_role?: 'poster' | 'worker' | 'worker1' | 'worker2' | 'validator' | 'validator2' | 'reviewer' | 'contract';
  actor_pool?: string[];                              // for "any of" — populated at dispatch time from persona_map
  args_predicate?: (args: any) => boolean;
  order_predicate?: (matching: Event[], allEvents: Event[]) => boolean;

  // for negative steps
  action?: 'createJob' | 'claimJobAsValidator' | 'submitWork' | ...;
  expected_actor?: string;
  expected_error?: string;                            // V15 custom error name
};

type CellLifecycle = {
  config_key: string;
  scenario_id: string;
  applicable: boolean;                                // false → cell is N/A
  steps: StepDef[];
  notes?: string;
};

function generateLifecycle(scenarioId: string, config: ConfigParams): CellLifecycle;
```

The generator implements scenario-specific rules and substitutes config-specific details:

- For HARD_ONLY configs: replaces the validator-claim step with a contract-emitted `ScriptResultRecorded` step + contract-self auto-approval (actor=address(0) or contract self).
- For HARD_THEN_SOFT: includes BOTH the script step AND the validator step.
- For minWorkerRating > 0 configs in s01-happy-path: adds an actor-precondition that worker.rating ≥ minWorkerRating.
- For workerAccess=approved configs: adds actor_pool = approvedWorkers[].
- For TIMED submissionMode: adds a deadline-related step where applicable.
- For the review steps: cardinality is 2 (HARD_ONLY) or 5 (otherwise).

Implementation strategy: scenario-by-scenario `case` block that returns the assembled steps. ~600 lines of TypeScript. Maintainable because each scenario's case is independent.

---

## Per-scenario reference — required structures (the spec for the generator)

For each scenario, the generator must produce these lifecycle elements. Cardinalities and actors are already documented in `lib/awp/scenarios.ts`; this section gives the implementation contract.

```
s01-happy-path (any config)
  Steps:
    1. JobCreated            actor: poster
    2. WorkSubmitted         actor: worker      (cardinality: 1)
    3. ValidatorClaimed      actor: validator   [skip if HARD_ONLY]
       OR ScriptResultRecorded(scriptPassed=true)  [HARD_ONLY only]
    4. SubmissionApproved    actor: activeValidator (or contract for HARD_ONLY)
    5..N. ReviewSubmitted    actor: reviewer pool   (cardinality: 2 if HARD_ONLY, else 5)
  Forbidden: SubmissionRejected, AllSubmissionsRejected, JobCancelled.

s02-validator-first (validationMode != HARD_ONLY)
  Steps:
    1. JobCreated            actor: poster
    2. ValidatorClaimed      actor: validator
    3. WorkSubmitted         actor: worker      (ORDER: 2.block < 3.block)
    4. SubmissionApproved    actor: activeValidator
    5..9. ReviewSubmitted    cardinality: 5

s03-competitive-workers (TIMED || allowResubmission)
  Steps:
    1. JobCreated
    2. WorkSubmitted         actor: worker1     (cardinality_min: 1)
    3. WorkSubmitted         actor: worker2     (DIFFERENT wallet from #2)
    4. ValidatorClaimed                          [skip if HARD_ONLY]
    5. SubmissionApproved    args: submission picks one of {2, 3}
    6..N. ReviewSubmitted    cardinality per validationMode

s04-rejection-loop (validationMode != HARD_ONLY && allowResubmission)
  Steps:
    1. JobCreated
    2. WorkSubmitted         (cardinality_min: 1)
    3. ValidatorClaimed
    4. SubmissionRejected    actor: activeValidator   (ORDER: 4.block before 6)
    5. WorkSubmitted         (resubmission, optional same worker)
    6. SubmissionApproved    actor: activeValidator
    7..N. ReviewSubmitted    cardinality: 5

s05-total-rejection (SOFT_ONLY && allowRejectAll)
  Steps:
    1. JobCreated
    2. WorkSubmitted (cardinality_min: 1)
    3. ValidatorClaimed
    4. AllSubmissionsRejected   actor: activeValidator
    5. (reviews follow per V15 ReviewGate flow)
  Forbidden: JobCancelled
  Terminal: job.status MUST equal Active (status=1), not Cancelled.

s06-validator-waitlist (!HARD_ONLY && openValidation)
  Steps:
    1. JobCreated
    2. ValidatorClaimed (cardinality: 2+, distinct validators)
       ORDER: only first becomes activeValidator; rest enter waitlist
    3. WorkSubmitted, SubmissionApproved (or rejection loop) — terminal scenario
  Verify: at terminal, distinctValidatorClaims >= 2 AND only one ever became active.

s07-validator-rotation (TIMED && !HARD_ONLY)
  Steps:
    1. JobCreated
    2. ValidatorClaimed (validator A, claims first)
    3. (validator A times out — verify by event: ValidatorTimedOut or by clock check)
    4. RotateValidator  actor: contract or anyone
    5. ValidatorClaimed (validator B, distinct from A)
    6. SubmissionApproved by validator B
  Status: classifiable but currently aspirational. Verify when on-chain rotation events exist.

s08-worker-no-show (TIMED, any validationMode)
  Steps:
    1. JobCreated
    2. (no WorkSubmitted within submissionWindow)
    3. JobCancelled    actor: poster (calling cancelJob after deadline)
  Forbidden: WorkSubmitted (zero submissions ever).

s09-validator-no-show (TIMED && !HARD_ONLY)
  Steps:
    1. JobCreated
    2. WorkSubmitted (cardinality_min: 1)
    3. (no ValidatorClaimed within validatorTimeoutSeconds)
    4. JobCancelled    actor: poster or anyone (deadline-driven cancel path)
  Forbidden: ValidatorClaimed (zero validator claims ever).

s10-reject-all-cancel (SOFT_ONLY && allowRejectAll)
  Steps:
    1..4: same as s05 through AllSubmissionsRejected
    5. JobCancelled    actor: poster   (ORDER: 5.block > 4.block)
  Distinguishes from s05 by presence of JobCancelled AFTER AllSubmissionsRejected.

s11-deadline-expiry (TIMED && HARD_ONLY)
  Steps:
    1. JobCreated
    2. WorkSubmitted (≥1 with scriptPassed=false, optional)
    3. (deadline elapses with no passing submission)
    4. TimedJobFinalized → JobCancelled

s12-rating-gate-pass (minWorkerRating > 0 || minValidatorRating > 0)
  Steps: same as s01 happy-path skeleton, PLUS pre-conditions:
    - Worker that calls submitWork has rating ≥ minWorkerRating (verified via reading
      the worker's on-chain rating at action block)
    - Validator that claims has rating ≥ minValidatorRating
  No revert occurred.

s13-rating-gate-fail (same applicability)
  Negative scenario.
  Step:
    1. tx_attempt: submitWork OR claimJobAsValidator from a wallet with rating < threshold
  Expected: tx reverted with custom error matching RatingGateFailed (or equivalent in V15).
  Verify via tx_receipt + decoded revert_reason.

s14-rating-gate-new-user (same applicability)
  Negative scenario.
  Step:
    1. tx_attempt: submitWork from a wallet with reviewCount < 3
  Expected: tx reverted with custom error indicating new-user gate failed.

s15-approved-not-approved (workerAccess=approved || validatorAccess=approved)
  Negative scenario.
  Step:
    1. tx_attempt from wallet NOT in approvedWorkers (or approvedValidators)
  Expected: tx reverted with NotApproved custom error.

s16-multiple-submissions (allowResubmission && !HARD_ONLY)
  Steps:
    1. JobCreated
    2. WorkSubmitted from worker A
    3. WorkSubmitted from worker A (resubmission; SAME wallet)
    4. ValidatorClaimed
    5. SubmissionApproved (picks one of {2, 3})
    6..N. ReviewSubmitted
  Verify: cardinality 2+ from same worker; allowResubmission was true on chain.

s17-hard-validation-auto (HARD_ONLY)
  Steps:
    1. JobCreated  (config validates: minValidatorRating=0, approvedValidators=[])
    2. WorkSubmitted    actor: worker
    3. ScriptResultRecorded   args: { scriptPassed: true }
    4. SubmissionApproved   actor: address(0) OR contract self
    5..6. ReviewSubmitted   cardinality: 2 (HARD_ONLY review count)
  Forbidden: ValidatorClaimed (HARD_ONLY has no validator).

s18-hard-then-soft (HARD_THEN_SOFT)
  Steps:
    1. JobCreated
    2. WorkSubmitted
    3. ScriptResultRecorded(scriptPassed=true)   ORDER: before step 4
    4. ValidatorClaimed
    5. SubmissionApproved   actor: activeValidator (NOT contract — soft phase)
    6..10. ReviewSubmitted  cardinality: 5
```

(The generator implements the scenario branch + per-config substitution: review counts, actor pools, applicability checks, and revert-error names.)

---

## Schema additions to `lifecycle_results`

```sql
-- supabase/migrations/0009_phase_b_verifier.sql
ALTER TABLE lifecycle_results
  ADD COLUMN IF NOT EXISTS config_validated boolean,
  ADD COLUMN IF NOT EXISTS verification_failures jsonb,
  ADD COLUMN IF NOT EXISTS intended_config text,
  ADD COLUMN IF NOT EXISTS intended_scenario text;

COMMENT ON COLUMN lifecycle_results.config_validated IS
  'On-chain getJobV15(id) config bytewise matches the cell.config_key. Required for status=passed.';

COMMENT ON COLUMN lifecycle_results.verification_failures IS
  'Array of step-level failures: [{ step, reason, expected, observed }, ...]. Empty when status=passed.';

COMMENT ON COLUMN lifecycle_results.intended_config IS
  'HLO''s recorded intent at dispatch time. Diagnostic-only; coverage uses canonical config_key.';

COMMENT ON COLUMN lifecycle_results.intended_scenario IS
  'HLO''s recorded intent at dispatch time. Diagnostic-only; coverage uses canonical scenario_key.';
```

The existing `observed_scenario_key`, `observed_config_key`, `intent_matched`, `expected_reviews`, `observed_reviews` columns from Phase A all stay. They become diagnostics.

The change in semantics: canonical `scenario_key` is now `observed_scenario_key` at terminal (or HLO intent for in-flight). Existing rows need a backfill pass.

---

## tx_attempts table (new — for negative scenarios)

```sql
-- supabase/migrations/0010_tx_attempts.sql
CREATE TABLE IF NOT EXISTS tx_attempts (
  id              bigserial PRIMARY KEY,
  project_id      text NOT NULL,
  tx_hash         text NOT NULL,
  block_number    bigint,
  intended_action text,         -- 'createJob' | 'submitWork' | 'claimJobAsValidator' | 'approveSubmission' | 'rejectAllSubmissions' | etc.
  intended_job_id bigint,
  actor           text NOT NULL,
  outcome         text NOT NULL,  -- 'success' | 'reverted' | 'pending' | 'timeout'
  revert_reason   text,           -- decoded custom-error name when reverted
  raw_revert_data text,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS tx_attempts_project_job_idx
  ON tx_attempts (project_id, intended_job_id);
```

HLO writes a `tx_attempts` row for every transaction it dispatches. Indexer reads receipts and updates `outcome` + `revert_reason`. Verifier reads from this table for negative scenarios.

This is the new data flow. HLO already records tx_hash in `orchestration_events.meta`; this table normalizes that data and adds the receipt-level outcome.

---

## Backfill — re-classify existing 130 passed rows

After verifier deploys, run a one-shot:

```js
// scripts/backfill-phase-b.mjs
// For every job in lifecycle_results, re-run verifier.verifyJob(jobId).
// Upsert the result. Report cells whose status changed.
```

Expected outcome: many rows currently `passed` will flip to `partial` (because steps fail verification — wrong actor, missing event, etc.). The 32 currently-displayed cells will likely drop to a smaller number that reflects truly-tested cells. THIS IS THE GOAL — the dashboard should under-report rather than over-report coverage.

---

## Disjoint + exhaustive predicate work — `lib/awp/cell-defs.ts` rewrite

Today's predicates overlap heavily; PRIORITY workaround masks it. New requirement:

For any terminal lifecycle, **exactly one** predicate matches. Achieve by:

1. **s01-happy-path** tightens to: `status=2 AND approved=1 AND rejected=0 AND distinctWorkers=1 AND vc<=1 AND minWorkerRating=0 AND minValidatorRating=0`. (No rating gates — those go to s12.)
2. **s02-validator-first** tightens to: same as s01 PLUS validator-claim block ≤ JobCreated.block + 2 (validator pro-actively claimed near-instantly), AND distinguishes from s06 by single validator only.
3. **s12-rating-gate-pass** picks up cases where rating gates were set AND lifecycle completed (steals from s01/s03/s04).
4. **s06-validator-waitlist** requires distinct validator claims ≥ 2 (already strict).
5. Negative scenarios (s13/s14/s15) match on `tx_attempts.outcome='reverted'` rows, no overlap with positive scenarios.

After this rewrite, the verifier's classifier function is:

```js
const matches = ALL_SCENARIOS.filter(s => s.predicate(events, job, txAttempts, config));
assert(matches.length <= 1, 'predicates not disjoint: ' + matches.map(m=>m.id));
return matches[0]?.id || 'unclassified';
```

If multiple match, that's a bug — throw immediately. If none match, the row is `unclassified`; flag for predicate-set expansion.

---

## Migration order

1. Land `tx_attempts` migration (0010) — empty table, no-op if HLO doesn't yet write to it.
2. Update HLO to write `tx_attempts` rows on every dispatch (separate small change to `framework/hlo-daemon.mjs`).
3. Land `lifecycle_results` columns migration (0009).
4. Build `framework/verifier.mjs` + `lib/awp/generate-lifecycle.ts`.
5. Tighten `lib/awp/cell-defs.ts` predicates to disjoint+exhaustive.
6. Rewrite `framework/scanner.mjs` to use the new modules.
7. Deploy scanner to VPS, restart pm2.
8. Run `scripts/backfill-phase-b.mjs` to re-classify existing rows.
9. Verify dashboard. Expect Passed count to DROP significantly. That's the point.

Estimated work: 1500-2500 lines of new code, 300-500 lines deleted. CC session of ~4-6 hours.

---

## Definition of done

- Every cell has a programmatically-generated lifecycle definition.
- Every passed row has `verification_failures = []` AND `config_validated = true`.
- Every partial row has at least one entry in `verification_failures`.
- Predicate set is disjoint: no two predicates match the same terminal lifecycle.
- Backfill complete: existing 130 passed rows re-evaluated; some now `partial` with explicit reasons.
- Dashboard renders the new `Passed` count; this number is now defensible — every passed cell has a job whose every step passed verification.
- HLO writes `tx_attempts` rows on dispatch; negative scenarios (s13, s15) can now be tested.

---

## Out of scope for this phase

- HLO daemon changes beyond `tx_attempts` writes — steering algorithm stays as-is.
- `matrix-steering.mjs` gap-pool selection — stays as-is.
- `framework/auditor.mjs` (Layer 4) — its reactive triage logic is fine; it'll consume the new `verification_failures` column.
- New scenarios beyond s01..s18 — wait until predicates and verifier are stable.
- Per-cell UI in the dashboard (showing each step's verdict in the modal) — useful but separate UX work.

---

## Risk + rollback

If the new verifier proves too slow per tick (>5 min for full sweep), it'll fall behind cron. Mitigation: process only the last N updated jobs per tick, not the full backlog. Backfill happens off-tick in a separate one-shot.

Rollback is clean: the old `scanner.mjs` is preserved as `scanner.legacy.mjs` and pm2 can switch back via env var. Phase A's intent-driven canonical key is wrong but the system runs; if Phase B has a bug we revert.

The one-way door is the `tx_attempts` table: once HLO writes to it and code reads from it, removing the table breaks production. But since the table's pure additive, low-risk.
