# Phase C — Post-ship followups

Captured during Phase C build but explicitly out-of-scope for v1.
Addressing these is post-Phase-C work; do NOT block C.5/C.6/C.7 on them.

---

## 1. Step 05 crawl-docs returned 0 pages (was 16 in iter3)

**Where:** `framework/onboarding/steps/05-crawl-docs.mjs`
**When seen:** Phase C Checkpoint 2 live e2e (`cp2-moj7cdnw`, 2026-04-28)
**Symptom:** `summary: "0 pages crawled"` on the step event row, vs iter3's 16.
**Cost impact:** ~$0.06 of LLM spend on a no-op step (same as iter3).
**Suspected cause:** likely a regression in the crawler's URL discovery or
robots.txt handling. Page count went from 16 → 0 with no other doc-side
changes between iter3 and Phase C.

**Acceptance for fix:** crawl-docs emits a non-zero pageCount on AWP URL,
and the audit doc's "1.2 Website + docs" section is populated again.

## 2. SSR cache for /hire/runs/[runId] doesn't invalidate on row flip

**Where:** `app/hire/runs/[runId]/page.tsx`, `app/api/onboarding/route.ts`
**Symptom:** When a run flips queued→running→complete, Vercel's edge cache
may serve a stale page on hard reload until the `force-dynamic` directive
forces re-fetch. The OnboardingStepper's 3s polling masks this for the
client-rendered stepper, but the surrounding shell (header, status pill if
ever moved server-side, etc.) can render stale.

**Fix sketch:** add `revalidatePath('/hire/runs/' + runId)` from the API
route on each onboarding_runs UPDATE (status flip). Currently only the
client polling sees fresh state.

**Acceptance for fix:** hard-reload a /hire/runs page mid-run shows current
status pill + cost without manual cache-bust.

---

**Out-of-scope (do not work on in Phase C):**
- v2 wallet provisioning UX
- HLO auto-cutover on greenlight
- Concurrent customer swarm support
- Engine prompt iteration based on customer feedback

---

## Phase E candidates (surfaced during Phase D validation)

These were caught by `validate-engine-lib.mjs` (D.1) and `shadow-hlo.mjs` (D.2)
on the engine output for `c-23becc-20260429-001556`, then patched via HITL
edits. Logging the root causes so they can be addressed at the engine /
editor level, not just at the per-customer HITL layer.

### E.1 derive-matrix.md — declare matrix-controlled scalars vs dispatch-time arrays

**Bug seen:** engine emitted placeholder strings in `maps_to`:
```js
"approved-list": { "approvedWorkers_": "non-empty",  "minWorkerRating_": 0 }
"rating-gate":   { "approvedWorkers_": [],            "minWorkerRating_": ">0" }
```
`"non-empty"` and `">0"` are LLM stand-ins describing CONSTRAINTS, not the
concrete values V15.createJob requires. 48/100 engine configs failed shadow
ABI validation.

**Root fix:** the `derive-matrix` prompt should distinguish:
- *matrix-controlled scalar params* (validationMode_, submissionMode_,
  submissionWindow_, minWorkerRating_, etc.) — engine emits the exact
  numeric/boolean value
- *dispatch-time array params* (approvedWorkers_, approvedValidators) —
  engine emits a placeholder slot the HLO populates from agent-fleet
  data at dispatch
For #2, the prompt should require either an empty `[]` or a documented
placeholder format (e.g. `["__SPARK__"]`) the cutover layer recognizes
and substitutes.

### E.2 Matrix editor UI — require maps_to per value when adding axis

**Bug seen:** my Phase C HITL `add_axis` patch had no `maps_to`. The axis
appeared correct in the editor (name, values, source_param) but at
shadow-HLO time every config-key with the new axis was byte-identical to
its sibling because no on-chain state changed across the axis values.

**Root fix:** `MatrixEditor.tsx` should treat `maps_to` as a required
field per axis value, with a per-row form (one row per value) requiring
at least one source_param → concrete-value mapping. The current MatrixEditor
allows axis creation with just name + values, leaving maps_to undefined.

### E.3 derive-matrix.md — fold sub-mode + deadline when both touch one ABI param

**Bug seen:** engine emitted `sub-mode` (FCFS|TIMED) AND a separate
HITL-added `deadline` axis, both controlling submissionMode_ +
submissionWindow_. The cleaner design (path-ii) drops one and lets the
other carry both responsibilities. Discovered when D.2 surfaced 50 twin
groups along the deadline dimension.

**Root fix:** the derive-matrix prompt should detect when two candidate
axes both touch the same source_param and fold them into one axis with
the union of values. The `flag-test` rule from the iter3 prompts catches
the boolean-flag-not-axis case, but doesn't catch this collapse case.

---

**Disposition:** These are Phase E backlog items. Not blocking D.3
(the per-customer HITL fix is sufficient to validate the cutover-driven
swarm). Address when the engine prompt iteration lands as its own phase.

### E.4 Engine output must include runtime helpers — BLOCKS D.3

**Bug seen:** Phase D.3 pre-flight check found that the existing
`framework/hlo-daemon.mjs` imports 7 names from `lib/awp/index.js`:

  CONTRACT_ADDRESSES, ALL_CONFIGS, CLASSIFIABLE_SCENARIO_IDS,
  parseConfigKey, configToParams, isCellApplicable, checkAgentEligibility

The first 3 are DATA — engine output has them. The last 4 are RUNTIME
HELPERS the fixture provides as hand-written TS functions:

- `parseConfigKey(key)` — string → typed params (split + axis-typed)
- `configToParams(key)` — string → full V15.createJob params struct
- `isCellApplicable(scenarioId, configParams)` — applicability filter
- `checkAgentEligibility(agent, jobState, action)` — V15 rules pre-check

Engine emits the input data (AXES.maps_to, ALL_SCENARIOS.applicability,
RULES) but NOT the functions that walk them. Trying to swap
`lib/awp/` → `lib/agentwork-protocol-23becc/` in the HLO daemon
import would fail at module load with "import not found".

**Three resolution paths:**

A. **Engine emits the helpers.** Steps 09 (matrix), 10 (scenarios),
   and 07 (rules) prompts each grow a "render the runtime helper
   functions consumers need" instruction. Helpers become part of the
   engine's templated output — same lines every time, parameterized
   on the lib's specific axes/scenarios/rules. Real engine prompt
   iteration. Highest fidelity to the "drop-in lib" promise.

B. **Cutover renderer injects a shim.** During C.7, the cutover layer
   appends a known-good helper module (or appends to index.js) that
   wraps the engine's data with the 4 helpers. Helper code is in the
   STS repo, not the engine output, but the cutover stitches them
   into every greenlit lib. Lower engineering cost, but the seam means
   "engine output" alone isn't drop-in dispatchable — needs cutover
   to assemble the final shape.

C. **Refactor HLO daemon to use only data.** Drop the 4 helper
   imports; HLO synthesizes the same logic inline from AXES.maps_to
   etc. Smallest code surface, but every consumer of the lib (HLO,
   scanner, auditor) eventually rewrites the helpers, defeating the
   shared-knowledge-tree principle.

**Recommendation:** A is the "real" fix, B is the unblock-D.3 hack.
Path B can ship in a few hours of shim work; Path A is multi-day
prompt iteration. Either could land in Phase E.

**Why this didn't surface in D.1 or D.2:**
- D.1 imports `lib/<slug>/index.js` and inspects exports —
  succeeded because the imports it needs (AXES, ALL_SCENARIOS,
  PREDICATES, RULES, EVENT_SIGS) are all DATA, present in engine
  output.
- D.2 reimplements the helpers inline in `shadow-hlo.mjs` (it was
  a self-contained simulation). It never tried to import them from
  the lib.
- D.3 is the first step that would touch the daemon's actual import
  surface, so this is where the gap lights up.

**Disposition:** D.3 swap is blocked until A or B lands. Phase D
results stand: engine output is *structurally sound* (D.1) and
*dispatchable as data* (D.2). The swap-vs-fixture experiment needs
a small bridging step before it can run.
