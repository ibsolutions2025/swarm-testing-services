# STS Architectural Pivot — Migration Plan for Cash

## Context

Swarm Testing Service (STS) is being pivoted from "a read-only mirror of AWP's /testing page" into its own product, end-to-end. STS owns the swarm, the scanner, the results DB, the orchestrator, the matrix. AWP becomes a thin on-chain explorer with no test-data DB; AWP is client #1 of STS.

## Your scope (this task)

Stand up STS's own scanner writing on-chain test events into STS's own Supabase, under `project_id='awp'`. AWP's existing scanner keeps running in parallel — DO NOT TOUCH IT.

## Reference

- STS repo on Windows: `C:\Users\isaia\.openclaw\swarm-testing-services\`
- STS Supabase project ref: `ldxcenmhazelrnrlxuwq`
- STS service role key: in `.env.local` (via `vercel env pull`) or in `C:\Users\isaia\.openclaw\swarm-testing-credentials.md`
- AWP scanner on VPS: likely `/root/awp-indexer/awp-lifecycle-scanner.mjs` under pm2 (run `pm2 ls` to find it)
- Base Sepolia Alchemy URL: see memory `reference_alchemy_rpc.md`
- Contract addresses:
  - AWP JobNFT V14: `0x267e831e6ac1e7c9e69bd99aec7f41e03a421198`
  - AWP ReviewGate V3: `0xbf704b315a95cb21c64ac390f6b5788b5d72b397`
- Skills to consult first: `openclaw-ops`, `evm-indexing`, `vps-deploy`, `vps-code-editing`
- GitHub PAT rotated 2026-04-23 — load `$env:GITHUB_PAT_RW` from `C:\Users\isaia\.openclaw\secrets\github.env` every push

## Steps

### 0. Scp agent directories into the STS repo (unblocks Phase 2)

The 7 test agents (awp-test-1..7) have their identity docs on the VPS under `/root/openclaw/agents/awp-test-*/` (exact path — grep for it with `ls /root/openclaw/agents/` if needed). Copy them into the STS repo:

```bash
ssh root@45.32.82.83 "tar czf - -C /root/openclaw/agents awp-test-1 awp-test-2 awp-test-3 awp-test-4 awp-test-5 awp-test-6 awp-test-7" | tar xzf - -C "C:\Users\isaia\.openclaw\swarm-testing-services\agents\"
```

Adapt path/invocation to your actual SSH setup (`vps-deploy` skill). Want: a directory tree `agents/awp-test-N/{IDENTITY.md, SOUL.md, USER.md, openclaw.json}` inside the STS repo. Do NOT include any secrets or keys — sanity-check each file before committing.

Commit as part of the same `feat: STS owns its own scanner + lifecycle_results` commit in step 5, or as a separate `feat: mirror awp-test-* agent docs for STS personas tab` commit — your call.

### 1. Write migration `supabase/migrations/0002_sts_ownership.sql` in the STS repo

Create `lifecycle_results` table with columns matching AWP's shape plus a `project_id` column. Columns (nullable unless noted):

- `id` uuid PRIMARY KEY default `gen_random_uuid()`
- `project_id` text NOT NULL default `'awp'`
- `run_id` text NOT NULL
- `config_key` text NOT NULL
- `scenario_key` text NOT NULL
- `status` text NOT NULL CHECK (status IN ('passed','failed','partial','skipped','error','running'))
- `steps` jsonb NOT NULL default `'[]'::jsonb`
- `wallets` jsonb
- `agent_wallets` jsonb
- `job_id` text
- `onchain_job_id` bigint
- `started_at` timestamptz NOT NULL default now()
- `completed_at` timestamptz
- `duration_ms` integer
- `error_message` text
- `current_step` text
- `step_audits` jsonb
- `cell_audit` jsonb
- `created_at` timestamptz NOT NULL default now()
- `updated_at` timestamptz NOT NULL default now()

Indexes:
- `(project_id, config_key, scenario_key)`
- `(project_id, started_at DESC)`
- `(project_id, status)`

Unique constraint: `(project_id, run_id)`.

RLS:
- Enable RLS
- Policy: service_role can read/write all rows
- Policy: authenticated users can SELECT where `project_id = 'awp'` (for now; tighten to project membership later)

Add `updated_at` trigger consistent with migration 0001.

### 2. Execute the migration against STS Supabase

Use whichever path works: Supabase Management API with PAT, `psql` via pooler URL from `.env.local`, or the `supabase` CLI. Confirm table exists and is queryable.

### 3. Build `sts-scanner.mjs`

- Copy `awp-lifecycle-scanner.mjs` from VPS into a new directory `/root/sts-scanner/` (or wherever is clean).
- Change the Supabase URL + key to STS's (`ldxcenmhazelrnrlxuwq` + STS service role).
- Change the write target: every row inserts with `project_id: 'awp'`.
- Everything else (event signatures, Alchemy raw-fetch per `evm-indexing` skill, backfill window, event-proof-only step-push logic from Fix E6, chunking at 2k blocks with retry) stays identical.
- Deploy via pm2 as process name `sts-scanner`.
- Keep `awp-lifecycle-scanner` running — DO NOT TOUCH IT.

### 4. Verify

- After 15-30 min of sts-scanner running, count rows in STS `lifecycle_results`. Should be populating.
- Compare count to AWP's `lifecycle_results` for the last hour — STS should track within ~100 rows (backfill lag depends on starting block).
- Spot-check 5 random rows: `steps` array populated, `status` set, `onchain_job_id` present, `started_at` sane.

### 5. Commit to STS repo

Add to the repo:
- `supabase/migrations/0002_sts_ownership.sql`
- `scanner/sts-scanner.mjs` (mirror of VPS source, for source control)
- `scanner/README.md` (deploy instructions, env vars, pm2 command)

Commit message: `feat: STS owns its own scanner + lifecycle_results (AWP is client #1)`

Push via central PAT (rotated 2026-04-23):

```powershell
Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
git credential-manager erase --protocol=https --host=github.com 2>$null
git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main
```

Verify `.gitignore` excludes: `secrets/`, `github.env`, `.claude/`, `.env*`. Add any missing in the same commit.

### 6. Report

Post a short summary to the openclaw-ops session (agent=main / this session): row count in STS `lifecycle_results`, `pm2 ls` excerpt showing `sts-scanner` up, any blockers.

## Out of scope

- AWP-side teardown (awp-conductor/auditor/matrix-audit retirement) — later
- AWP app strip-down (kill /testing) — later
- STS dashboard API route rewrite — Claude Code will handle after this task lands
- Personas/Transactions tabs — later phases

## Do not

- Modify AWP infra, AWP Supabase `nyhwpkxezlwkwmjuklaj`, AWP scanner, or AWP app in any way
- Touch `CLAUDE-CODE-PROMPT.md` or `STATUS.md` in the STS repo (Cowork owns those)
- Commit service role keys or PATs
- Use cached PAT strings — load from `C:\Users\isaia\.openclaw\secrets\github.env` every time
