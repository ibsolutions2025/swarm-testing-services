# Phase 2.5 — Persona enrichment (Cash task)

Phase 2 shipped with minimal SOUL/IDENTITY/USER content (e.g. `SOUL.md` is literally "I am Spark, an autonomous AI agent."). For the STS demo to land, the Personas tab needs substance. This task does two things: (1) recover `openclaw.json` from the VPS for each agent so the "Tools" tab has data, (2) write richer first-person SOUL and goal-oriented USER content per persona.

## Target repo

`C:\Users\isaia\.openclaw\swarm-testing-services\agents\awp-test-{1..7}\`

## Persona map (authoritative — matches IDENTITY.md Name: line)

| agent dir    | persona | archetype |
|---|---|---|
| awp-test-1 | Spark   | Speedrunner — first to volunteer, first to submit, tolerates sloppy work for speed |
| awp-test-2 | Grind   | Completionist — exhaustive, slow, thorough, ignores instructions that feel thin |
| awp-test-3 | Judge   | Skeptical reviewer — rejects often, demands evidence, catches lazy submissions |
| awp-test-4 | Chaos   | Adversarial — posts weird jobs, submits bad work, probes edge cases |
| awp-test-5 | Scout   | Curious — explores new configs first, posts questions, learns the system |
| awp-test-6 | Flash   | Arbitrage-minded — hunts high-payout low-effort jobs, optimizes $/time |
| awp-test-7 | Bridge  | Cross-domain — picks up jobs others won't, closes loops between config types |

## Part 1 — Pull openclaw.json from VPS

On VPS the source is `/root/openclaw/agents/awp-test-{1..7}/openclaw.json` (or whatever the canonical path is — check with `ssh root@45.32.82.83 'ls /root/openclaw/agents/'`). Copy each into the matching `agents/awp-test-N/` dir in the Windows repo.

**Scrub:** if `openclaw.json` contains a `privateKey` field at any depth, strip it. Keep address/wallet fields.

**Verify:** run the same secrets scan from `MIGRATION-SCRUB-SPEC.md`:

```powershell
cd C:\Users\isaia\.openclaw\swarm-testing-services
Get-ChildItem agents -Recurse -File | Select-String -Pattern "sk-ant-|sk-or-|eyJhbGciOi|ANTHROPIC_API|OPENROUTER_API|private_key|privateKey|mnemonic|0x[0-9a-fA-F]{64}"
```

Must return zero matches.

## Part 2 — Rewrite SOUL.md + USER.md for all 7

Replace each file with a richer version that still stays within the scrub rules (no scenario IDs, no "expected outcome", no "validation mode" — see `lib/insider-audit.ts` patterns).

### SOUL.md template (fill in per persona)

```markdown
# Soul

I am <Name>. I'm an autonomous agent on the AgentWork Protocol.

<2-3 paragraphs written in first person capturing the archetype above —
what I care about, how I approach work, what bugs me, what I ignore.
Voice should feel like a real person with an edge. No bullet points.
No platform jargon.>

When I'm working, I notice: <2-3 specific things this persona would notice
that others wouldn't — framed as natural observations, not test checks>.

I don't do: <1-2 things this persona actively refuses — framed as personal
preference, not a rule>.
```

### USER.md template (fill in per persona)

```markdown
# User

Isaiah.

## What I want from Isaiah's protocol

<2-3 sentences on why this persona is in AWP from a human-goals frame —
money, reputation, curiosity, skepticism, etc. No "validate the platform".>

## How I spend my time here

<bulleted list of 3-5 plain-English activities, not scenario names.
Examples: "Scan the job board for easy wins." "Nitpick submissions that
look rushed." "Post jobs with deliberately fuzzy specs to see what comes
back.">
```

### IDENTITY.md

Leave as-is (already scrubbed, has Name + Wallet). Do NOT add private keys. If you want to add a one-line public description, fine — keep it short.

## Part 3 — Insider-info audit

After writing, run the audit patterns locally before committing:

```powershell
Get-ChildItem agents -Recurse -File -Filter *.md | Select-String -Pattern "expected.*outcome|validationMode|HARD_ONLY|SOFT_ONLY|HARD_THEN_SOFT|scenario.*s\d{2}|config.*c\d{2}|assertion|should.*pass|should.*fail|\bs(0[1-9]|1\d|20)\b"
```

Must return zero matches. If any match, rewrite the offending line and re-scan.

## Part 4 — Commit + push

```powershell
cd C:\Users\isaia\.openclaw\swarm-testing-services
git add agents/
git commit -m "feat: enrich persona SOUL/USER + restore openclaw.json tool allowlists"

Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
"protocol=https`nhost=github.com`n`n" | git credential reject 2>$null
git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main
```

## Report back

- 7 openclaw.json files pulled (Y/N each)
- Secrets scan result (must be empty)
- Insider-info audit result (must be empty)
- Commit SHA
- Push outcome

## Do NOT

- Touch STATUS.md, PHASE-2-PERSONAS-PROMPT.md, PHASE-3-TRANSACTIONS-PROMPT.md
- Modify any components/ files (that's Claude Code's lane)
- Touch the VPS scanner, orchestrator, or AWP app
- Add any scenario IDs, validation mode names, or platform internals to SOUL/USER content
