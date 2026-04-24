# Claude Code — Phase 6: Full Orchestration Stream in Operations Tab

The Operations tab today shows on-chain events (agent actions) but hides the script's reasoning + dispatches. Buyers need to see the whole operating brain — script scans state, decides who does what, tells an agent to act, agent acts, tx lands on-chain — all linked in one timeline. This adds the missing half.

Paste the fenced block into Claude Code at the repo root.

---

```
Phase 6 — Orchestration stream. Render the FULL operating brain of the
swarm in the Operations tab. Today we see on-chain outcomes (agent
actions). We want to ALSO see the script's scans, decisions, and
dispatches — linked in time and linked to the resulting on-chain tx.

CONTEXT.
  - Scripts (swarm-drain, swarm-create, sts-scanner) on the VPS do the
    orchestration: they read on-chain state, read the matrix, pick which
    persona to dispatch for which action on which job, and send the
    directive.
  - Agents (7 personas, private keys on VPS) execute the directive in
    persona voice and sign the tx.
  - Currently the UI only shows the agents' on-chain outcomes. The
    script's reasoning and dispatch is invisible.
  - We need a unified merged timeline: orchestration events (from
    scripts) + lifecycle events (from on-chain scanner) in one feed,
    linked by job_id / tx_hash / agent.

THREE DELIVERABLES.

1. Supabase migration 0004 — orchestration_events table.
2. API route — /api/test-results/orchestration?since=<ISO>
3. UI — new "Orchestration" panel in Operations tab (replaces current
   Live Lifecycle Timeline) showing a merged, typed, richly-labeled feed.

────────────────────────────────────────────────────────────
DELIVERABLE 1 — supabase/migrations/0004_orchestration_events.sql
────────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS orchestration_events (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     text        NOT NULL DEFAULT 'awp',
    ran_at         timestamptz NOT NULL DEFAULT now(),
    cycle_id       text        NOT NULL,   -- groups events within one cron run
    source         text        NOT NULL,   -- 'swarm-drain' | 'swarm-create' | 'sts-scanner'
    event_type     text        NOT NULL,   -- 'scan' | 'decision' | 'dispatch' | 'skip' | 'error'
    persona        text,                    -- dispatched agent name (Spark, Judge, etc.) when applicable
    job_id         int,                     -- on-chain JobNFT token id when applicable
    directive      text,                    -- the plain-English instruction given to the agent (only on dispatch)
    reasoning      text,                    -- one-line rationale the script logs ("eligible + matrix gap + round-robin")
    tx_hash        text,                    -- the on-chain tx that resulted, when known
    meta           jsonb
  );

  CREATE INDEX IF NOT EXISTS orchestration_events_project_ran_idx
    ON orchestration_events (project_id, ran_at DESC);
  CREATE INDEX IF NOT EXISTS orchestration_events_cycle_idx
    ON orchestration_events (project_id, cycle_id);
  CREATE INDEX IF NOT EXISTS orchestration_events_job_idx
    ON orchestration_events (project_id, job_id);

  ALTER TABLE orchestration_events ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS service_role_all ON orchestration_events;
  CREATE POLICY service_role_all ON orchestration_events
    FOR ALL TO service_role USING (true);

  DROP POLICY IF EXISTS auth_read ON orchestration_events;
  CREATE POLICY auth_read ON orchestration_events
    FOR SELECT TO authenticated
    USING (project_id = 'awp');

────────────────────────────────────────────────────────────
DELIVERABLE 2 — app/api/test-results/orchestration/route.ts
────────────────────────────────────────────────────────────

  GET /api/test-results/orchestration?project=awp&since=<ISO>&limit=<N>

  Response —
    {
      events: OrchestrationEvent[],   // newest first, capped by limit (default 100)
      table_missing: false            // or true with empty events[] if migration not run
    }

  Force-dynamic, service-role client, CORS same as existing routes.
  Graceful degrade on missing table.

  Extend lib/ with `lib/orchestration-types.ts` exporting OrchestrationEvent.

────────────────────────────────────────────────────────────
DELIVERABLE 3 — Operations tab orchestration panel
────────────────────────────────────────────────────────────

REPLACE the existing "Live Lifecycle Timeline" (Panel B) with a new
"Orchestration Stream" panel that shows a MERGED feed of BOTH —
  - orchestration_events rows (script thinking + dispatches)
  - lifecycle_results steps (agent on-chain actions)

RENDER EACH EVENT AS A ROW —

  [icon]  [actor pill]  [time]       [summary]   [link if applicable]
                                                  └→ expandable JSON

  - actor pill  — "Script · swarm-drain" (blue) or "Agent · Judge" (green)
                  or "Chain" (slate) for raw on-chain confirmations
  - icon        — per event_type —
                    scan      🔍
                    decision  🧠
                    dispatch  ➜
                    skip      ⏭
                    act       ⛓
                    error     ⚠
  - summary     — typed formatting —
                    scan:      "Scanned 80 jobs — 12 actionable"
                    decision:  "Chose Judge for validation on #675 (eligible + round-robin)"
                    dispatch:  "Judge · validate #675 · \"review this submission honestly\""
                    skip:      "Skipped #680 · all personas already touched"
                    act:       "Judge rejected sub #0 on #675 · \"deliverable doesn't match the spec\""
                    error:     "OpenRouter 429 · retry in 30s"
  - link        — BaseScan tx/address when tx_hash or persona wallet present
  - expand      — click any row to see full meta JSON

MERGE STRATEGY —
  - Pull orchestration_events since T (polled every 10s)
  - Pull lifecycle_results steps since T (polled every 10s, reuse the
    Phase-4 /api/test-results/lifecycle?since endpoint)
  - Sort by timestamp desc (newest at top)
  - Dedupe: a lifecycle step with a tx_hash that already appears in an
    orchestration_events row's tx_hash is collapsed into a single row
    showing BOTH the dispatch directive AND the on-chain outcome
  - Cap displayed rows at 100; auto-scroll to top on new rows

CYCLE GROUPING (nice-to-have, include if trivial) —
  - Events within the same cycle_id are visually grouped with a left
    border in the source's color (blue for drain, purple for create,
    gray for scanner).
  - At the top of a cycle group, render a header: "swarm-drain · 2:14 PM
    · 18 events · 3 dispatches · 5 on-chain acts"

FILTERS —
  - Actor: All | Scripts | Agents
  - Event type: All | Decisions | Dispatches | Acts | Errors
  - Persona: All | Spark | Grind | Judge | Chaos | Scout | Flash | Bridge
  - Free-text search over summary + reasoning + directive

PANEL C (Pipeline Breakdown) stays unchanged.
PANEL A (Heartbeats) stays unchanged.

Drop the old Panel B (Live Lifecycle Timeline) — it's now subsumed by
the Orchestration Stream. Salvage any shared helpers (formatRel, driver
attribution) into lib/operations.ts.

────────────────────────────────────────────────────────────
IMPLEMENTATION DETAIL
────────────────────────────────────────────────────────────

- components/operations/OrchestrationStream.tsx (new, main panel)
- components/operations/OrchestrationRow.tsx (new, single event row)
- lib/orchestration-types.ts (new, types)
- lib/orchestration-merge.ts (new, dedup + merge logic)
- components/operations/OperationsTab.tsx — replace Panel B import +
  render with <OrchestrationStream projectKey="awp" />

VPS-SIDE DEPENDENCY (DO NOT WRITE VPS CODE, JUST DOCUMENT) —

The VPS scripts must start emitting orchestration_events. Document in
OrchestrationStream.tsx JSDoc —

  Scripts emit events via POST to system_heartbeats's neighbor table —
    POST /rest/v1/orchestration_events
    Body: {
      project_id:  'awp',
      cycle_id:    <uuid or timestamp-based group id>,
      source:      'swarm-drain' | 'swarm-create',
      event_type:  'scan' | 'decision' | 'dispatch' | 'skip' | 'error',
      persona:     'Judge' | ...,  // for dispatch/decision rows
      job_id:      <number>,       // when action targets a specific job
      directive:   "review this submission honestly",  // dispatch only
      reasoning:   "eligible validator + round-robin turn",
      tx_hash:     "0x...",        // if the resulting tx is known at emission time
      meta:        { ... }
    }

  Typical emission pattern per drain cycle —
    1 × scan        (at start of run: "scanned jobs X-Y")
    N × decision    (one per job considered)
    M × dispatch    (one per agent called — this is what shows the DIRECTIVE)
    M × (eventually) act via lifecycle_results step upsert with tx_hash
         (no separate orchestration row — merged by tx_hash)
    1 × error       (on any failure)
    End: the heartbeat row (already wired in Phase 5)

DEPLOY —
  Commit: "feat Phase 6 — orchestration stream (script thinking +
  dispatch + on-chain outcome in one timeline)"
  Push via central PAT (same flow as prior phases).

VERIFY after deploy (cold state) —
  - /api/test-results/orchestration returns { events: [], table_missing:
    true } until migration 0004 is applied
  - After migration applied and VPS patch shipped (separate Cowork task):
    Operations tab Panel B shows live stream, dispatches labeled with
    persona directives, on-chain acts linked to their preceding dispatch
    by tx_hash

DO NOT —
  - Modify VPS scripts (that's the next Cowork task)
  - Touch Phase 4's heartbeats / pipeline panels
  - Touch Matrix, Personas, or Transactions tabs
  - Break the existing driver-attribution helper in lib/operations.ts —
    new code uses it for the actor pill color
```
