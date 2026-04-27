# Phase C — Hire-the-Swarm UI

**Owner:** STS CC session, cwd `C:\Users\isaia\.openclaw\swarm-testing-services`
**Master design:** `clients/awp/SWARM-V2-DESIGN.md` sections 5 + 6 (Phase C)
**Predecessors:** Phase A (lib/awp + 4 runtime layers), Phase B (engine validated, iter3 final)
**Estimated CC time:** 6-9 hours including checkpoints
**Three human checkpoints:** post-C.2 (schema + engine wiring), post-C.4 (HITL editor), pre-C.7 (greenlight cutover)

---

## 0. What this phase ships

A buyer-facing UI that takes a URL, runs the onboarding engine end-to-end with live progress, renders the audit doc + lib tree summary, lets the customer review and edit matrix/scenarios via HITL, and on greenlight copies the customer-edited knowledge tree into the canonical `lib/<slug>-<user>/` directory the swarm + scanner + auditor will import.

**No new LLM steps.** Phase C is pure UI / API / persistence on top of Phase B's 12-step engine. The only billable cost is the engine itself ($0.66/run measured at iter3); everything else is Vercel + Supabase.

---

## 1. Architectural decisions (proposed answers to the three open questions)

### 1.1 Multi-tenant on one shared dashboard, NOT per-customer Vercel deploys

**Why:** Per-customer Vercel deploys are an ops nightmare (deploy keys, env vars, DNS). The existing dashboard already auth-gates `/dashboard/*` via Supabase and seeds AWP per-user via `lib/seed-awp.ts`. We extend that pattern: `auth.uid()` scopes everything; row-level security on Supabase; `lib/<slug>-<user_short>/` namespaces engine output so two customers onboarding the same URL don't collide.

**Cost:** one shared Vercel project, one Supabase project, one VPS. Operations stays linear in customer count, not per-customer.

### 1.2 Cost transparency — show the $/run during the audit

**Why:** The engine costs ~$0.66/run measured at iter3. That number is small enough to disclose. Customers paying for an audit-style product expect line-item visibility. Hiding it behind a flat fee creates surprise when usage scales (multi-contract protocols may run $1-3).

**UX:** progress page shows running token + dollar count per step, totaled at the bottom. Pricing for v1 is "engine cost + flat $X" — final pricing is a Phase D decision; for v1 the engine cost is shown but the customer isn't billed (we eat it during validation).

### 1.3 Swarm activation — keep the 7 shared fleet wallets for v1

**Why:** Per-customer wallet provisioning means custody, funding UX, key escrow, and gas-top-up automation. None of that ships in 6-9 hours of CC time. The v1 pitch is "drop a URL, watch the swarm test" — wallet onboarding kills that flow.

**v1 model:** all customers share the 7-agent fleet. Greenlight starts dispatching against the customer's contracts using existing wallets. This means we can only run ONE customer's swarm at a time (the fleet is scarce). v1 enforces this via a `swarm_status` table singleton lock.

**v2:** when revenue justifies custody work, add per-customer wallet fleets with a Privy-style embedded-wallet UX or a "bring your own funded wallets" path.

---

## 2. Build sequence (linear, do in order)

### C.1 — Engine output isolation (no UI yet)

**Goal:** stop the engine from writing directly to global `lib/<slug>/`. Move output to a per-run scratch directory. The greenlight step (C.7) will copy from scratch into the canonical location.

**Edits:**
- `framework/onboarding/engine.mjs` — accept `--out-dir` flag (default unchanged for backwards compat with iter3-style runs)
- All steps that write to `lib/<slug>/*` and `clients/<slug>/AUDIT-AND-DESIGN.md` — accept `outDir` from ctx and write under it
- Default behavior when `--out-dir` is not passed: write to `framework/onboarding/runs/<runId>/output/` (replacing the old direct write)

**Verification:**
- `node framework/onboarding/engine.mjs <url> --run-id phaseC-smoke` produces:
  - `runs/phaseC-smoke/output/lib/agentwork-protocol/contracts.ts` (etc.)
  - `runs/phaseC-smoke/output/clients/agentwork-protocol/AUDIT-AND-DESIGN.md`
- Existing `lib/agentwork-protocol/` from iter3 is **not modified** by this re-run

### C.2 — Supabase schema for onboarding runs

**New tables (one migration: `0006_onboarding_runs.sql`):**

```sql
-- One row per onboarding submission
create table onboarding_runs (
  id              uuid primary key default gen_random_uuid(),
  run_id          text not null unique,            -- engine's runId (e.g. "phaseC-smoke")
  user_id         uuid not null references auth.users(id) on delete cascade,
  url             text not null,
  status          text not null default 'queued'
    check (status in ('queued','running','complete','failed','greenlit','cancelled')),
  current_step    text,                             -- "07-generate-rules", etc.
  slug            text,                             -- discovered slug, set after step 02
  total_cost_usd  numeric(10,4) default 0,
  total_tokens_in int default 0,
  total_tokens_out int default 0,
  error           text,
  vps_run_dir     text,                             -- absolute path on VPS
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index on onboarding_runs(user_id, created_at desc);
create index on onboarding_runs(status);

-- One row per step per run — drives the live progress stepper
create table onboarding_step_events (
  id           uuid primary key default gen_random_uuid(),
  run_id       text not null references onboarding_runs(run_id) on delete cascade,
  step_id      text not null,                       -- "07-generate-rules"
  status       text not null check (status in ('running','ok','fail')),
  elapsed_ms   int,
  summary      text,                                -- one-line per-step output
  output_json  jsonb,                               -- full step.output
  cost_usd     numeric(10,4),
  emitted_at   timestamptz default now()
);

create index on onboarding_step_events(run_id, emitted_at);

-- Customer HITL edits — never modifies the engine output, stored as patches
create table onboarding_edits (
  id          uuid primary key default gen_random_uuid(),
  run_id      text not null references onboarding_runs(run_id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  target      text not null check (target in ('matrix','scenarios','rules-backlog')),
  patch_json  jsonb not null,                       -- shape per target
  note        text,
  created_at  timestamptz default now()
);

-- Engine -> swarm cutover. One row per greenlit run.
create table client_libs (
  id              uuid primary key default gen_random_uuid(),
  run_id          text not null references onboarding_runs(run_id),
  user_id         uuid not null references auth.users(id) on delete cascade,
  slug            text not null,                     -- e.g. "agentwork-protocol"
  user_short      text not null,                     -- first 6 of user_id
  lib_path        text not null,                     -- "lib/agentwork-protocol-a3f2e1/"
  blob_url        text,                              -- Vercel Blob signed URL for download
  greenlit_at     timestamptz default now(),
  unique (slug, user_short)
);
```

**RLS:**
- `onboarding_runs`, `onboarding_step_events`, `onboarding_edits`, `client_libs`: `user_id = auth.uid()` for select/insert/update. Service-role bypass for the engine writer.

**Verification:**
- Migration applies cleanly on a fresh Supabase project
- Service role can insert into all four tables
- Anon role on a known user can SELECT only its own rows

### C.3 — Engine progress wiring (VPS → Supabase)

**Goal:** every state.json mutation in `engine.mjs` ALSO writes a row to `onboarding_step_events` and updates `onboarding_runs`. This decouples the dashboard from the VPS filesystem.

**Approach:** add `framework/onboarding/lib/progress-emitter.mjs` that takes `(runId, stepId, status, output, costUsd)` and posts to Supabase via service-role key. Called from `engine.mjs` after each step. Falls back gracefully if env var unset (dev mode, no progress emitted).

**Cost-tracking:** engine already collects `usage` per LLM step. New helper `computeStepCost(usage)` converts to USD using current Anthropic pricing (Sonnet 4.5: $3/Mtok in, $15/Mtok out). Sum into `onboarding_runs.total_cost_usd` on each step.

**Engine entry point — VPS HTTP wrapper:**
- `framework/onboarding/server.mjs` — express server on VPS, port 7711
- POST `/onboarding/start { runId, url, userId }` — spawns engine.mjs as a child process, returns 202
- The dashboard's POST /api/onboarding inserts the `onboarding_runs` row, then POSTs to this VPS endpoint
- pm2 entry `onboarding-server` keeps it alive

**Verification:**
- `node framework/onboarding/server.mjs` listens on 7711
- POST a test job → child process spawns, state.json appears, Supabase rows trickle in
- Dashboard polling /api/onboarding/status?run_id=X returns live data

### C.4 — /hire route + run status page

**Goal:** replace the static placeholder with the working flow.

**Files:**
- `app/hire/page.tsx` — replace contents: URL input, "Run audit" button, examples gallery, value prop pillars (keep existing). Auth-gated like `/dashboard`: redirect to `/login?next=/hire` if not authenticated.
- `app/hire/runs/[runId]/page.tsx` — server component that fetches `onboarding_runs` + `onboarding_step_events` for the runId via the API. Renders:
  - Top: URL, status pill, total cost
  - Stepper: 12 boxes for the 12 engine steps, each with status + elapsed time + summary
  - Bottom (when status='complete'): two tabs — "Audit doc" (markdown render of AUDIT-AND-DESIGN.md from VPS via signed URL) + "Lib tree" (summary cards: contracts.ts N addresses, rules.ts N rules, matrix.ts N axes, scenarios.ts N total / K aspirational)
  - "Edit matrix/scenarios" CTA → routes to /hire/runs/[runId]/edit (C.5)

**API:**
- `app/api/onboarding/route.ts` — POST: creates onboarding_runs row, dispatches to VPS server. Auth required. Validates URL.
- `app/api/onboarding/status/route.ts` — GET ?run_id=X: returns the run row + step events. Polled every 3s by client.
- `app/api/onboarding/result/[runId]/route.ts` — GET: returns AUDIT-AND-DESIGN.md content + lib tree summary (counts only; no full lib content). Reads from VPS via authenticated fetch to a `/onboarding/result` endpoint on the VPS server.

**No SSE.** v1 polls every 3s. The longest step is ~135s (rules), so 3s polling is plenty granular and dramatically simpler than SSE.

**Verification:**
- `/hire` form posts to /api/onboarding → redirects to `/hire/runs/<runId>` → stepper updates live → completes → lib tree summary + audit doc tabs render.

### C.5 — HITL edit panel

**Goal:** customer reviews engine output, marks aspirational scenarios, fixes axis values, flags missing rules.

**Files:**
- `app/hire/runs/[runId]/edit/page.tsx` — three subpanels (tabs):
  - **Matrix** — table view of axes. Columns: name, description, values (chips), source_param. Add-axis button, remove-axis (X), inline edit. Constraint editor at bottom (rules in `axisA=X ⇒ axisB=Y` form).
  - **Scenarios** — card view, one per scenario. Each card: id, label, description, applicability (free-text input), status pill (toggle classifiable ↔ aspirational ↔ deferred). Notes field.
  - **Rules backlog** — read-only list of all engine-derived rules with search. "Report missing rule" form (free-text) appends to a backlog list, which gets surfaced in AUDIT-AND-DESIGN.md "Engine missed these" section at greenlight.

**Edit storage:** every save POSTs to `/api/onboarding/edit` which inserts an `onboarding_edits` row with the patch. The engine output stays untouched. Patches are JSON shaped per target:
  - matrix patch: `{ added: [Axis], removed: ["axisName"], modified: { axisName: { values: [...] } }, constraints: [...] }`
  - scenarios patch: `{ updates: { "s17-...": { status: "aspirational", applicability: "..." } }, added: [...], removed: [...] }`
  - rules-backlog patch: `{ entries: ["Missing rule: createJob requires X..."] }`

**No round-trip with the LLM.** Edits are pure UI manipulation of structured data. The greenlight step (C.7) applies all patches in order to produce the final files.

**Verification:**
- Customer adds an axis, removes a scenario, marks two scenarios aspirational, reports one missing rule
- Refresh page → all edits persist
- Save state visible (last-saved timestamp)

### C.6 — Vercel Blob export (download bundle)

**Goal:** customer can download the engine output (with their HITL edits applied) as a tar.gz to inspect locally or copy into their own repo.

**Approach:**
- New helper `framework/onboarding/lib/bundle-export.mjs` — given a runId + applied patches, produces a tar.gz of the lib tree
- New endpoint POST `/onboarding/bundle { runId }` on the VPS server — runs the bundler, uploads to Vercel Blob, returns blob URL
- Dashboard "Download bundle" button on the result page → calls this endpoint via dashboard proxy → presents signed URL

**Token:** uses `BLOB_READ_WRITE_TOKEN` env var. Downloads expire in 24 hours.

**Verification:**
- Click "Download bundle" → tar.gz with lib/<slug>/* + audit doc

### C.7 — Greenlight cutover

**Goal:** customer clicks "Start swarm" → patches are applied → final files committed to `lib/<slug>-<user_short>/` and `clients/<slug>-<user_short>/` → swarm starts dispatching.

**Approach:**
- New endpoint POST `/api/onboarding/greenlight { runId }`
- Server-side:
  1. Verify auth.uid() owns the run
  2. Verify swarm is idle (no other run is active per `client_libs` lock)
  3. Apply each `onboarding_edits` patch in order to the engine's output (in `runs/<runId>/output/`)
  4. Compute `user_short = userId.slice(0, 6)`
  5. Copy `runs/<runId>/output/lib/<slug>/` → `lib/<slug>-<user_short>/` on the VPS
  6. Copy `runs/<runId>/output/clients/<slug>/` → `clients/<slug>-<user_short>/`
  7. Insert `client_libs` row pointing at the new lib path
  8. Update `onboarding_runs.status = 'greenlit'`
  9. Notify HLO daemon to import from the new lib path (HLO either polls `client_libs` for active customer or restarts on a SIGHUP signal sent by the API)

**HLO change:** for v1, HLO continues running with `lib/awp/` baked in. The greenlit lib is staged but the swarm doesn't actually dispatch against it until a manual ops step. This is intentional — Phase C ships the cutover plumbing but stops short of "swarm autonomously starts dispatching against an arbitrary customer protocol on greenlight." That's a Phase D safety+revenue decision.

**Verification:**
- Greenlight an iter3-style run
- Confirm `lib/agentwork-protocol-<user_short>/` exists with the expected files
- Confirm `client_libs` row created
- Confirm `onboarding_runs.status = 'greenlit'`
- Confirm HLO does NOT auto-start dispatching (intentional v1 safety)

---

## 3. Cost envelope (steady state)

| Component | Cost per onboarding | Notes |
|---|---|---|
| Engine LLM calls | ~$0.66 | Phase B iter3 measured |
| Vercel function exec | ~$0 | Function calls under 10s |
| Supabase rows | ~$0 | <100 rows per run |
| VPS CPU | shared with HLO | One run at a time per the lock |
| Vercel Blob storage | ~$0 | tar.gz <1 MB, 24h TTL |
| **Total per onboarding** | **~$0.66** | within Anthropic API budget |

**Cost guardrail honored:** no new LLM steps. Greenlight, HITL, and bundle export all run without LLM calls.

---

## 4. What stays out of Phase C

- **Per-customer wallet fleets** — v2 work, requires custody/funding UX
- **Concurrent customer swarms** — v2 work, requires per-customer agent isolation
- **Auto-redeploy on contract version bumps** — v3 work, requires diff/versioning
- **Billing / payment** — v2 work, wallet-connect + per-day pricing
- **Engine prompt tweaks based on customer feedback** — v2 work, requires feedback aggregation
- **Removing the AWP fixture** — fixture stays as the regression test for engine prompt changes

---

## 5. Open decisions still TBD

1. **HLO cutover trigger** — does HLO auto-import the greenlit lib, or do we keep manual ops-driven cutover? Proposed: manual for v1 (safety), auto for v2 (after we trust greenlight enough)
2. **Storage location for engine output** — VPS filesystem (current) vs S3-style blob (cleaner). Proposed: VPS for v1; migrate to blob if VPS disk becomes a bottleneck
3. **Multi-step retry** — if step 07 (rules) fails partway, can the customer re-run from step 07? Proposed: v1 = no, kill the whole run; v2 = step-level resume via existing `--from` flag
4. **AWP-as-customer dogfooding** — does the existing `/dashboard` for AWP keep using `lib/awp/`, or migrate to `lib/awp-<isaiah_short>/`? Proposed: keep `lib/awp/` as the always-canonical fixture; AWP-the-customer is implicit (no greenlight needed for the dogfood case)

---

## 6. Verification at end of phase

- New customer creates account → /hire → submits AWP URL → engine runs → progress visible → audit doc + lib tree shown → makes 3 HITL edits → downloads bundle → clicks greenlight → `lib/agentwork-protocol-<user_short>/` exists with edits applied → `client_libs` row created → swarm idle (manual cutover for v1)
- Total cost on the dashboard matches engine state.json sum (within $0.01)
- Wall time end-to-end: <10 min (engine ~7 min + UI overhead)
- Two customers can submit URLs without colliding (slug-namespacing works)

---

## 7. Files touched

**New files:**
- `framework/onboarding/lib/progress-emitter.mjs`
- `framework/onboarding/lib/bundle-export.mjs`
- `framework/onboarding/server.mjs` (VPS HTTP wrapper)
- `app/hire/runs/[runId]/page.tsx`
- `app/hire/runs/[runId]/edit/page.tsx`
- `app/api/onboarding/route.ts`
- `app/api/onboarding/status/route.ts`
- `app/api/onboarding/result/[runId]/route.ts`
- `app/api/onboarding/edit/route.ts`
- `app/api/onboarding/greenlight/route.ts`
- `components/OnboardingStepper.tsx`
- `components/MatrixEditor.tsx`
- `components/ScenarioCardEditor.tsx`
- `components/RulesBacklog.tsx`
- `supabase/migrations/0006_onboarding_runs.sql`

**Modified files:**
- `framework/onboarding/engine.mjs` (--out-dir flag, progress emission)
- `framework/onboarding/steps/04-fetch-abis.mjs`, `07-generate-rules.mjs`, `08-generate-events.mjs`, `09-derive-matrix.mjs`, `10-derive-scenarios.mjs`, `11-generate-cell-defs.mjs`, `12-write-audit-doc.mjs` (write to outDir)
- `app/hire/page.tsx` (replace placeholder with URL input form)
- `package.json` (add @vercel/blob, tar deps)

**Untouched:**
- `lib/awp/*` (the canonical fixture)
- `lib/agentwork-protocol/*` (Phase B iter3 output — preserved as artifact)
- HLO daemon, scanner, auditor (no swarm-side changes)

---

**End of Phase C design.** Ready for kickoff.
