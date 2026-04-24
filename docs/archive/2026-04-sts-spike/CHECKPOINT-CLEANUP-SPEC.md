# Checkpoint cleanup + save

After Phases 2-6 shipped, the STS repo root has 20+ spec/deploy/audit .md files from the build spikes. They're in git history (good) but clutter the root and confuse readers who expect README + STATUS + code. Move the phase docs into a single subfolder, update STATUS.md with the Phase 5 + 6 outcomes, and commit a clean checkpoint.

## Scope

Organize the repo so that future sessions + buyers see —

```
swarm-testing-services/
  README.md                    (if exists; otherwise leave)
  STATUS.md                    (updated with Phase 5 + 6)
  SWARM-TESTING-PRODUCT-SPEC.md
  SWARM-TESTING-SPLIT-PLAN.md
  CLAUDE-CODE-KICKOFF.md
  CLAUDE-CODE-PROMPT.md        (keep — active prompt pattern)
  docs/
    archive/
      2026-04-sts-spike/
        AUDIT-2026-04-23.md
        AUDIT-OVERNIGHT-SPEC.md
        DEPLOY-MECHANICAL-SWARM-SPEC.md
        DEPLOY-PHASE-5-SPEC.md
        DEPLOY-PHASE-6-VPS-SPEC.md
        DEPLOY-SWARM-DRIVER-SPEC.md
        FIX-CRON-ENV-SPEC.md
        FIX-SWARM-DRIVER-SPEC.md
        MIGRATION-PLAN.md
        MIGRATION-SCRUB-SPEC.md
        MIGRATION-VPS-ONLY.md
        MIGRATION-WRAPUP.md
        MIGRATION-SCRUB-SPEC.md
        PHASE-2-PERSONAS-PROMPT.md
        PHASE-2.5-ENRICH-SPEC.md
        PHASE-3-TRANSACTIONS-PROMPT.md
        PHASE-4-CONSOLIDATED-CC-PROMPT.md
        PHASE-4-OPERATIONS-DASHBOARD-PROMPT.md
        PHASE-5-REAGENT-SWARM-PROMPT.md
        PHASE-6-FINALIZE-SPEC.md
        PHASE-6-ORCHESTRATION-STREAM-PROMPT.md
        SWARM-MECHANICAL-REBUILD-PLAN.md
        CHECKPOINT-CLEANUP-SPEC.md  (this file, moved in the same commit)
        README.md                    (new — one-paragraph tombstone explaining what's in here)
  scripts/
    (unchanged — VPS scripts live here)
```

## Step 1 — create the archive folder + tombstone README

`docs/archive/2026-04-sts-spike/README.md` content:

```
# Archive — STS build spike April 22-24, 2026

This directory preserves the spec files, deploy specs, audits, and CC
prompts generated during the two-day build of Swarm Testing Services
(STS) out of the AWP monorepo. They shipped Phases 2 through 6 —
Personas, Transactions, Operations, re-agented swarm, and the
orchestration stream.

Everything here is a paper trail, not active documentation. For the
current state of STS, start with:

  - ../../STATUS.md         — running status of infra + outstanding work
  - ../../SWARM-TESTING-PRODUCT-SPEC.md
  - ../../SWARM-TESTING-SPLIT-PLAN.md
  - ../../scripts/          — live VPS scripts (swarm-drain, swarm-create, swarm-agent-runner)

Commits that delivered each phase —
  Phase 2   — 41bfbc8  (Personas tab)
  Phase 2.5 — 48894e2  (persona enrichment)
  Phase 3   — 1c0f884  (Transactions tab)
  Phase 4   — 481f9eb  (Operations tab + heartbeats)
  Phase 5   — 751fa53  (re-agent swarm via OpenRouter)
  Phase 5.1 — 160294a  (nonce fix + error-slice bump)
  Phase 6   — d03b72e  (orchestration stream UI)
  Phase 6   — a1558a8  (orchestration event emissions in drain+create)
  Phase 6.1 — 325f732  (validationInstructions fix — createJob no longer reverts)
```

## Step 2 — move all phase/deploy/audit/migration/fix .md files

Use `git mv` to preserve history:

```powershell
cd C:\Users\isaia\.openclaw\swarm-testing-services
New-Item -ItemType Directory -Path docs\archive\2026-04-sts-spike -Force | Out-Null
git mv AUDIT-2026-04-23.md              docs\archive\2026-04-sts-spike\
git mv AUDIT-OVERNIGHT-SPEC.md          docs\archive\2026-04-sts-spike\
git mv DEPLOY-MECHANICAL-SWARM-SPEC.md  docs\archive\2026-04-sts-spike\
git mv DEPLOY-PHASE-5-SPEC.md           docs\archive\2026-04-sts-spike\
git mv DEPLOY-PHASE-6-VPS-SPEC.md       docs\archive\2026-04-sts-spike\
git mv DEPLOY-SWARM-DRIVER-SPEC.md      docs\archive\2026-04-sts-spike\
git mv FIX-CRON-ENV-SPEC.md             docs\archive\2026-04-sts-spike\
git mv FIX-SWARM-DRIVER-SPEC.md         docs\archive\2026-04-sts-spike\
git mv MIGRATION-PLAN.md                docs\archive\2026-04-sts-spike\
git mv MIGRATION-SCRUB-SPEC.md          docs\archive\2026-04-sts-spike\
git mv MIGRATION-VPS-ONLY.md            docs\archive\2026-04-sts-spike\
git mv MIGRATION-WRAPUP.md              docs\archive\2026-04-sts-spike\
git mv PHASE-2-PERSONAS-PROMPT.md       docs\archive\2026-04-sts-spike\
git mv PHASE-2.5-ENRICH-SPEC.md         docs\archive\2026-04-sts-spike\
git mv PHASE-3-TRANSACTIONS-PROMPT.md   docs\archive\2026-04-sts-spike\
git mv PHASE-4-CONSOLIDATED-CC-PROMPT.md docs\archive\2026-04-sts-spike\
git mv PHASE-4-OPERATIONS-DASHBOARD-PROMPT.md docs\archive\2026-04-sts-spike\
git mv PHASE-5-REAGENT-SWARM-PROMPT.md  docs\archive\2026-04-sts-spike\
git mv PHASE-6-FINALIZE-SPEC.md         docs\archive\2026-04-sts-spike\
git mv PHASE-6-ORCHESTRATION-STREAM-PROMPT.md docs\archive\2026-04-sts-spike\
git mv SWARM-MECHANICAL-REBUILD-PLAN.md docs\archive\2026-04-sts-spike\
git mv CHECKPOINT-CLEANUP-SPEC.md       docs\archive\2026-04-sts-spike\
```

Do NOT move: README.md, STATUS.md, SWARM-TESTING-PRODUCT-SPEC.md, SWARM-TESTING-SPLIT-PLAN.md, CLAUDE-CODE-KICKOFF.md, CLAUDE-CODE-PROMPT.md. Those are still active.

Also do NOT move the `scripts/` folder or its contents — those are live code.

## Step 3 — update STATUS.md with Phase 5 + 6 entries

Find the existing "Phase 3 Transactions tab port" and "Mechanical swarm v1 deployed" table rows. Append these new rows immediately after:

```
| **Phase 4 Operations tab** | DONE 2026-04-23 | Commit 481f9eb. 3 panels — heartbeat cards, lifecycle timeline, pipeline breakdown. Driver attribution post-cutover. |
| **Phase 5 Re-agent swarm** | DONE 2026-04-24 | Commits 751fa53 + 160294a. swarm-agent-runner.mjs via OpenRouter (gpt-4o-mini default). Drain + create call runner for content-producing actions only. Insider-info guard pre-HTTP. Cost ~$5/day envelope. |
| **Phase 6 Orchestration stream** | DONE 2026-04-24 | Commits d03b72e + a1558a8 + 325f732. Supabase migrations 0003 (heartbeats) + 0004 (orchestration_events). VPS scripts emit scan/decision/dispatch/skip/error rows. Operations tab merges with lifecycle steps by tx_hash. All 3 heartbeat cards green post-cron-env fix. First end-to-end persona-driven createJob landed (job #676, Bridge, title "Analyze and Improve User Experience for Cross-Domain Applications"). |
```

## Step 4 — commit + push

```
git add docs/archive/2026-04-sts-spike/README.md
git status  # verify only the moves, the new README, and STATUS.md edits
git commit -m "chore: archive phase 2-6 spec docs; update STATUS with Phase 4/5/6 shipping milestones"
Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') } }
"protocol=https`nhost=github.com`n`n" | git credential reject 2>$null
git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main
```

## Step 5 — verify

1. `git ls-files docs/archive/2026-04-sts-spike/` — should list ~22 .md files + new README
2. `ls *.md` at repo root — should show only README/STATUS/SWARM-*/CLAUDE-CODE-* (~5 files)
3. Vercel auto-redeploy triggers from the push — confirm build still passes (no code changed; only doc moves, should be a fast green build)

## Report back

1. Archive folder created (y/n + file count)
2. File moves (count moved; any that failed)
3. STATUS.md Phase 5 + 6 rows added (paste diff)
4. Commit SHA + push outcome
5. Vercel build status after auto-redeploy

## Do NOT

- Delete any file — git mv only. History must be preserved.
- Touch scripts/, components/, lib/, app/, supabase/migrations/, agents/, public/ — code + data stay put.
- Modify live persona content or any runtime config.
