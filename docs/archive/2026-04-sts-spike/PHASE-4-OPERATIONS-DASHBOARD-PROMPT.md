# Claude Code Prompt — Phase 4: Operations Dashboard Panel

Add a live operations view to the STS dashboard that shows what's actually running right now — which scripts fired when, which lifecycle steps were driven by agents (LLM) vs mechanical scripts, and where each of the past N jobs is in its lifecycle. This is what turns the dashboard from "matrix of results" into "live flywheel you can watch."

Paste the fenced block into Claude Code at the repo root.

---

```
Phase 4 — Operations Dashboard.

Context. The AWP swarm on the VPS now runs entirely via two mechanical
scripts — swarm-drain.mjs (every 5 min) and swarm-create.mjs (every 15 min).
The scanner sts-scanner.mjs runs every 15 min to populate lifecycle_results.
Until 2026-04-23 19:40 UTC the swarm was LLM-based (auto-cycle.mjs calling
Chutes Kimi K2.6-TEE) — that's now retired but historical rows were created
by LLM agents. We want the dashboard to distinguish agent-driven lifecycles
from script-driven lifecycles, and to show real-time activity of the three
running components.

GOAL — Add a fourth tab "Operations" to ProjectTabs.tsx for AWP projects
that shows three panels.

PANEL 1 — System Heartbeats (top)

Three live cards, one per running component —

  [ swarm-drain ]  [ swarm-create ]  [ sts-scanner ]

  Last run         Last run          Last run
  2m ago           4m ago            12m ago
  ✓ 18 actions    ✓ created #670   ✓ +2 rows

  Every 5 min     Every 15 min      Every 15 min

Each card pulls from a new `system_heartbeats` Supabase table that the
three scripts write to on every run. Card color — green if last run
within 2× cadence, amber if within 4×, red beyond.

PANEL 2 — Live Lifecycle Timeline (middle)

Horizontal timeline of the last 20 on-chain events across all jobs —
polled every 15 seconds from lifecycle_results (newest steps at top or
right). Each event shows —

  [icon]  #<jobId>  <step name>  <agent wallet short>
          <relative timestamp>    <tx BaseScan link>

Events come from walking the `steps[]` JSONB of each recent row. A
"driver" badge on each step — blue "SCRIPT" badge if step was driven
by swarm-drain.mjs or swarm-create.mjs (based on a new `driver` field
the scripts write to step.details), green "AGENT" badge for legacy rows
(inferred — steps without driver field are agent-driven auto-cycle.mjs).
Rows created from 2026-04-23 19:40 UTC onwards are SCRIPT-driven, older
are AGENT-driven.

PANEL 3 — Pipeline Status Breakdown (bottom)

Two side-by-side horizontal bars stacked by status —

  By driver:
  [████████████ AGENT (540 rows, 86%)] [█ SCRIPT (87 rows, 14%)]

  By status:
  [████ passed 92 (14%)] [████████████████████ running 576 (86%)]

Second bar has a tooltip per segment showing % + count.

IMPLEMENTATION.

1. Supabase migration — supabase/migrations/0003_system_heartbeats.sql

   CREATE TABLE IF NOT EXISTS system_heartbeats (
     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
     project_id text NOT NULL DEFAULT 'awp',
     component text NOT NULL,   -- 'swarm-drain' | 'swarm-create' | 'sts-scanner'
     ran_at timestamptz NOT NULL DEFAULT now(),
     outcome text,              -- 'ok' | 'error' | 'partial'
     actions_count int,         -- # writes or rows touched
     note text,                 -- freeform summary
     meta jsonb                 -- optional details
   );
   CREATE INDEX ON system_heartbeats (project_id, component, ran_at DESC);
   ALTER TABLE system_heartbeats ENABLE ROW LEVEL SECURITY;
   CREATE POLICY service_role_all ON system_heartbeats FOR ALL TO service_role USING (true);
   CREATE POLICY auth_read ON system_heartbeats FOR SELECT TO authenticated
     USING (project_id = 'awp');

2. API route — app/api/test-results/heartbeats/route.ts

   GET /api/test-results/heartbeats?project=awp&limit=50
   Returns the last N heartbeats per component, grouped.
   Response shape —
     {
       components: {
         'swarm-drain':  { last: Heartbeat | null, count24h: number },
         'swarm-create': { last: Heartbeat | null, count24h: number },
         'sts-scanner':  { last: Heartbeat | null, count24h: number }
       }
     }
   Graceful degrade with `table_missing: true` on missing table.

3. API route — extend existing /api/test-results/lifecycle to accept
   ?since=<ISO> param that returns only rows updated after that timestamp.
   Also include each row's step_audits and ensure steps[] is included
   in the default select (already is per current code).

4. Client component — components/operations/OperationsTab.tsx

   Polls both endpoints every 15s. Three subpanels described above.

   Derive driver per step —
     - if step.details.driver === 'swarm-drain' OR step.details.driver === 'swarm-create' → SCRIPT
     - else if row.created_at >= '2026-04-23T19:40:00Z' → SCRIPT (grandfathered for old scripts that don't stamp)
     - else → AGENT
   Store as const CUTOVER_UTC = '2026-04-23T19:40:00Z'.

5. Wire into components/ProjectTabs.tsx — add 'operations' to TabKey union
   and render <OperationsTab /> when active and isAwp. Put it third in the
   tab order so matrix/personas/transactions/operations reads left-to-right.

6. Optional — add a small badge on the project header showing "LIVE • drain X ago"
   at the top of the detail page if most recent heartbeat < 10 min old.

DATA SOURCE NOTES.

- The scripts on VPS need to write heartbeat rows. Provide a minimal
  VPS patch note at the bottom of OperationsTab.tsx's JSDoc that says —
    "VPS scripts must call Supabase insert into system_heartbeats on each
     run. Implementation left to VPS-side swarm-drain.mjs and
     swarm-create.mjs — extend their final console.log block with a fetch
     to the STS Supabase service role key. sts-scanner.mjs already has
     Supabase access via STS_SUPABASE_KEY env."
  Do NOT write VPS code in this PR — just document the dependency.

- For now if system_heartbeats is empty, render component cards as
  "No heartbeat yet — waiting for first run" and fall back to showing
  "count of rows created since CUTOVER_UTC" as a proxy for
  swarm-create activity.

STYLING.

- Use existing RUN_OUTCOME_COLORS for status pills
- Cards share the same rounded-md border-[var(--border)] p-4 style
- Driver badges — `bg-blue-500/20 border-blue-400/30` for SCRIPT,
  `bg-emerald-500/20 border-emerald-400/30` for AGENT
- Keep polling discrete — useEffect with 15000ms interval, cancel on unmount

DEPLOY.

  Commit message — feat Phase 4 — live Operations tab with heartbeats and
  driver attribution
  Push via central PAT from secrets/github.env per prior commits.

VERIFY (after VPS scripts start writing heartbeats).

  /dashboard/campaigns/<awp-id> → Operations tab → 3 cards green,
  timeline populates with recent events, driver badges render correctly
  (older rows AGENT, newer rows SCRIPT), pipeline bar reflects real ratio.

DO NOT.

  Write any VPS-side code. Touch auto-cycle.mjs, swarm-drain.mjs,
  swarm-create.mjs on VPS, or any shell scripts. Just the Next.js /
  Supabase / UI layer. The VPS heartbeat emission will be a separate
  Cowork task.
```
