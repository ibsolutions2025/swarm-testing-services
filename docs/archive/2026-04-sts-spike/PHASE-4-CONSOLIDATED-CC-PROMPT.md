# Claude Code — Phase 4 Consolidated (Operations + Scanner audits + Drawer roles)

Three tracks in one PR to save round-trips. All are additive, no breaking changes.

Paste the fenced block into Claude Code at the repo root.

---

```
Phase 4 — three UI/backend enhancements in one shippable PR.

CONTEXT. The AWP swarm on the VPS now runs via two mechanical scripts —
swarm-drain.mjs (every 5 min, progresses on-chain jobs, ~25 writes/run)
and swarm-create.mjs (every 15 min, posts one scenario-targeted job).
The scanner sts-scanner.mjs populates lifecycle_results every 15 min.
Until 2026-04-23 19:40 UTC the swarm was LLM-based (auto-cycle.mjs,
Chutes Kimi K2.6-TEE). Rows created BEFORE that cutover were agent-driven;
rows AFTER are script-driven. We want to expose that distinction in the UI.

We also want to finish two remaining tabs — the Transactions drawer
currently has empty "cell_audit" and "step_audits" sections because the
scanner doesn't populate them yet, and the drawer flattens the `wallets`
JSONB into a single list instead of showing role labels.

THREE TRACKS.

────────────────────────────────────────────────────────────
TRACK 1 — Operations Tab (biggest track)
────────────────────────────────────────────────────────────

Add a fourth tab "Operations" for AWP project. Three stacked panels.

PANEL A — System Heartbeats

Three cards, one per running VPS component —

  [ swarm-drain ]     [ swarm-create ]     [ sts-scanner ]

  2m ago              4m ago               12m ago
  ✓ 18 actions        ✓ created #670       ✓ +2 rows
  every 5 min         every 15 min         every 15 min

Each card pulls from a NEW `system_heartbeats` Supabase table (schema
below). Card color —
  green  if last_ran_at within 2× expected cadence
  amber  if within 4×
  red    if beyond 4× OR no heartbeat in last 30 min
Show fallback state "No heartbeat yet — waiting for first run" if null.

PANEL B — Live Lifecycle Timeline

Vertical timeline of the last 30 lifecycle events across all recent
jobs, polled every 15 s from /api/test-results/lifecycle?since=<ISO>.
Each event renders a row —

  [icon]  #<jobId>  <step.name>  <agent_wallet short>
          [SCRIPT|AGENT badge]   <relative time>   <tx BaseScan link>

Newest at top. Auto-scrolls to top on new events. Clicking an event
expands inline to show step.details JSON.

Driver attribution rules —
  const CUTOVER_UTC = '2026-04-23T19:40:00Z'
  if step.details?.driver === 'swarm-drain' or 'swarm-create' → SCRIPT
  else if row.created_at >= CUTOVER_UTC → SCRIPT  (grandfather)
  else → AGENT

Badge styles —
  SCRIPT — bg-blue-500/20 border-blue-400/30 text-blue-300
  AGENT  — bg-emerald-500/20 border-emerald-400/30 text-emerald-300

PANEL C — Pipeline Breakdown

Two stacked horizontal bars —

  By driver —
  [████████████ AGENT 540 (86%)]  [█ SCRIPT 87 (14%)]

  By status —
  [passed 92] [running 576] [other breakdown...]

Each segment has a hover tooltip with the exact count + percent.

────────────────────────────────────────────────────────────
TRACK 2 — Scanner audit fields surfacing (drawer enrichment)
────────────────────────────────────────────────────────────

Scanner doesn't populate `step_audits` / `cell_audit` yet, but the
Transactions drawer already has collapsible sections for them. Track 2
is mostly a TYPES + DRAWER pass so when the scanner enrichment ships
(separate VPS patch), the UI renders immediately.

Add to components/transactions/TransactionsTab.tsx —

1. Show a new "Audit status" row in the drawer header that says
     - "Audited ✓" (green pill) if result.cell_audit is non-null
     - "Audit pending" (muted pill) otherwise
2. For Cell audit section — if cell_audit.terminal_status exists,
   promote it into a top-line display like —
     "Terminal: passed (5/5 steps confirmed on-chain)"
   Above the raw JSON.
3. For Step audits — if step_audits is an array parallel to steps[],
   render each step's audit as an inline chip inside the step row
   (next to the existing status pill) —
     "⛓ confirmed" (green) if step_audits[i]?.onchain_confirmed
     "⚠ not confirmed" (red) if step_audits[i]?.onchain_confirmed === false
     Hidden entirely if step_audits[i] is undefined.

These are all ADDITIVE — when cell_audit / step_audits are null (current
state), the UI degrades to what it does today.

────────────────────────────────────────────────────────────
TRACK 3 — Role-labeled wallets in drawer
────────────────────────────────────────────────────────────

Currently extractAgentWallets() flattens both the `wallets` JSONB
(role-keyed: {poster, worker, validator, ...}) and `agent_wallets`
(flat array) into one list. We want role labels.

Add a new drawer section ABOVE "Agent Wallets" —

  <section>
    <h4 className="text-xs uppercase tracking-widest text-[var(--muted)]">
      Roles
    </h4>
    {result.wallets?.poster    && <RoleRow label="Poster"    addr={result.wallets.poster} />}
    {result.wallets?.worker    && <RoleRow label="Worker"    addr={result.wallets.worker} />}
    {result.wallets?.validator && <RoleRow label="Validator" addr={result.wallets.validator} />}
    {/* any other string-valued keys on wallets — capitalize and render */}
  </section>

RoleRow renders as — "<Label>: <short-address link to BaseScan>".

Keep the existing "Agent Wallets" section below but rename header to
"All Wallets Touched" — it now serves as a catch-all for
agent_wallets[] entries not already labeled above.

────────────────────────────────────────────────────────────
IMPLEMENTATION DETAILS
────────────────────────────────────────────────────────────

1. Supabase migration — supabase/migrations/0003_system_heartbeats.sql

  CREATE TABLE IF NOT EXISTS system_heartbeats (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    project_id text NOT NULL DEFAULT 'awp',
    component text NOT NULL,
    ran_at timestamptz NOT NULL DEFAULT now(),
    outcome text,
    actions_count int,
    note text,
    meta jsonb
  );
  CREATE INDEX ON system_heartbeats (project_id, component, ran_at DESC);
  ALTER TABLE system_heartbeats ENABLE ROW LEVEL SECURITY;
  CREATE POLICY service_role_all ON system_heartbeats FOR ALL TO service_role USING (true);
  CREATE POLICY auth_read ON system_heartbeats FOR SELECT TO authenticated
    USING (project_id = 'awp');

2. API route — app/api/test-results/heartbeats/route.ts

  GET /api/test-results/heartbeats?project=awp returns —
    {
      components: {
        'swarm-drain':  { last: Heartbeat | null, count24h: number },
        'swarm-create': { last: Heartbeat | null, count24h: number },
        'sts-scanner':  { last: Heartbeat | null, count24h: number }
      }
    }
  Graceful degrade on missing table with `table_missing: true`.
  Uses createAdminClient and force-dynamic like the lifecycle route.

3. Extend app/api/test-results/lifecycle/route.ts —
  - Accept a `?since=<ISO>` query param; when present, filter
    `.gte('updated_at', since)` so the Operations timeline only pulls
    recently-changed rows.
  - Everything else unchanged.

4. Client components (new) —
  - components/operations/OperationsTab.tsx — main tab, composes the
    three panels. Props { projectKey: 'awp' }. Polls both endpoints
    every 15 s. Uses React state for timeline events, deduping by
    row.id + step index.
  - components/operations/HeartbeatCard.tsx — single card.
  - components/operations/LifelineEvent.tsx — single row in timeline.
  - components/operations/PipelineBreakdown.tsx — two stacked bars.

5. lib/heartbeat-types.ts — Heartbeat type + response shapes.

6. lib/operations.ts — helper `driverForStep(step, createdAt): 'SCRIPT'|'AGENT'`
   centralizes the cutover-date + step.details.driver logic.

7. components/ProjectTabs.tsx —
  - Extend TabKey union to include "operations"
  - Add tab button after Transactions (so order is Matrix | Personas | Transactions | Operations)
  - Show Operations tab only when isAwp (for non-AWP projects, hide it)

8. Transactions drawer edits — components/transactions/TransactionsTab.tsx
  - Add "Audit status" pill in drawer header
  - Replace `wallets` flat rendering with new Roles section above Agent Wallets
  - Inline step-audit chips in steps list where step_audits[i] exists

DEPLOY.

  Commit message — feat Phase 4 — Operations tab plus drawer role labels
  plus scanner audit surfacing

  Push via central PAT —
    Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object {
      if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
    }
    "protocol=https`nhost=github.com`n`n" | git credential reject 2>$null
    git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main

VERIFY after deploy —
  - /dashboard/campaigns/<awp-id> renders 4 tabs (Matrix, Personas, Transactions, Operations)
  - Operations tab loads without errors. Cards show "No heartbeat yet" state.
  - Timeline populates from lifecycle_results (visible as soon as any row has steps). Badges show AGENT (green) for older rows, SCRIPT (blue) for rows after 2026-04-23T19:40Z.
  - Transactions drawer now has "Roles" section above "All Wallets Touched" with Poster/Worker/Validator labels where present.
  - Drawer shows "Audit pending" muted pill (since scanner hasn't populated audits yet).

SECOND-ROUND VPS DEPENDENCY (DOCUMENT, DO NOT IMPLEMENT).

  In OperationsTab.tsx JSDoc, document that VPS scripts must write
  heartbeat rows to `system_heartbeats` for the cards to light up. Shape —

    INSERT INTO system_heartbeats (project_id, component, outcome, actions_count, note, meta)
    VALUES ('awp', 'swarm-drain', 'ok', 18, 'drained 18 jobs', '{"errors":0,"duration_ms":45123}');

  The VPS patch is a separate Cowork task; DO NOT write any .mjs or
  shell code in THIS PR.

DO NOT —
  - Change swarm-drain.mjs, swarm-create.mjs, sts-scanner.mjs, or any VPS code
  - Change the existing Matrix tab or Personas tab (Tracks 2 and 3 only touch the Transactions drawer)
  - Break the Transactions tab's filter/search/polling — add to it, don't refactor
  - Re-add the top-of-page SummaryCards for AWP (intentionally hidden)
```
