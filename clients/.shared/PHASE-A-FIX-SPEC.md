# Phase A Fix Spec — Intent-Driven Classification + Review-Count Invariant + A.8 Cutover

**Goal:** Unblock the matrix coverage flywheel. Currently 13/268 cells passed because the scanner classifies every successful soft-mode job as `s02-validator-first` regardless of HLO's actual dispatch intent. Three concrete fixes; all three must land for the dashboard to reflect reality.

**Audit context that motivated this spec:** Isaiah ran `/api/test-results/lifecycle?project=awp&status=passed` and saw 13 cells passed, ALL in the `s02-validator-first` column. HLO has been dispatching 12 distinct scenarios (s01, s02, s03, s04, s05, s06, s08, s09, s10, s12, s16, plus s00 in-flight). The scanner is collapsing them. Root cause traced to `lib/awp/cell-defs.ts` PRIORITY-based first-match classification + `framework/scanner.mjs` deliberately ignoring `orchestration_events.meta.intended_*`.

---

## Fix 1 — Replace predicate-based classification with intent lookup

**File:** `framework/scanner.mjs` (the new STS scanner; runs as pm2 `sts-scanner` on VPS).

**Current behavior** (lines 357-389 area):
```js
const configKey = classifyJobKey(job);              // derives config from on-chain state
const scenarioKey = classify(ctx);                  // runs PREDICATES in PRIORITY order
// upserts row with config_key=configKey, scenario_key=scenarioKey
```

**New behavior:**
```js
// 1. Read HLO's intent from orchestration_events for THIS job_id
const intent = await fetchIntentFromOrchEvents(supabase, jobId);
// intent: { intended_config, intended_scenario, dispatch_block, agent }
// May be null if the job was created outside HLO (e.g., legacy swarm-drain)

// 2. Derive the OBSERVED shape via existing classify() — but for AUDIT, not classification.
const observedScenario = classify(ctx);             // existing predicate logic
const observedConfig = classifyJobKey(job);

// 3. Canonical scenario/config = HLO's intent. Fall back to observed only if no intent recorded.
const scenarioKey = intent?.intended_scenario || observedScenario;
const configKey   = intent?.intended_config   || observedConfig;

// 4. Audit signal — did observed match intended?
const intent_matched = intent
  ? (intent.intended_scenario === observedScenario && intent.intended_config === observedConfig)
  : null;  // no intent = pre-HLO job, can't audit
```

**Helper to add** (inside scanner.mjs):
```js
async function fetchIntentFromOrchEvents(supabase, jobId) {
  // Look for the most recent verified createJob orch_event for this on-chain job_id.
  // HLO writes intended_config + intended_scenario into meta on every dispatch.
  const r = await supabase
    .from('orchestration_events')
    .select('meta, ran_at')
    .eq('project_id', 'awp')
    .eq('event_type', 'dispatch_create_job')
    .filter('meta->>onchain_job_id', 'eq', String(jobId))
    .order('ran_at', { ascending: false })
    .limit(1);
  if (r.error || !r.data?.length) return null;
  const meta = r.data[0].meta || {};
  return {
    intended_config: meta.intended_config || null,
    intended_scenario: meta.intended_scenario || null,
    dispatch_block: meta.block || null,
    agent: meta.dispatched_agent || null,
  };
}
```

**Schema additions to `lifecycle_results` table** (Supabase migration):
```sql
-- supabase/migrations/0006_lifecycle_intent_match.sql
ALTER TABLE lifecycle_results
  ADD COLUMN IF NOT EXISTS observed_scenario_key text,
  ADD COLUMN IF NOT EXISTS observed_config_key   text,
  ADD COLUMN IF NOT EXISTS intent_matched        boolean;

COMMENT ON COLUMN lifecycle_results.observed_scenario_key IS
  'What the cell-defs predicates would classify this job as (audit-only). The canonical scenario_key reflects HLO''s recorded intent.';
COMMENT ON COLUMN lifecycle_results.observed_config_key IS
  'What classifyJobKey() derives from on-chain state (audit-only).';
COMMENT ON COLUMN lifecycle_results.intent_matched IS
  'NULL = no HLO intent recorded (legacy job). true = observed matches intended. false = mismatch (audit finding).';
```

The scanner upsert payload now writes both intended (canonical) and observed (audit) fields.

---

## Fix 2 — Enforce per-validationMode review-count invariant

**File:** `framework/scanner.mjs`. After event indexing for a job, before deciding `status`:

```js
// Per AWP domain rules:
//   HARD_ONLY      (validationMode=0): expect 2 ReviewSubmitted events  (peer-rating on script result)
//   SOFT_ONLY      (validationMode=1): expect 5 ReviewSubmitted events  (peer-rating on validator decision)
//   HARD_THEN_SOFT (validationMode=2): expect 5 ReviewSubmitted events  (peer-rating on validator decision)
const expectedReviews =
  job.validationMode === 0 ? 2 :
  job.validationMode === 1 ? 5 :
  job.validationMode === 2 ? 5 : null;

const observedReviews = (events.ReviewSubmitted || []).length;

let status;
if (job.status === 0 || job.status === 1) {
  status = 'running';                                          // open or active
} else if (job.status === 3) {
  status = 'failed';                                           // cancelled
} else if (job.status === 2) {
  // Completed on-chain. Now check review invariant.
  if (expectedReviews !== null && observedReviews < expectedReviews) {
    status = 'partial';                                        // job completed but ReviewGate short
  } else {
    status = 'passed';
  }
}
```

**Schema:**
```sql
-- supabase/migrations/0007_lifecycle_review_invariant.sql
ALTER TABLE lifecycle_results
  ADD COLUMN IF NOT EXISTS expected_reviews integer,
  ADD COLUMN IF NOT EXISTS observed_reviews integer;
```

The scanner writes both columns on every upsert. Dashboard can render a "review-count short" filter.

**Why this matters:** Isaiah saw 5 of 29 passed jobs in `soft-timed-multi-rating-approved` having only 4 ReviewSubmitted events vs the expected 5. This is either (a) ReviewGate let the job complete with fewer reviews than required (contract bug — HIGH SEVERITY), or (b) scanner missing an event from a chunk fetch (scanner bug). Either way, marking these `partial` instead of `passed` surfaces them for investigation rather than silently inflating coverage.

---

## Fix 3 — Phase A.8 cutover

**Goal:** Stop the legacy VPS swarm from creating duplicate jobs in already-touched cells.

**Three cron lines on VPS root crontab. Comment (don't delete):**

```bash
ssh root@45.32.82.83 "crontab -l > /tmp/crontab.bak && crontab -l | sed -E '
  s|^(\*/5 \* \* \* \* /usr/bin/flock -n /tmp/awp-drain.lock.*)|# DISABLED 2026-05-01 (Phase A.8 cutover): \1|;
  s|^(\*/15 \* \* \* \* \. /root/.awp-env; /usr/bin/node /root/test-swarm/awp-scanner-v15\.mjs.*)|# DISABLED 2026-05-01 (Phase A.8 cutover): \1|
' | crontab -"
```

**KEEP RUNNING:** `*/15 * * * * matrix-steering.mjs` — HLO consumes its `target-gaps.json` output. Don't touch.

**Start the new STS scanner:**

```bash
ssh root@45.32.82.83 "cd /root/test-swarm-v2 && pm2 start sts-scanner --name sts-scanner --cron '*/5 * * * *' || pm2 restart sts-scanner"
```

If `/root/test-swarm-v2` doesn't exist, the new scanner needs to be SCPd over first. Check via `ssh root@45.32.82.83 'pm2 jlist | grep -i sts-scanner'`. The Phase A code is local at `framework/scanner.mjs` and `lib/awp/*.js`; SCP that whole tree.

**Verify cutover:**
```bash
ssh root@45.32.82.83 "crontab -l | grep -E 'swarm-drain|awp-scanner-v15|matrix-steering'"
ssh root@45.32.82.83 "pm2 list | grep -E 'sts-scanner|matrix'"
```

Expected: 2 lines commented (`# DISABLED ...`), 1 line live (matrix-steering), `sts-scanner` showing `online`.

---

## Deploy + verify steps

1. Edit `framework/scanner.mjs` per Fix 1 + Fix 2 above.
2. Apply both Supabase migrations against the AWP project (`nyhwpkxezlwkwmjuklaj`). Use Supabase Management API per memory `reference_supabase_orgs.md` if needed.
3. SCP `framework/scanner.mjs` and `lib/awp/*.js` to `/root/test-swarm-v2/` (or wherever sts-scanner expects them). Confirm path via `ssh root@45.32.82.83 'pm2 describe sts-scanner | grep cwd'` first.
4. `pm2 restart sts-scanner` on VPS.
5. Run cutover (Fix 3).
6. Verify: `curl 'https://swarm-testing-services.vercel.app/api/test-results/lifecycle?project=awp&status=passed' | jq '.matrix.cells | keys | length'` should jump from 13 → 80+ within one scanner cycle (5 min after restart) as existing data gets re-classified against orch_events intent.
7. Spot-check the audit signal: query `lifecycle_results` for rows where `intent_matched = false` — those are real bugs (HLO dispatched s07, contract behavior produced something else, scanner correctly observed mismatch).

---

## Out of scope for this fix (track separately)

- s02-validator-first predicate is no longer used as a classifier, but stays in `cell-defs.ts` PREDICATES as part of the audit-shape derivation. Don't delete.
- The 952 `running` rows in production: many are legacy swarm-drain jobs that may never reach terminal state because their wallets are dry. Leave them. Future cleanup pass can `DELETE FROM lifecycle_results WHERE created_at < '2026-05-01' AND status='running'` once we're confident no in-flight legacy job will recover.
- The API route `/api/test-results/lifecycle` does NOT need changes — it already keys cells by `lifecycle_results.scenario_key`, which now reflects intent. Re-verify after deploy.
- Auditor (`framework/auditor.mjs`) Layer 4: future work to triage `intent_matched = false` rows into the failure taxonomy.

---

## Definition of done

After deploy:
- `cells_passed` jumps from 13 → 80+ within 30 min purely from re-classification.
- Within 4h, `cells_passed >= 100` (matches the success-metric target from the original kickoff).
- No new rows in `lifecycle_results` from old swarm-drain (it's disabled).
- New rows have `intent_matched` populated (true/false/null).
- Spot-check 5 random `partial`-status rows to confirm they're genuine review-count shortfalls.
