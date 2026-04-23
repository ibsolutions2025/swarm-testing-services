# Agent-dir scrub + commit spec (Cash task)

Continuation of the agent-dirs copy. First pass found real private keys in the source dirs. This pass scrubs and commits.

## Source on VPS

7 agent dirs at `/root/test-swarm/agent-N/` where N = 1..7. (Note: the OpenClaw agent names are `awp-test-1..7`, but the on-VPS directory names are `agent-1..7`. Rename during copy.)

## Destination on Windows

`C:\Users\isaia\.openclaw\swarm-testing-services\agents\awp-test-N\` where N = 1..7.

## Files to copy (allowlist)

From each `/root/test-swarm/agent-N/`, copy ONLY these files to `agents/awp-test-N/`:

- `IDENTITY.md` (prefer the one at agent root; if missing, from `agent-files/IDENTITY.md`)
- `SOUL.md`
- `USER.md`
- `openclaw.json`

**DO NOT copy:**
- `awp-config/` directory (contains private keys)
- `last-run*.json` (runtime state)
- Any `.env` files
- Any duplicate copy of IDENTITY.md that would land outside `agents/awp-test-N/`

## Scrub (after copy, before commit)

In each `agents/awp-test-N/IDENTITY.md`:
- Remove any line matching `/Private Key/i` (case-insensitive)
- Remove any line containing a 64-char hex value matching `0x[0-9a-fA-F]{64}`
- KEEP lines with 40-char hex wallet addresses matching `0x[0-9a-fA-F]{40}` — those are public

In each `agents/awp-test-N/openclaw.json`:
- If a `privateKey` field exists at any depth, delete that field (keep everything else)
- Keep any `address` or `wallet` fields

## Secrets verification scan

```powershell
cd C:\Users\isaia\.openclaw\swarm-testing-services
Get-ChildItem agents -Recurse -File | Select-String -Pattern "sk-ant-|sk-or-|eyJhbGciOi|ANTHROPIC_API|OPENROUTER_API|private_key|privateKey|mnemonic|0x[0-9a-fA-F]{64}"
```

**Must return ZERO matches.** If any match — STOP, do not commit, report what matched.

## Commit + push

Load PAT from central store:

```powershell
Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
```

Stage and commit:

```powershell
cd C:\Users\isaia\.openclaw\swarm-testing-services
git add scanner/ agents/ supabase/migrations/0002_sts_ownership.sql MIGRATION-PLAN.md MIGRATION-VPS-ONLY.md MIGRATION-WRAPUP.md MIGRATION-SCRUB-SPEC.md PHASE-2-PERSONAS-PROMPT.md STATUS.md
git status
git commit -m "feat: STS owns its own scanner + lifecycle_results (AWP is client #1)"
```

Push (skip GCM, inline PAT):

```powershell
"protocol=https`nhost=github.com`n`n" | git credential reject
git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main
```

## Report back

- Number of agent dirs copied (expect 7)
- Secrets-scan output (must be empty)
- Commit SHA
- Push outcome (should land on main)
