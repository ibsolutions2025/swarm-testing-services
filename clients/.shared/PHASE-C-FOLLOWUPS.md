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
