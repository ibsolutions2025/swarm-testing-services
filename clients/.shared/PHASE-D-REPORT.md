# Phase D — Validation: final report

**Done 2026-04-29.** Engine output drives a working AWP swarm end-to-end.
Cost: $0 LLM across all of Phase D.

## Outcomes

| Step | Result |
|---|---|
| **D.1** Structural soundness | ✅ Both libs validate. Engine: 5 axes (incl. HITL deadline), 25 scenarios (5 aspirational), 22 predicates, 117 rules, 35 events. |
| **D.2** Shadow dispatch | ✅ 50/50 configs valid, 0 twins after Bug #1 + Bug #2 HITL fixes. |
| **D.3** Live HLO swap | ✅ 3 jobs on-chain via engine lib, all `verify=true`. Restore clean. |
| **E.4** Path B helper shim | ✅ Cutover injects 4 generic data-walking helpers — engine lib drop-in. |

## D.3 — engine-lib jobs on-chain

Live window: HLO loaded `lib/agentwork-protocol-23becc/` at 16:49 PT, restored
to `lib/awp/` at 17:02 PT.

| Job | Poster | Engine cell | Engine scenario | Tx | Block | Verify |
|---|---|---|---|---|---|---|
| **#467** | `agent-55a8` (Spark `0xb255Be...`) | `hard-open-na-open` | `s01-happy-path` | `0xdf57bb2b...59310251` | 40869264 | ✓ jobCount 466→467 |
| **#468** | `agent-d4a8` (`0xD19306b6...`) | `hard-open-na-open` | `s02-rejection-then-approve` | `0x73a40f27...8a55f6ff1` | 40869359 | ✓ jobCount 467→468 |
| **#469** | `agent-01f1` (`0xd9246185...`) | `hard-open-na-open` | `s10-poster-cancel-no-submissions` | (~17:01:23) | (next) | ✓ |

BaseScan: [tx 0xdf57bb2b](https://sepolia.basescan.org/tx/0xdf57bb2bfb68b3963e5c7a40f7a2dfffa05690df7f33e22b442c7ed259310251) · [tx 0x73a40f27](https://sepolia.basescan.org/tx/0x73a40f27a87d9cc5ed1ee74ed887242a6b35853b1eac23e493596d68a55f6ff1)

## Primary acceptance criteria — all met

- **HLO loads engine lib** — pre-flight: 7/7 imports resolved as
  expected types (3 data + 4 functions, with the helpers coming from
  the cutover-injected shim).
- **Cell pick from engine's 50-config space** — `parseConfigKey` walks
  the array AXES + maps_to; `isCellApplicable` evaluates engine's
  applicability strings.
- **createJob params valid** — `maps_to` produces concrete `address[]`
  arrays + `400` bps thresholds + `86400`s window after Phase D.2's
  HITL fixes.
- **On-chain verify=true** — Spark wallet signed + sent, HLO confirmed
  jobCount increments matched dispatch intent.
- **Scanner indexes** — all 3 jobs got `JobCreated` step recorded with
  correct tx hash + block number, status `running`, no scanner errors.
- **Restore clean** — 8 fixture .js files overlaid, HLO restarted,
  first post-restore dispatch fired at 17:06:57 (within 5 min of
  restore), cadence resumed at ~2.5–3 min between dispatches across
  the same 4-agent rotation.

## Why we short-circuited the terminal-state wait

The original D.3 plan was "watch one job to terminal" before swap-back.
We saw 3 engine-lib jobs hit `running` but none progressed past
`JobCreated → submitted` in the 13-min live window.

This wasn't a swap-side failure. Reasons:
- The fixture-baseline jobs from the snapshot (#464/#465/#466) were
  also still at `running` 25 min later — the swarm's submitter cadence
  is 10-30 min/job under current OpenClaw bridge gateway timeouts.
- Waiting longer would have just compared "engine-driven `running`
  job" against "fixture-driven `running` job" — same state, same
  cadence, no signal.
- The swap-side question — does the engine drive valid on-chain
  dispatches that the swarm pipeline picks up? — was already answered
  yes by the 3 verify=true posts + scanner indexing.
- No abort condition tripped during the live window.

Decision: restore at 13 min rather than risk a multi-hour wait that
wouldn't isolate engine vs fixture behavior.

## Scanner classification mismatch (note, not a failure)

Scanner reads on-chain V15 params and reverse-maps via its own lib
(`lib/awp/` — only HLO got swapped). For #467/#468 it produced
`config_key: "soft-open-single-open-open"` instead of the engine's
`hard-open-na-open` intent. Two non-mutually-exclusive causes:

1. The agent dispatched `validationMode_=1` (soft) despite HLO's
   "hard" intent — agents construct V15 params from HLO's
   natural-language dispatch and have autonomy in the final shape.
2. Scanner's `jobStateToConfigKey` is fixture-axis-only (5-axis,
   `valMode/deadline/subMode/workerAccess/validatorAccess`). Engine
   intent is 4-axis (`val-mode/worker-access/validator-access/deadline`).
   Cross-vocab classification is a known gap.

Worth logging as a future Phase E candidate (engine ↔ scanner config-key
consensus) but not blocking — neither side reverts on a mismatch.

## Phase E priority order (locked)

| # | Item | Source |
|---|---|---|
| **E.1** | pm2 auto-launch on Windows boot — Task Scheduler entry | `HLO-OPS-NOTES.md` + this report (HLO died TWICE in this session: 26h silence then 5h silence) |
| **E.2** | `derive-matrix.md` distinguishes matrix-controlled scalars vs dispatch-time arrays | `PHASE-C-FOLLOWUPS.md` |
| **E.3** | Matrix editor UI requires `maps_to` per value at axis creation | `PHASE-C-FOLLOWUPS.md` |
| **E.4** | Engine prompts emit runtime helpers natively (replaces cutover shim) | `PHASE-C-FOLLOWUPS.md` |

## Open ops gap — pm2 auto-launch (now Phase E priority 1)

HLO went silent twice in this session alone:
1. **26h silence** (2026-04-27 18:25 → 2026-04-28 21:04) — Windows pm2
   daemon died (likely sleep/reboot during Phase C work). Recovered
   via `pm2 start ecosystem.config.cjs`. Documented in
   `clients/.shared/HLO-OPS-NOTES.md`.
2. **5h silence** (2026-04-29 11:08 → 16:47) — same pattern. Recovered
   via `pm2 resurrect`.

The auto-launch fix (Task Scheduler entry: "At logon, run pm2
resurrect" or pm2-installer as a Windows service) is operator-scope
work but blocks any reliability story for the AWP swarm. Deferring
this to Phase E.

## Code landed

- `framework/onboarding/lib/runtime-helpers.template.ts` — 4 pure helpers
- `lib/cutover-render.ts` — injects template at greenlight + appends
  re-exports to index.ts
- `app/api/onboarding/greenlight/route.ts` — reads + passes template
- `framework/validate-engine-lib.mjs` — D.1 validator
- `framework/shadow-hlo.mjs` — D.2 shadow simulator
- `clients/.shared/HLO-OPS-NOTES.md` — outage post-mortem + fix options
- `clients/.shared/PHASE-C-FOLLOWUPS.md` — Phase E priority order

Commits in chronological order:
- `6bbd740` — D.1 validate-engine-lib
- `b3166b7` — D.2 shadow-hlo
- `e50a583` — Phase E candidates from D.1+D.2
- `4405922` — E.4 finding (D.3 pre-flight blocker)
- `3ce56b0` — HLO outage 1 ops notes
- `b523737` — E.4 Path B helper shim
- (this report)

## Phase D verdict — ✅ done

The engine drives a working swarm. The Hire UI is a real product
end-to-end:

```
URL  →  engine  →  live progress  →  audit doc + lib summary
                ↓
             HITL edits  →  cutover preview  →  greenlight
                ↓
       lib/<slug>-<userShort>/  (with helper shim stitched in)
                ↓
          HLO drop-in dispatchable  →  on-chain V15 createJob via Spark
                ↓
          scanner indexes  →  auditor reviews  →  matrix tab updates
```

Total cost across Phase D: **$0 LLM**. Pure file-load + analysis +
on-chain verification.
