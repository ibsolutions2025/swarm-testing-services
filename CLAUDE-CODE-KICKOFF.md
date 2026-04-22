# Claude Code kickoff — Swarm Testing Services bootstrap

**Paste this into Claude Code** with the working directory set to `C:\Users\isaia\.openclaw\swarm-testing-services`.

Claude Code should have shell + gh + vercel CLI on the Windows machine.

---

## What's in the scaffold

**Next.js app (this repo root)**
- `app/page.tsx` — landing page
- `app/pricing/page.tsx` — pricing tiers
- `app/case-studies/awp/page.tsx` — AWP case study
- `app/login/page.tsx` — magic-link auth
- `app/auth/callback/route.ts` — magic-link redirect exchange
- `app/auth/signout/route.ts` — sign-out POST
- `app/dashboard/page.tsx` — new campaign form
- `app/dashboard/campaigns/page.tsx` — list campaigns
- `app/dashboard/campaigns/[id]/page.tsx` — campaign detail + matrix heatmap
- `app/dashboard/personas/page.tsx` — persona library browser
- `app/api/test-campaign/route.ts` — POST new campaign (fires orchestrator webhook)
- `app/api/campaigns/route.ts` — GET user's campaigns
- `app/api/campaigns/[id]/route.ts` — GET campaign + matrix + personas + runs
- `app/api/orchestrator/webhook/route.ts` — orchestrator callback (HMAC-signed)
- `components/` — DashboardNav, CampaignStatus, ScenarioMatrix, PersonaCard
- `lib/` — supabase, types, constants, hmac, format
- `middleware.ts` — Supabase session refresh

**Orchestrator service (`orchestrator/`)**
- Full end-to-end: matrix designer + persona generator + dispatcher + main loop
- Uses OpenRouter for LLM calls (Sonnet for matrix+persona, Haiku for runs)
- Concurrent cell dispatch with configurable limit

**Personas library (`personas/`)**
- 8 starter personas in `library/` (JSON)
- Base SOUL template

**Supabase (`supabase/migrations/`)**
- `0001_init.sql` — campaigns, matrices, personas, runs tables + RLS + indexes

---

## Prompt to paste into Claude Code

```
You are bootstrapping a brand-new product called "Swarm Testing Services" for me (Isaiah, GitHub org `ibsolutions2025`). A full scaffold already exists in this directory — Next.js frontend + orchestrator service + Supabase schema + persona library. Your job is to install, build, push, and deploy it end to end.

1. Sanity check the tree
   - `ls` and confirm: app/, components/, lib/, orchestrator/, personas/library/, supabase/migrations/, middleware.ts, package.json, CLAUDE-CODE-KICKOFF.md (this file).

2. Install and build the Next.js app
   - `yarn install` (use yarn — vercel.json pins it). If yarn missing: `corepack enable` then retry.
   - `yarn build`. If the build fails, diagnose and fix. Do NOT proceed until `yarn build` succeeds cleanly.
   - Typical failure: missing env vars. The build should work with no env — Supabase client warns but doesn't throw at build time. If it does throw, tell me.

3. Install orchestrator deps (no run yet)
   - `cd orchestrator && npm install && cd ..`

4. Git init + GitHub push
   - `git init`
   - `git add .`
   - `git commit -m "Initial scaffold: Swarm Testing Services MVP"`
   - `gh repo create ibsolutions2025/swarm-testing-services --public --source=. --push`
   - Confirm: https://github.com/ibsolutions2025/swarm-testing-services exists and has the files.

5. First Vercel deploy
   - `vercel link` — scope: `ibsolutions2025`, create NEW project `swarm-testing-services`. Do NOT reuse an existing project.
   - `vercel --prod` — first build may fail on env vars; that's fine. Capture the URL.

6. Provision Supabase
   - Open https://supabase.com/dashboard in the browser Claude Code has access to. Create new project `swarm-testing-services` in the same org Isaiah has admin rights in.
   - Once provisioned, go to SQL editor and paste the contents of `supabase/migrations/0001_init.sql`. Run it.
   - Copy project URL, anon key, service-role key.
   - In Vercel → Settings → Environment Variables (production + preview + development), set:
     - NEXT_PUBLIC_SUPABASE_URL
     - NEXT_PUBLIC_SUPABASE_ANON_KEY
     - SUPABASE_SERVICE_ROLE_KEY
     - OPENROUTER_API_KEY (ask Isaiah for the value)
     - ORCHESTRATOR_WEBHOOK_URL (leave unset for now — orchestrator isn't deployed yet)
     - ORCHESTRATOR_WEBHOOK_SECRET (generate a 48-char hex string, same value will be used by the orchestrator service when it deploys)
   - In Supabase Auth → Providers: enable "Email" magic-link, disable everything else.
   - In Supabase Auth → URL configuration: add the Vercel production URL AND `http://localhost:3000` under "Redirect URLs".

7. Redeploy + smoke test
   - `vercel --prod` once more so the new env vars take.
   - Visit the production URL. Landing page should render. Click "Sign in", enter your email, receive magic link, click it — you should land on /dashboard.
   - Submit a test campaign: URL `https://linear.app` + description at least 20 characters. Expect a 201 + redirect to /dashboard/campaigns/<id>.
   - Confirm the row appears in Supabase `campaigns` table (status=queued).

8. Report back with
   - production URL, GitHub repo URL, Supabase project ref
   - any step that failed + its error
   - do NOT start the orchestrator service yet — that's the next phase

RULES:
- Never commit `.env.local` or any file with real keys (`.gitignore` already covers it — verify).
- Never `git push --force`.
- If yarn/npm disagree, default to yarn (vercel.json pins it).
- If anything touches Supabase that wasn't in this prompt, stop and ask me.
- If a build error looks like a type mismatch with Supabase SSR, the fix is almost always bumping `@supabase/ssr` to the latest minor — try that first before refactoring.
```

---

## After step 8 — starting the orchestrator

Once the frontend is live and campaigns are persisting, run the orchestrator in a second Claude Code session (or directly on the VPS):

```
# On Isaiah's Windows machine or VPS
cd orchestrator
export SUPABASE_URL=<from supabase>
export SUPABASE_SERVICE_ROLE_KEY=<from supabase>
export OPENROUTER_API_KEY=<isaiah's key>
node smoke.mjs      # end-to-end check, no Supabase writes
node run.mjs --once # pick up and process one queued campaign
node run.mjs        # long-running loop
```

Then set `ORCHESTRATOR_WEBHOOK_URL` in Vercel to the orchestrator's inbound webhook (once it's externally addressable) so new campaigns kick off immediately instead of waiting for the poller.

---

## If a step fails

Come back to Cowork with:
- Which step failed
- The error output

I'll hand back a revised step or a one-shot fix. Don't debug solo in Claude Code if the failure isn't obvious — it'll burn more credits than pasting back here.
