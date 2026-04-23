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
| Phase 1 Matrix UX port (commit c23bdf7) | SHIPPED (REVERT IN PROGRESS) | LifecycleTestsTab.tsx + config.json landed, but wired to read AWP's Supabase — reversing 2026-04-23 |
| **STS architectural pivot — 2026-04-23** | IN PROGRESS | STS owns swarm end-to-end; AWP is client #1. See `MIGRATION-PLAN.md`. Cash dispatched for DB migration + `sts-scanner` deploy. Claude Code reverting external-read wiring. |
| STS `lifecycle_results` table + migration 0002 | DISPATCHED | Cash: `supabase/migrations/0002_sts_ownership.sql`; schema mirrors AWP's shape + project_id column |
| STS scanner (`sts-scanner` on VPS) | DISPATCHED | Cash: lift `awp-lifecycle-scanner.mjs`, repoint at STS Supabase, pm2 start; AWP scanner untouched |
| Claude Code Phase 1 revert | DISPATCHED | Delete `lib/awp-supabase.ts`; rewrite `/api/test-results/lifecycle` to read STS Supabase; remove AWP_* env vars |
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
