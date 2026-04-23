# Claude Code Prompt — Phase 2: Personas Tab

**Do not fire this until Cash reports back that (a) STS migration 0002 has landed and `lifecycle_results` is populated with rows for `project_id='awp'`, AND (b) the `awp-test-*` agent directories have been scp'd into `C:\Users\isaia\.openclaw\swarm-testing-services\agents\`.**

Paste the fenced block into Claude Code at the repo root.

---

```
Phase 2 — Personas tab port. Cash has landed the STS scanner + populated
lifecycle_results, and mirrored the 7 awp-test-* agent dirs into ./agents/.
Now port the Personas tab faithfully from AWP's /testing page.

SOURCE OF TRUTH:
  C:\Users\isaia\.openclaw\app-factory-fresh\agents\dev\projects\agentwork-protocol\src\app\testing\TestingAgentsTab.tsx
  (plus any siblings it imports — DocModal.tsx, TestScriptsTable.tsx, etc.)

  The agent on-disk docs now live at:
    C:\Users\isaia\.openclaw\swarm-testing-services\agents\awp-test-1\
      IDENTITY.md / SOUL.md / USER.md / openclaw.json
    ... through awp-test-7

DATA MODEL:
  For each awp-test-N agent:
    - wallet address → link BaseScan /address/<addr> (use BASESCAN_BASE from lib/awp-contracts.ts)
    - model (from openclaw.json — Kimi K2.6-TEE)
    - persona name (Spark/Grind/Judge/Chaos/Scout/Forge/Echo — see mapping below)
    - SOUL.md rendered as markdown
    - IDENTITY.md as key/value pairs
    - USER.md as task list
    - openclaw.json tool allowlist pretty-printed
    - INSIDER-INFO AUDIT status (see below)

PERSONA NAME MAPPING (authoritative source: each IDENTITY.md heading —
parse persona name from the file; fall back to this list if missing):
  awp-test-1  Spark
  awp-test-2  Grind
  awp-test-3  Judge
  awp-test-4  Chaos
  awp-test-5  Scout
  awp-test-6  Flash
  awp-test-7  Bridge

IMPLEMENTATION:

1. Create src/app/api/agents/[name]/route.ts (actually app/api/agents/[name]/
   since this repo has no src/). GET returns:
     { name, wallet, model, persona, soul_md, identity_md, user_md, openclaw_json }
   by reading from ./agents/<name>/*.md + openclaw.json on disk with fs.readFile.

2. Create lib/insider-audit.ts — regex scanner that scans SOUL.md + USER.md
   for leak patterns:
     /expected.*outcome/i
     /validationMode/i
     /HARD_ONLY|SOFT_ONLY|HARD_THEN_SOFT/
     /scenario.*s\d{2}/i
     /config.*c\d{2}/i
     /assertion/i
     /should.*pass|should.*fail/i
     /\bs(0[1-9]|1\d|20)\b/           // scenario ID mentions
   Returns { clean: boolean, findings: Array<{ file, line, match, pattern }> }.

3. Create components/personas/PersonaCard.tsx — one card per agent. Shows:
     - Header: agent name + persona name + wallet (BaseScan link)
     - Stat row: model + task count + last-run-at
     - Tabs: SOUL / IDENTITY / USER / Tools
     - Top-right audit badge: green ✓ "No insider info" OR red ✗ "N findings" (click → modal with line-by-line findings)

4. Create components/personas/PersonasTab.tsx — grid of PersonaCards. Reads
   ./agents/ directory via server-side helper; does NOT fetch from API for
   initial load (server component).

5. Wire into components/ProjectTabs.tsx — replace the current placeholder
   Personas tab content with <PersonasTab projectKey="awp" />.

6. Data flow: everything above is STATIC (read from repo filesystem at request
   time). No DB. Later, when STS generalizes, personas will move into STS
   Supabase keyed by project_id. For now, AWP's 7 agents are hardcoded
   to project_id='awp' — other projectKeys render an empty state with a
   "no personas configured" message.

DEPLOY:
  Commit message: "feat: Phase 2 — Personas tab with insider-info audit"
  Push via central PAT:
    Get-Content C:\Users\isaia\.openclaw\secrets\github.env | ForEach-Object {
      if ($_ -match '^([A-Z_]+)=(.+)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
    }
    "protocol=https`n host=github.com`n`n" | git credential reject 2>$null
    git push "https://x-access-token:$env:GITHUB_PAT_RW@github.com/ibsolutions2025/swarm-testing-services.git" HEAD:main

VERIFY:
  - /dashboard/campaigns/<awp-id> → Personas tab → 7 cards visible
  - Click an audit badge → modal shows findings (or confirms clean)
  - Wallet links go to BaseScan with correct address
  - SOUL/IDENTITY/USER rendered legibly

DO NOT:
  - Start Phase 3 (Transactions)
  - Modify STATUS.md, CLAUDE-CODE-PROMPT.md, MIGRATION-PLAN.md
  - Touch anything in orchestrator/, ./scanner/, or AWP infra
  - Fetch persona data from AWP's Supabase — everything is local filesystem

Phase 3 (Transactions) follows as a separate prompt once Phase 2 is live.
```
