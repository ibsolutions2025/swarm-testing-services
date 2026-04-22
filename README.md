# Swarm Testing Services

Stress-test your product with autonomous agent swarms. Zero bias, full coverage, human-readable results.

**Status:** MVP scaffold. First client: AgentWork Protocol (AWP).

---

## Stack

- **Frontend:** Next.js 14 (App Router) + TypeScript + Tailwind
- **Auth + Data:** Supabase (magic-link login, Postgres)
- **Hosting:** Vercel (this repo) + separate orchestrator service (TBD)

## Local dev

```bash
yarn install
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY
yarn dev
```

Open http://localhost:3000.

## Routes

- `/` — landing page
- `/login` — magic-link sign-in
- `/dashboard` — submit a new test campaign (URL + description)
- `/api/test-campaign` — POST handler for campaigns

## Supabase setup

Create a project, then run this SQL to provision the `campaigns` table:

```sql
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  url text not null,
  description text not null,
  status text not null default 'queued',
  created_at timestamptz not null default now()
);

alter table campaigns enable row level security;

create policy "users read own campaigns"
  on campaigns for select
  using (auth.uid() = user_id);

create policy "users insert own campaigns"
  on campaigns for insert
  with check (auth.uid() = user_id);
```

If the table isn't present yet, the API returns `202` with `table_missing: true` instead of crashing.

## What's next (v1)

See `../overnight-reports/awp/SWARM-TESTING-PRODUCT-SPEC.md` for the product roadmap, and `../overnight-reports/awp/SWARM-TESTING-SPLIT-PLAN.md` for what migrates from the AWP repo.

## Deploy

```bash
gh repo create ibsolutions2025/swarm-testing-services --public --source=. --push
vercel link
vercel env pull
vercel --prod
```
