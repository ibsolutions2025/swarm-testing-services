# STS Migration — Wrapup (Cash task)

Scanner is live and writing 325+ rows to `lifecycle_results`. Remaining wrapup:

## Scope

1. SCP the 7 agent dirs from VPS into the STS repo
2. Sanity-check no secrets in any of the copied files
3. Git commit + push (scanner code + agent dirs + migration SQL)

## Do NOT

- Touch AWP infra, AWP Supabase, AWP scanner
- Modify `STATUS.md`, `CLAUDE-CODE-PROMPT.md`, `MIGRATION-PLAN.md`, `PHASE-2-PERSONAS-PROMPT.md`, `MIGRATION-VPS-ONLY.md`
- Push with a hardcoded PAT — always load from central store

## Steps

### 1. SCP agent dirs

```powershell
# From PowerShell on Windows (which is where you run)
cd C:\Users\isaia\.openclaw\swarm-testing-services
New-Item -ItemType Directory -Force -Path agents
ssh root@45.32.82.83 "tar czf - -C /root/openclaw/agents awp-test-1 awp-test-2 awp-test-3 awp-test-4 awp-test-5 awp-test-6 awp-test-7" | tar -xzf - -C agents
```

(If the pipe form is awkward in PowerShell, do it via a tmp file: ssh -> `C:\temp\agents.tar.gz` -> `tar -xzf C:\temp\agents.tar.gz -C agents`.)

Expected: `agents/awp-test-1/` through `agents/awp-test-7/` each with IDENTITY.md, SOUL.md, USER.md, openclaw.json.

### 2. Secrets scan

Each awp-test-* folder should have ONLY identity docs. No keys, no seeds, no `.env` files. Run:

```powershell
Get-ChildItem agents -Recurse -File | Select-String -Pattern "sk-ant-|sk-or-|eyJhbGciOi|ANTHROPIC_API|OPENROUTER_API|private_key|mnemonic"
```

If any match — STOP, tell the user, do NOT commit.

### 3. Load PAT from central store

```powershell
Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
```

Verify `$env:GITHUB_PAT_RW` is set.

### 4. Commit and push

```powershell
cd C:\Users\isaia\.openclaw\swarm-testing-services
git add scanner/ agents/ supabase/migrations/0002_sts_ownership.sql MIGRATION-PLAN.md MIGRATION-VPS-ONLY.md MIGRATION-WRAPUP.md PHASE-2-PERSONAS-PROMPT.md STATUS.md
git status
```

Commit message: `feat: STS owns its own scanner + lifecycle_results (AWP is client #1)`

Push via inline PAT URL (skip GCM):

```powershell
"protocol=https`nhost=github.com`n`n" | git credential reject
git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main
```

### 5. Report back

- Number of agent dirs copied (expect 7)
- Commit SHA
- Any secrets found in the scan (should be none)
- Push success/failure
