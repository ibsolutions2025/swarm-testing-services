# Claude Code Prompt — Phase 3: Transactions Tab

Phase 2 (Personas) shipped in commit 41bfbc8. Phase 3 replaces the current stub `TransactionsTab` (inside `components/ProjectTabs.tsx`) with a real AWP-specific transactions view that reads live from STS Supabase (`lifecycle_results` table, already populated with 325+ rows by the sts-scanner).

Paste the fenced block into Claude Code at the repo root.

---

```
Phase 3 — Transactions tab port. STS now owns lifecycle_results; the
sts-scanner on the VPS writes it every 15 min (currently 325+ rows for
project_id='awp'). The existing Transactions tab in components/ProjectTabs.tsx
is stub-only (reads from the generic `runs` prop). For the AWP project it
should render a real swarm-activity table backed by STS Supabase.

SOURCE OF TRUTH FOR UX:
  C:\Users\isaia\.openclaw\app-factory-fresh\agents\dev\projects\agentwork-protocol\src\app\testing\
    — LifecycleTestsTab.tsx (already mirrored to ./components/matrix/)
    — TestScriptsTable.tsx, DocModal.tsx, and any transactions-shaped component
  The "transactions" concept on AWP's /testing page maps to rows in the
  lifecycle_results table: every row is one swarm attempt at one
  (config_key × scenario_key) cell, tied to an on-chain JobNFT.

DATA SOURCE (already wired):
  GET /api/test-results/lifecycle
  Returns rows from STS Supabase `lifecycle_results` with shape:
    {
      id, project_id, run_id,
      config_key, scenario_key,
      status,              // 'pending' | 'submitted' | 'accepted' | 'rejected' | 'expired' | 'failed'
      steps,               // JSONB array of step state snapshots
      step_audits,         // JSONB — per-step audit findings (may be null)
      cell_audit,          // JSONB — aggregate cell audit (may be null)
      wallets,             // JSONB — { poster, validator, ... }
      agent_wallets,       // JSONB array — wallets that acted on this run
      job_id,              // STS internal job id (may be null)
      onchain_job_id,      // numeric — JobNFT tokenId on Base Sepolia
      created_at, updated_at
    }
  If the table is missing the route returns 200 with { table_missing: true }
  — handle that shape.

IMPLEMENTATION:

1. Create components/transactions/TransactionsTab.tsx as a CLIENT component
   (uses useState, useEffect for polling). Fetch /api/test-results/lifecycle
   on mount and poll every 30s. Props: { projectKey: 'awp' }.

   Layout:
     - Top: aggregate counters — total, by status (accepted/rejected/expired/
       failed/pending). Color per RUN_OUTCOME_COLORS from lib/constants.ts,
       extend if a status is missing.
     - Filter bar: status (multi-select), config_key (dropdown), scenario_key
       (dropdown), free-text search (wallet, onchain_job_id). Persist filter
       state in URL search params so rows are linkable.
     - Sticky-header table:
         Status | Cell (config × scenario) | On-chain Job | Agent wallet |
         Steps completed | Created | Updated
       Click row → opens detail drawer (not modal — slide-in from right).
     - Detail drawer shows:
         - Cell label + status badge
         - BaseScan link for onchain_job_id (JobNFT contract from
           lib/awp-contracts.ts — BASESCAN_BASE + '/token/' + JOBNFT_ADDR +
           '?a=' + onchain_job_id)
         - BaseScan link for each agent wallet in agent_wallets[]
         - Steps timeline: walk `steps` JSONB, render each as a row with
           label + timestamp + result (pulled from step_audits when present)
         - cell_audit JSON pretty-printed at the bottom (collapsible)

2. Handle table_missing gracefully — render the same empty state the
   /api/test-runs route uses (icon + "STS table not yet provisioned").

3. Wire into components/ProjectTabs.tsx:
     - Add optional prop `awpTransactions?: LifecycleResult[]` (server-side
       fetched, or leave null to let the client component fetch).
     - Replace `{active === "transactions" && ...}` branch so that
       isAwp renders <TransactionsTab projectKey="awp" /> and non-AWP keeps
       the existing stub TransactionsTab (rename to StubTransactionsTab
       inline so there's no name collision).
     - Update the tab header count: for AWP, show the count from the API
       response (set via useState after fetch). For non-AWP, keep runs.length.

4. Update app/dashboard/campaigns/[id]/page.tsx:
     - No server-side fetch needed for AWP transactions — client-fetches.
     - Just pass projectKey='awp' through as already wired for personas.

5. Types: add lib/lifecycle-types.ts exporting LifecycleResult + LifecycleStatus
   shapes matching the Supabase schema above. Re-use in the API route handler
   if helpful.

6. BaseScan helper: lib/awp-contracts.ts already exports BASESCAN_BASE and
   JOBNFT_ADDR (V14 at 0x267e831e...). Re-use; do NOT hardcode addresses.

DEPLOY:
  Commit message: "feat: Phase 3 — Transactions tab reading STS lifecycle_results"
  Push via central PAT:
    Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object {
      if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
    }
    "protocol=https`nhost=github.com`n`n" | git credential reject 2>$null
    git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main

VERIFY:
  - /dashboard/campaigns/<awp-id> → Transactions tab → table populates within 2s
  - Aggregate counters add up to row count in Supabase
  - Row click → drawer opens with BaseScan link that resolves
  - Filtering by status actually narrows the rows
  - Polling picks up new rows without a page reload
  - table_missing={true} response renders the empty state (not a 500)

DO NOT:
  - Start Phase 4 or any retirement of AWP infra
  - Modify STATUS.md, MIGRATION-*.md, PHASE-2-PERSONAS-PROMPT.md
  - Touch the sts-scanner code, orchestrator/, or AWP app
  - Add writes to lifecycle_results — this tab is read-only
  - Fetch AWP Supabase — everything comes from STS Supabase via our API route

After it's live, report back with: commit SHA, Vercel deploy ID, and a
screenshot (or text description) of the rendered tab.
```
