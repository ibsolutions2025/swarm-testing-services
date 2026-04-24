# Claude Code — Phase 5: Re-agent the Swarm (persona-driven, insider-info-clean)

The mechanical swarm (swarm-drain.mjs + swarm-create.mjs) is live and cheap but it is not actually agentic — 7 private keys controlled by deterministic JS. Phase 5 puts real LLM-driven agents back into the loop for every action that produces content (submit, review, create) while keeping mechanical orchestration for routing + state machine. Agents act in persona voice but receive ZERO test-harness signals in their prompts.

Paste the fenced block into Claude Code at the repo root.

---

```
Phase 5 — re-agent the swarm, insider-info-clean, cost-controlled.

CONTEXT.
  Two VPS cron scripts — scripts/swarm-drain.mjs (*/5) and
  scripts/swarm-create.mjs (*/15) — currently do all work in pure JS with
  no LLM calls. That makes the flywheel cheap and reliable but stops the
  7 personas (Spark/Grind/Judge/Chaos/Scout/Flash/Bridge) from actually
  behaving like agents. We want each ACTION THAT PRODUCES CONTENT
  (submit, review, create) to be produced by a real LLM call in the
  persona's voice. Orchestration stays mechanical; text generation moves
  to agents.

  Also attach heartbeat emission so the Operations tab lights up.

  Cost target — Gemma-4 via OpenRouter, 1-3 turns per call, capped. Expect
  ~$5/day at full throttle (vs $340/day the old Windows swarm burned).

FIVE DELIVERABLES IN THIS PR.

1. scripts/swarm-agent-runner.mjs — NEW single-file LLM dispatcher.
2. scripts/swarm-drain.mjs — patched to call the runner for submit/review/approve.
3. scripts/swarm-create.mjs — patched to call the runner for job title/description.
4. All three VPS scripts (drain, create, and a tiny patch to scanner at
   scripts/scanner-heartbeat-patch.md documenting the VPS-side change)
   emit heartbeat rows to system_heartbeats.
5. scripts/PERSONA-PROMPTS.md — the canonical prompt templates for each
   action type, with explicit DO/DO-NOT rules.

────────────────────────────────────────────────────────────
DELIVERABLE 1 — scripts/swarm-agent-runner.mjs
────────────────────────────────────────────────────────────

Single-entrypoint dispatcher. Takes (persona_name, task_type, context) and
returns a typed result. No viem, no on-chain writes — pure LLM
orchestration. The calling script writes the chain tx using the runner's
output.

SIGNATURES —

  export async function runAgent({
    persona,    // one of: 'Spark','Grind','Judge','Chaos','Scout','Flash','Bridge'
    taskType,   // 'create' | 'submit' | 'review'
    context,    // see below, shape depends on taskType
    maxTurns,   // default 3
    model       // default 'google/gemma-4-27b-it' via OpenRouter
  }) → Promise<AgentResult>

  // Result shapes per taskType:
  // create → { title: string, description: string, note?: string }
  // submit → { deliverableUrl: string, note: string }
  // review → { decision: 'approve'|'reject', score: 1|2|3|4|5, comment: string }

IMPLEMENTATION —

  - Loads persona SOUL.md from agents/awp-test-{N}/SOUL.md where N maps
    by a Map({Spark:1, Grind:2, Judge:3, Chaos:4, Scout:5, Flash:6, Bridge:7}).
  - Builds prompt per the PERSONA-PROMPTS.md templates.
  - Calls OpenRouter chat completions. Endpoint —
      POST https://openrouter.ai/api/v1/chat/completions
      Authorization: Bearer ${OPENROUTER_API_KEY}
      HTTP-Referer: https://swarm-testing-services.vercel.app
      X-Title: STS swarm agent runner
      Body: { model, messages: [...], max_tokens: 600, temperature: 0.7,
              response_format: { type: 'json_object' } }
  - If model returns malformed JSON, retry ONCE with a corrective turn
    ("Your previous reply was not valid JSON. Respond with only JSON.").
    On second failure, return a deterministic fallback (see per-taskType
    fallback in PERSONA-PROMPTS.md) and mark result.fell_back = true.
  - Instrument every call with a structured log line —
      [agent-runner] persona=X task=Y turns=N tokens=in/out ms=D outcome=ok|fallback
  - Reads OPENROUTER_API_KEY from process.env. Throws with a clear error
    if missing.

HARD RULES —
  - Never include scenario_key, config_key, CUTOVER_UTC, or any other
    internal identifier in the prompt. Never reference this file or
    the matrix. Never say "test" or "scenario".
  - Cap per-call output at 600 tokens. Cap cumulative turns at 3.
  - Do not write to intended-scenarios.json, do not read it.
  - Do not access Supabase, Alchemy, or any chain RPC.

────────────────────────────────────────────────────────────
DELIVERABLE 2 — scripts/swarm-drain.mjs patch
────────────────────────────────────────────────────────────

Keep ALL existing orchestration logic (scanning, role-eligibility,
scenario-aware progression via intended-scenarios.json). Swap ONLY the
text-producing steps to call swarm-agent-runner.

PATCHES —

  A. makeDeliverableUrl(jobId, agent) — replace with async call —
     const agentOut = await runAgent({
       persona: agent.name,
       taskType: 'submit',
       context: {
         job: { title, description, requirementsJson, rewardUSDC, posterShort }
       }
     });
     return { url: agentOut.deliverableUrl, note: agentOut.note };
     Use the url in submitWork. Drop the deterministic template builder.

  B. In the approve/reject branch — call runAgent({persona, taskType:
     'review', context:{job, submission}}) and use the returned
     decision/score/comment directly.

     PERSONA SELECTION RULES —
     Pick the persona whose key is actually eligible for this action:
       - approve/reject: the agent whose address equals activeValidator
       - submit: a worker-eligible agent (respecting approvedWorkers[])
     Do NOT bias persona selection by intended scenario. If Bridge is
     the active validator on a job whose annotation is s05-total-
     rejection, Bridge gets the prompt and decides in Bridge's voice.
     If Bridge approves, the row lands in s01-happy-path — that's a
     real coverage signal, not a steering failure. The matrix fills in
     from natural persona variation over hundreds of cycles.

     SCENARIO STEERING is limited to EVENT-ORDER scenarios — meaning
     scenarios that can only exist because the mechanical layer forced
     a specific action sequence or timing —
       - s02-validator-first: mechanical layer calls claim BEFORE
         dispatching any submit
       - s06-validator-waitlist: mechanical layer calls a second claim
         before the first validator approves
       - s08-worker-no-show: mechanical layer posts a timed job and
         deliberately doesn't dispatch a worker
       - s09-validator-no-show: mechanical layer dispatches a submitter
         but deliberately doesn't claim a validator
       - s10-reject-all-cancel: after all submissions rejected,
         mechanical layer calls cancelJob on behalf of the poster
     OUTCOME scenarios (s01, s03, s04, s05, s12, s16) are NEVER steered.
     The persona's natural review decision + the submission content
     determine the outcome. The scanner classifies whatever happens.
     intended-scenarios.json is READ ONLY for event-order scenarios;
     for outcome scenarios it is IGNORED.

  C. Every successful drain run, before process.exit, INSERT a heartbeat —
     POST https://ldxcenmhazelrnrlxuwq.supabase.co/rest/v1/system_heartbeats
     Authorization + apikey headers with STS_SUPABASE_KEY env var
     Body: {
       project_id: 'awp',
       component: 'swarm-drain',
       outcome: actionsTaken > 0 ? 'ok' : 'idle',
       actions_count: actionsTaken,
       note: `drained ${actionsTaken} jobs`,
       meta: { errors: errorCount, duration_ms: Date.now() - startedAt }
     }

  D. In the `steps` metadata emitted for each action (if the drain already
     writes a `steps` array anywhere — if not, we skip this sub-patch for
     now), stamp `details.driver = 'swarm-drain'` so the Operations tab
     can badge post-cutover actions correctly.

────────────────────────────────────────────────────────────
DELIVERABLE 3 — scripts/swarm-create.mjs patch
────────────────────────────────────────────────────────────

Replace JOB_TEMPLATES + cycle-count title/desc selection with an agent
call. The agent picks the topic from their own head based on persona.

PATCHES —

  A. Remove JOB_TEMPLATES constant.
  B. Before createJob, build a plain-English "job constraints" string
     (no system-ese, no enum values) and pass it to runAgent. Map each
     param to how a human AWP user would describe it —

       mode enum 0 (soft) → "Reviewer judges by hand"
       mode enum 1 (hard) → "Automated script checks the submission"
       mode enum 2 (hardsift) → "Automated check first, then human review"
       submissionMode 0 → "First valid submission wins the job"
       submissionMode 1 → "Multiple workers can submit; reviewer picks
         the best"
       deadline open → "No submission deadline"
       deadline timed → "2-hour submission window"
       workerAccess open → "Any worker can take this"
       workerAccess approved → "Only specific workers you trust can take
         this"
       workerAccess rating → "Workers need a reputation score of at
         least 4.0"
       validatorAccess open → "Any qualified reviewer can judge this"
       validatorAccess approved → "Only specific reviewers you trust"
       validatorAccess rating → "Reviewers need a reputation score of
         at least 4.0"

     Concatenate the applicable lines into a short bullet list. Then —

       const agentOut = await runAgent({
         persona: poster.name,
         taskType: 'create',
         context: {
           rewardUSDC: '5',
           constraints: [...bulletList]   // string[]
         }
       });

     Use agentOut.title and agentOut.description in the createJob args.
     Preserve all the existing param-building logic that maps config_key
     to the on-chain struct — only the title/description are swapped for
     agent output.
  C. Heartbeat emission same shape as drain —
     component: 'swarm-create', outcome: 'ok', actions_count: 1,
     note: `created job #${createdJobId}` ...
  D. Leave intended-scenarios.json annotation untouched. Still write it.

────────────────────────────────────────────────────────────
DELIVERABLE 4 — scripts/scanner-heartbeat-patch.md
────────────────────────────────────────────────────────────

A short markdown doc describing the one-line patch Cowork needs to apply
to /root/sts-scanner/sts-scanner.mjs on the VPS. DO NOT modify the
scanner file itself (we don't have it in this repo). Just document —

  After the scanner's main loop's final upsert each cycle, emit one
  heartbeat row —
    component: 'sts-scanner'
    actions_count: (rows touched this cycle)
    note: `upserted ${N} rows, skipped ${M}`

  Provide the exact fetch() snippet (matching drain/create shape) and
  where in the scanner source it should be inserted.

────────────────────────────────────────────────────────────
DELIVERABLE 5 — scripts/PERSONA-PROMPTS.md
────────────────────────────────────────────────────────────

Canonical prompt templates for each taskType. Structure —

  # Persona prompts

  ## Insider-info rules (applies to EVERY prompt)
  Do NOT include in ANY prompt passed to an LLM agent:
  - Scenario keys (s01, s02, …, s20) in any form
  - Config keys (hard-open-single-open-open, etc.) in any form
  - "Test", "scenario", "matrix", "lifecycle", "harness", "validation-mode"
    as enum values (HARD_ONLY / SOFT_ONLY / HARD_THEN_SOFT)
  - "Expected outcome", "should pass", "should fail"
  - Any mention of STS, the scanner, Supabase, or the coverage matrix
  - The CUTOVER_UTC constant or "mechanical" / "script-driven" framing

  What agents MAY see:
  - Their own SOUL (persona description)
  - The job's public-looking content (title, description, requirements
    as human-readable text)
  - The on-chain state visible to any AWP user (poster wallet, current
    validator, existing submissions)
  - A natural task prompt ("you want to post a job", "you're reviewing
    this", "you're considering whether to submit")

  ## TEMPLATES

  ### create
  System: [persona SOUL content]
  User: You want to post a new job on the AgentWork Protocol. Job
    constraints —
      - Reward: {rewardUSDC} USDC
      {render each constraints[] line as a bullet}
    Pick any topic that fits how you operate as an agent — something
    you'd genuinely want done by another agent. Write a concise title
    (under 80 chars) and a 2-3 sentence description that a worker could
    act on. Don't mention AWP internals, don't label the job as a
    "test", don't reference scenarios or any platform machinery.
    Return strictly JSON: {"title": "...", "description": "..."}

  ### submit
  System: [persona SOUL]
  User: A job is open on the AgentWork Protocol.
    Title: {title}
    Description: {description}
    Reward: {rewardUSDC} USDC
    Posted by: {posterShort}
    You've decided to submit work on this. Produce a plausible
    deliverable URL (must start with https://, length ≥ 50, and include
    a comma — the URL can be invented; think of it as where your work
    would live). Add a 1-2 sentence note about what you submitted. Stay
    in character.
    Return strictly JSON: {"deliverableUrl": "...", "note": "..."}

  ### review
  System: [persona SOUL]
  User: You're reviewing a submission on the AgentWork Protocol.
    Job —
      Title: {title}
      Description: {description}
    Submission by {workerShort} —
      Deliverable URL: {deliverableUrl}
      Note: "{submitterNote}"
    Decide whether to approve or reject, score 1-5, and write a 1-3
    sentence review comment. Be consistent with your character — if
    your persona is blunt, write bluntly. If you're generous, be
    generous.
    Return strictly JSON:
      {"decision":"approve"|"reject","score":1|2|3|4|5,"comment":"..."}

  ## DETERMINISTIC FALLBACKS (only on double parse failure)
  - create:  { title: "New task — consolidated",
               description: "A job for an autonomous agent on AWP." }
  - submit:  { deliverableUrl: `https://awp-submissions.example.com/job${jobId},${personaLower}-delivery-auto-fallback`,
               note: "Submitted." }
  - review:  { decision: "approve", score: 4, comment: "Meets the requirement." }
  These are boring on purpose — fallback = audit-trail alarm, not the
  norm.

────────────────────────────────────────────────────────────
DEPLOY
────────────────────────────────────────────────────────────

Commit message — feat Phase 5 — re-agent swarm via OpenRouter Gemma-4
with insider-info-clean persona prompts plus heartbeat emission

Push via central PAT (same flow as prior phases).

After deploy, Cowork will —
  1. Apply migration 0003_system_heartbeats.sql to STS Supabase (manual,
     already queued)
  2. scp the 3 new/patched script files to /root/test-swarm/ on VPS
  3. Set OPENROUTER_API_KEY env var (already in /root/.awp-env)
  4. Wait two cron cycles and verify —
       - /var/log/awp-drain.log shows [agent-runner] lines
       - Operations tab heartbeat cards turn GREEN
       - Transactions drawer shows varied deliverable URLs and review
         comments in persona voices

DO NOT —
  - Modify scanner/sts-scanner.mjs (that's a separate Cowork task via
    scripts/scanner-heartbeat-patch.md)
  - Modify the AWP app or any non-STS repo
  - Break the mechanical orchestration — only text generation swaps
  - Add any LLM call to actions that don't produce content (claim,
    finalize, rejectAll, cancelJob stay pure JS)
  - Leak insider info in prompts — run the 8-pattern insider-info regex
    (already in lib/insider-audit.ts) against every prompt string before
    shipping
```
