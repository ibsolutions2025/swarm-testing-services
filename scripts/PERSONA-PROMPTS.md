# Persona prompts

Canonical prompt templates for `scripts/swarm-agent-runner.mjs`. This
document is the source of truth for what the LLM agents see; the runner
renders these verbatim. Any change to wording here must also update the
runner's `buildPrompt()` function.

## Insider-info rules (applies to EVERY prompt)

**Do NOT include in ANY prompt passed to an LLM agent:**
- Scenario keys (`s01`, `s02`, …, `s20`) in any form
- Config keys (`hard-open-single-open-open`, etc.) in any form
- "Test", "scenario", "matrix", "lifecycle", "harness", "validation-mode"
  as enum values (`HARD_ONLY` / `SOFT_ONLY` / `HARD_THEN_SOFT`)
- "Expected outcome", "should pass", "should fail"
- Any mention of STS, the scanner, Supabase, or the coverage matrix
- The `CUTOVER_UTC` constant or "mechanical" / "script-driven" framing

**What agents MAY see:**
- Their own SOUL (persona description)
- The job's public-looking content (title, description, requirements as
  human-readable text)
- The on-chain state visible to any AWP user (poster wallet, current
  validator, existing submissions)
- A natural task prompt ("you want to post a job", "you're reviewing
  this", "you're considering whether to submit")

The runner enforces this mechanically: every prompt string is scanned
with the same 8-pattern regex set from `lib/insider-audit.ts` before
being sent, and any match throws.

## TEMPLATES

### create

**System:** `[persona SOUL content — loaded from agents/awp-test-N/SOUL.md]`

**User:**
```
You want to post a new job on the AgentWork Protocol. Job constraints:
  - Reward: {rewardUSDC} USDC
  {render each constraints[] line as a bullet}

Pick any topic that fits how you operate as an agent — something you'd
genuinely want done by another agent. Write a concise title (under 80
chars) and a 2-3 sentence description that a worker could act on. Don't
mention AWP internals, don't label the job as any kind of trial, don't
reference platform machinery.

Return strictly JSON: {"title": "...", "description": "..."}
```

**Constraint-line translations (produced by swarm-create.mjs, passed in
via `context.constraints[]`):**

| on-chain param              | bullet line                                                      |
|-----------------------------|------------------------------------------------------------------|
| `validationMode=0` (hard)   | Automated script checks the submission                           |
| `validationMode=1` (soft)   | Reviewer judges by hand                                          |
| `validationMode=2` (both)   | Automated check first, then human review                         |
| `submissionMode=0` (FCFS)   | First valid submission wins the job                              |
| `submissionMode=1` (multi)  | Multiple workers can submit; reviewer picks the best             |
| `deadline=timed`            | 2-hour submission window                                         |
| `deadline=open`             | No submission deadline                                           |
| `workerAccess=approved`     | Only specific workers you trust can take this                    |
| `workerAccess=rating`       | Workers need a reputation score of at least 4.0                  |
| `workerAccess=open`         | Any worker can take this                                         |
| `validatorAccess=approved`  | Only specific reviewers you trust                                |
| `validatorAccess=rating`    | Reviewers need a reputation score of at least 4.0                |
| `validatorAccess=open`      | Any qualified reviewer can judge this                            |

### submit

**System:** `[persona SOUL]`

**User:**
```
A job is open on the AgentWork Protocol.
Title: {title}
Description: {description}
Reward: {rewardUSDC} USDC
Posted by: {posterShort}

You've decided to submit work on this. Produce a plausible deliverable
URL (must start with https://, length >= 50, and include a comma — the
URL can be invented; think of it as where your work would live). Add a
1-2 sentence note about what you submitted. Stay in character.

Return strictly JSON: {"deliverableUrl": "...", "note": "..."}
```

### review

**System:** `[persona SOUL]`

**User:**
```
You're reviewing a submission on the AgentWork Protocol.
Job:
  Title: {title}
  Description: {description}
Submission by {workerShort}:
  Deliverable URL: {deliverableUrl}
  Note: "{submitterNote}"

Decide whether to approve or reject, pick a rating from 1-5, and write a
1-3 sentence review comment. Be consistent with your character — if your
persona is blunt, write bluntly. If you're generous, be generous.

Return strictly JSON: {"decision":"approve"|"reject","score":1|2|3|4|5,"comment":"..."}
```

## Retry + fallback behavior

1. First call. If the response parses and matches the result shape,
   done.
2. If parse or coerce fails, append an `assistant` turn (the bad reply)
   and a corrective `user` turn (`"Your previous reply was not valid JSON
   matching the required shape. Respond with only the JSON object
   specified — no commentary, no code fences."`), then call again.
3. Hard cap: 3 turns total. On double failure, return the deterministic
   fallback below with `fell_back: true` stamped on the result.

### Deterministic fallbacks (only on double parse failure)

| taskType | fallback                                                                                                                                                   |
|----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| create   | `{ title: "New task — consolidated", description: "A job for an autonomous agent on AWP.", fell_back: true }`                                              |
| submit   | `{ deliverableUrl: \`https://awp-submissions.example.com/job${jobId},${personaLower}-delivery-auto-fallback\`, note: "Submitted.", fell_back: true }`      |
| review   | `{ decision: "approve", score: 4, comment: "Meets the requirement.", fell_back: true }`                                                                    |

These are **boring on purpose** — a fallback is an audit-trail alarm,
not the norm. If the Operations panel shows more than a handful of
`outcome=fallback` runner log lines per day, treat it as a model or
prompt regression and debug.

## Persona-selection rules (for the caller, not the runner)

The caller (swarm-drain / swarm-create) decides which persona runs each
task. Hard constraints:

- **approve / reject:** persona = the agent whose address equals
  `job.activeValidator`. No substitution.
- **submit:** persona = any worker-eligible agent per `approvedWorkers[]`.
  Caller iterates its round-robin order and picks the first eligible one.
- **create:** persona = the round-robin poster for the current cycle.

Do **not** bias persona choice by intended scenario. If Bridge is the
active validator on a job annotated `s05`, Bridge gets the prompt and
decides in Bridge's voice. If Bridge approves, the row lands in `s01`.
That's a real coverage signal, not a steering failure — the matrix
fills in from natural persona variation over hundreds of cycles.

Scenario steering is **limited to event-order scenarios** — the ones
that only exist because the mechanical layer forced a specific sequence
or timing:

- `s02-validator-first` — claim BEFORE any submit
- `s06-validator-waitlist` — second claim before first approves
- `s08-worker-no-show` — posted timed, don't dispatch a worker
- `s09-validator-no-show` — dispatch a submitter, don't claim a validator
- `s10-reject-all-cancel` — after all rejections, cancel on behalf of poster

Outcome scenarios (`s01`, `s03`, `s04`, `s05`, `s12`, `s16`) are **never**
steered. `intended-scenarios.json` is read only for event-order
scenarios; for outcome scenarios it is ignored.
