# Swarm Testing Services — STATUS

**Live URL:** https://swarm-testing-services.vercel.app
**Supabase project ref:** ldxcenmhazelrnrlxuwq
**Credentials:** `/sessions/ecstatic-tender-fermat/mnt/.openclaw/swarm-testing-credentials.md` (outside repo)

## Provisioning status (2026-04-22)

| Piece | Status | Notes |
|---|---|---|
| Scaffold (Next.js 14 + Tailwind) | DONE | Landing, /login, /dashboard, API routes, middleware |
| Supabase project | DONE | Free plan, Americas region |
| DB schema migration `0001_init.sql` | DONE | campaigns / matrices / personas / runs + RLS + updated_at trigger |
| Supabase Auth config | DONE | Magic-link OTP; Site URL + Redirect URLs set |
| Vercel project | DONE | Connected to GitHub repo, first successful build |
| Vercel env vars | DONE | 4 of 6 populated — see below |
| Vercel redeploy with env vars | DONE | Production build 2m50s; live and serving |
| Landing page smoke test | DONE | /, /login render; `Start a test campaign` and `Sign in` work |
| Magic-link request smoke test | DONE | POST accepted; "Check your inbox" confirmation rendered |
| Standard project layout (Matrix/Personas/Transactions tabs) | DONE | `components/ProjectTabs.tsx` wraps all three; detail page refactored |
| AWP auto-seed on first dashboard visit | DONE | `lib/seed-awp.ts` + `app/dashboard/layout.tsx`; seeds campaign + 4×5 matrix + 4 personas + 20 runs via service-role admin client |
| "Campaign" → "Project" UI rename | DONE | Nav, list page, detail page, new-project form (DB table still `campaigns`) |
| Deploy of layout+seed changes | DONE | commit 4da03ab, deploy dpl_aehj9QKYRdCkzE33tzc78KYbTNtJ READY on production 2026-04-22 |
| Dashboard + campaign create test | PENDING | Requires Isaiah to click the link in his inbox |
| Email+password auth swap | DONE | /login replaced magic link; /api/auth/{signin,signup}; admin create-or-update for existing magic-link users; Suspense wrap for Next.js 14 prerender (commit cb0117d) |
| Rich AWP /testing UX port spec | DONE | `CLAUDE-CODE-PROMPT.md` drafted 2026-04-22; NOW OUTDATED — read-from-AWP-Supabase pattern was reversed |
| Phase 1 Matrix UX port (commit c23bdf7) | DONE | LifecycleTestsTab.tsx + config.json landed. Wrong-direction wiring (reading AWP Supabase) reverted in commit ef6cde4. |
| **STS architectural pivot — 2026-04-23** | **DONE** | STS owns swarm end-to-end; AWP is client #1. Scanner live on VPS pm2; `lifecycle_results` populating with 325+ rows; 7 agent dirs scrubbed + committed. Final commit `8202d43`. |
| STS `lifecycle_results` table + migration 0002 | DONE | Table created via Supabase SQL editor (Mgmt API PAT was wrong-org). Columns: project_id, run_id, config_key, scenario_key, status, steps, wallets, agent_wallets, job_id, onchain_job_id, timestamps, step_audits, cell_audit. RLS: service_role + authenticated-SELECT on project_id='awp'. |
| STS scanner (`sts-scanner` on VPS) | LIVE | pm2 id 16, 15-min loop, Alchemy raw-fetch prefetch + event-proof-only step push. 325 rows written on first clean pass. Env loaded via pm2 ecosystem.config.cjs (NOT .env dotfile — that path doesn't auto-load). |
| Claude Code Phase 1 revert | DONE | `lib/awp-supabase.ts` deleted. `/api/test-results/lifecycle` reads STS Supabase with graceful-degrade on missing table (PGRST205 pattern). |
| Agent dirs (awp-test-1..7) committed | DONE | Scrubbed — private keys stripped from IDENTITY.md, wallet addresses retained. Personas: Spark / Grind / Judge / Chaos / Scout / Flash / Bridge. Ready for Phase 2 Personas tab port. |
| **Phase 2 Personas tab port** | DONE | Claude Code commit 41bfbc8. 7 persona cards, insider-info audit badges, SOUL/IDENTITY/USER/Tools tabs. All 7 audit badges green. |
| **Phase 2.5 persona content enrichment** | DONE | Cash commit 48894e2. 7 SOUL.md + 7 USER.md rewritten with distinct voice per persona (Spark/Grind/Judge/Chaos/Scout/Flash/Bridge). Insider-info audit still clean. openclaw.json NOT recovered — VPS never had them outside awp-config/; Tools tab shows empty state. |
| **Phase 3 Transactions tab port** | DONE | Claude Code commit 1c0f884, Vercel Ready. Reads `/api/test-results/lifecycle` (STS Supabase), 7-counter aggregate bar, URL-synced filters, 30s polling, slide-in drawer with BaseScan deep-links per step. Used DB status enum (passed/failed/partial/skipped/error/running) — prompt had wrong values, Claude Code caught it. |
| **End-to-end audit (2026-04-23 06:28 UTC)** | DONE | Full report at `AUDIT-2026-04-23.md`. Infra green, flywheel gap uncovered — swarm drivers all disabled/missing. Scanner produces no `step_audits`/`cell_audit`. |
| **Swarm driver discovery + restart** | DONE 2026-04-23 | Root cause: `awp-agent-loop.mjs` MCP was fine but model API keys (CHUTES/OPENROUTER/MOONSHOT) never deployed to VPS so every cycle died at 401 "missing authorization". Fix: `/root/.awp-env` holds all 3 keys (600 perms), `/root/test-swarm/run-cycle.sh` sources env + runs auto-cycle.mjs, 7 staggered crontab entries (:00,:04,:08,:12,:16,:20,:24 + :30 marks) fire every 30 min per agent. Log files /var/log/awp-cycle-{1..7}.log each 450-677KB within first hour. Spec: `DEPLOY-SWARM-DRIVER-SPEC.md`. |
| **Post-fix flywheel audit 2026-04-23 17:30 UTC** | OBSERVATIONS | 662 total rows (4 new today, up from 658 this morning). Max onchain_job_id=662. Only 1 row updated in last 60 min + 3 status transitions all day — agents are cycling but production rate is slow. Possible ReviewGate pending-review backlog bottleneck (not yet confirmed — Cash timed out on that check). UI "45 min ago" latest is consistent with scanner-driven updated_at semantics, not a bug. |
| **Scenario-coverage audit 2026-04-23 17:51 UTC** | FINDINGS | 526/662 rows stuck at `s00-in-flight` (79%). 11 of 13 terminal scenarios either empty (s02/s10/s12/s16) or sparse. Config distribution skewed — 33% of rows in `soft-open-single-open-open`. Root cause: `auto-cycle.mjs` posts faster than it progresses, LLM wastes turns re-reading job lists. |
| **Mechanical swarm v1 deployed 2026-04-23 19:40 UTC** | LIVE | Replaced LLM auto-cycle with two mechanical scripts. `swarm-drain.mjs` runs every 5 min on VPS (up to 25 on-chain writes per run — claim / submit / approve / reject / rejectAll / cancel / finalize / reviews). `swarm-create.mjs` runs every 15 min, targets one under-represented scenario per run, annotates `intended-scenarios.json[jobId]=scenario_key`. Drain reads that annotation to walk each job through its intended event pattern. Zero LLM calls. Job #667 created in smoke test (scenario s12-rating-gate-pass). Drain smoke test landed 25 writes incl. FINALIZE on 4 timed jobs (590-593). Crontab: `*/5` drain + `*/15` create. Expected: Chutes spend from swarm drops to ~0. |
| AWP-side infra retirement | DEFERRED | After STS scanner proven in parallel for 48h: retire awp-conductor/auditor/matrix-audit tasks and `/testing` page |
| AWP app strip-down to explorer | DEFERRED | Final phase: kill `/testing`, remove `lifecycle_results` from AWP Supabase dependency, make AWP read events directly from chain |
| Orchestrator deploy to VPS | PENDING | pm2 service not yet up |
| `OPENROUTER_API_KEY` env var | PENDING | Reuse Isaiah's existing key |
| `ORCHESTRATOR_WEBHOOK_URL` env var | PENDING | Set once orchestrator is on VPS |

## Vercel env vars set (All Environments)

| Key | Status |
|---|---|
| NEXT_PUBLIC_SUPABASE_URL | SET |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | SET |
| SUPABASE_SERVICE_ROLE_KEY | SET |
| ORCHESTRATOR_WEBHOOK_SECRET | SET (48-char hex) |
| OPENROUTER_API_KEY | NOT SET — Isaiah to paste |
| ORCHESTRATOR_WEBHOOK_URL | NOT SET — set after VPS deploy |

## Next steps

1. **Isaiah: click the magic-link email** sent to isaiah@ibsolutions.ai → lands on `/dashboard` → create a campaign to validate the full auth flow + RLS-scoped writes.
2. **Add `OPENROUTER_API_KEY`** to Vercel env vars (or tell the next session what it is so it can be added via dashboard).
3. **Deploy orchestrator** (`swarm-testing-services/orchestrator/`) to VPS under pm2, expose a webhook URL, set `ORCHESTRATOR_WEBHOOK_URL` in Vercel, redeploy once more.
4. **First real campaign**: use AWP as the target (internal dogfood). AWP is the first client per the product spec.

## Known gotchas carried forward

- **NEXT_PUBLIC_\*** env vars must NOT be marked Sensitive in Vercel — they need to be exposed at build time. This was caught today — the toggle is globally off in the create dialog now.
- **Vercel multi-line paste into Key field strips newlines** — always use "Add Another" to append rows, don't paste .env contents.
- **Supabase SQL editor is Monaco, not CodeMirror** — if scripting it, use `monaco.editor.getEditors()[0].setValue()`.
- **AWP-style indexer patterns apply** — future orchestrator should prefer Alchemy raw-fetch if we ever index on-chain events here; for now it only hits OpenRouter + Supabase.
