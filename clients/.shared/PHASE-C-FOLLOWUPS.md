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
