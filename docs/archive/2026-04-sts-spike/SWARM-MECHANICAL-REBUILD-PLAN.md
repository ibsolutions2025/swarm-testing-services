# AWP Swarm — Mechanical Rebuild Plan

## Problem

Current `auto-cycle.mjs` uses Kimi K2.6-TEE (via Chutes) for every decision — "should I claim validator on job 635?" burns 25 turns of reasoning for a choice you can compute in 3 lines of JS. Result:

- ~800 Kimi calls per hour from the swarm alone
- Chutes cap exceeded → fallbacks to Gemma-4 → still expensive + slower
- Flywheel outcomes: 4 new jobs / 9 hours, 526/662 rows stuck at `s00-in-flight`
- Coverage: 11 of 13 terminal scenarios sparse or empty (s02, s10, s12, s16 totally empty)

## Root Insight

The AWP lifecycle is deterministic from on-chain state. An LLM isn't needed to:

- List open jobs (deterministic RPC read)
- Claim validator when none is set (if-empty write)
- Submit work with a template URL (if-eligible write)
- Approve/reject based on a scoring rule
- Submit reviews on completed jobs

The LLM IS valuable for:

- Creative job title/description generation (one-shot, cheap)
- Coverage strategy (which cells to target — hourly, low volume)
- Edge-case judgment (probably not even needed for testing)

## Architecture

Three layers, each with a different cost model:

```
┌─────────────────────────────────────────────────────────┐
│ LAYER 3 — Director (Cowork scheduled task, 1×/hour)     │
│ - Reviews STS Supabase coverage                         │
│ - Regenerates target-gaps.json                          │
│ - Picks next-scenario-to-force                          │
│ - ~$0 (Claude Max subscription)                         │
└────────────┬────────────────────────────────────────────┘
             │ writes target-gaps.json + intended-scenarios.json
             ▼
┌─────────────────────────────────────────────────────────┐
│ LAYER 2 — Create (VPS cron, every 15 min)               │
│ - Reads target-gaps.json                                │
│ - Picks highest-priority uncovered (config, scenario)   │
│ - Posts a single job with matching params               │
│ - Annotates intended-scenarios.json with jobId → key    │
│ - Title/description: template + optional Gemma-4 fuzz   │
│ - ~$0.50/day (OpenRouter, or 0 if pure templates)       │
└────────────┬────────────────────────────────────────────┘
             │ jobs appear on-chain
             ▼
┌─────────────────────────────────────────────────────────┐
│ LAYER 1 — Drain (VPS cron, every 5 min)                 │
│ - Scans last 80 on-chain jobs                           │
│ - Deterministic state machine per job:                  │
│   - status 0 + no validator + not poster → claim        │
│   - status 0-1 + no subs + validator set → submit       │
│   - status 0-1 + pending sub + agent=validator → judge  │
│   - status ≥2 + agent is participant → review           │
│ - Scenario-aware: reads intended-scenarios.json to      │
│   pick approve vs reject vs rejectAll vs cancel         │
│ - No LLM calls. Only viem writes.                       │
│ - ~$0 (just gas)                                        │
└─────────────────────────────────────────────────────────┘
```

## Scenario production map

Scanner classifies a job's scenario from the pattern of events emitted. To
force a specific scenario, drain must emit the right event sequence:

| scenario_key             | Required event pattern                                         |
|--------------------------|----------------------------------------------------------------|
| s01-happy-path           | submit → claim → approve (default)                             |
| s02-validator-first      | claim FIRST → submit → approve                                 |
| s03-competitive-workers  | submit_A → submit_B → claim → approve_one                      |
| s04-rejection-loop       | submit → claim → reject → submit → reject → submit → approve  |
| s05-total-rejection      | submit → claim → reject → submit → reject → rejectAll (or cancel) |
| s06-validator-waitlist   | claim_A → claim_B (timeout) → submit → approve                 |
| s08-worker-no-show       | *no submission* → wait timed deadline → finalize              |
| s09-validator-no-show    | submit → *no claim* → wait timed deadline → finalize          |
| s10-reject-all-cancel    | submit → claim → rejectAll → cancelJob                         |
| s12-rating-gate-pass     | (minRating > 0 in requirements) → submit → claim → approve     |
| s16-multiple-submissions | submit_A → submit_B → claim → approve_one (requires resubmission enabled) |

## Config → scenario mapping constraints

- `s08` + `s09` require `submissionMode=1` (timed) + reasonable `submissionWindow`
- `s16` requires `allowResubmission=true` + `submissionMode=1` (multi)
- `s12` requires `minWorkerRating>0` in the requirements JSON (rating-gated)
- `s06` requires at least 2 waitlisted validators — only works when `validatorAccess=open` or agent is in the approved list
- `s10` + `s04` + `s05` require `submissionMode=1` (allowRejectAll)

Create layer enforces these when picking (config, scenario) pairs.

## Implementation

Three files + one JSON map:

- `/root/test-swarm/swarm-drain.mjs` — Layer 1
- `/root/test-swarm/swarm-create.mjs` — Layer 2
- `/root/test-swarm/intended-scenarios.json` — bootstrap empty `{}`, Create writes to it, Drain reads from it
- Cowork scheduled task `awp-director` — Layer 3

## Deployment order (tonight)

1. Write swarm-drain.mjs locally (this repo), scp to VPS
2. Write swarm-create.mjs locally, scp to VPS
3. Seed intended-scenarios.json `{}` on VPS
4. Manual run of swarm-drain.mjs on VPS — confirm it progresses 5+ jobs
5. Manual run of swarm-create.mjs on VPS — confirm it creates 1 job with correct config + scenario annotation
6. Replace crontab entries — remove 7 auto-cycle lines, add 2 new lines:
   - `*/5 * * * * /root/test-swarm/swarm-drain.mjs >> /var/log/awp-drain.log 2>&1`
   - `*/15 * * * * /root/test-swarm/swarm-create.mjs >> /var/log/awp-create.log 2>&1`
7. Monitor 1 hour — verify new rows in lifecycle_results, scenario diversity growing
8. Register Cowork awp-director scheduled task (hourly)

## Success criteria (1 hour post-deploy)

- `status='running'` row count decreases (jobs progressing past s00)
- At least 1 new row appears in each of: s02, s10, s12, s16 (scenarios previously empty)
- Chutes call count stays near 0 for the swarm
- At least 20 progressions (submit/claim/approve/reject/review tx) in the hour

## Rollback plan

- Keep auto-cycle.mjs in place; only the cron entries change
- Rollback = restore old 10-min-staggered crontab from `/tmp/cron.bak.YYYYMMDD`
- No schema changes, no UI changes, no on-chain state changes beyond adding more valid jobs

## Not in scope tonight (saved for follow-up)

- Layer 3 Director (next session — 168 Cowork fires/week fits easily in Max)
- Scanner enrichment (step_audits + cell_audit) — already drafted as Claude Code prompt
- Transactions drawer role-labeled wallets — already drafted as Claude Code prompt
- Migrating the other Chutes agents (leadpass-*, unbrowse-*, yield-*, mining) — separate concern, those are daily not high-frequency
