-- Swarm Testing Services — initial schema
-- Run once per Supabase project. Idempotent.

create extension if not exists pgcrypto;

-- ============================================================
-- campaigns
-- ============================================================
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  description text not null,
  status text not null default 'queued'
    check (status in ('queued','designing','generating_personas','running','completed','failed','cancelled')),
  matrix_id uuid,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_user_id_idx on campaigns(user_id);
create index if not exists campaigns_status_idx on campaigns(status);
create index if not exists campaigns_created_at_idx on campaigns(created_at desc);

-- ============================================================
-- matrices (one per campaign, JSONB rows/columns)
-- ============================================================
create table if not exists matrices (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  rows jsonb not null default '[]'::jsonb,
  columns jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists matrices_campaign_id_idx on matrices(campaign_id);

-- ============================================================
-- personas (one per matrix row)
-- ============================================================
create table if not exists personas (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  matrix_row_id text not null,
  name text not null,
  archetype text not null,
  goals jsonb not null default '[]'::jsonb,
  biases jsonb not null default '[]'::jsonb,
  soul_md text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists personas_campaign_id_idx on personas(campaign_id);

-- ============================================================
-- runs (one per matrix cell = row × column)
-- ============================================================
create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  matrix_row_id text not null,
  matrix_column_id text not null,
  persona_id uuid references personas(id) on delete set null,
  outcome text not null default 'skipped'
    check (outcome in ('pass','fail','partial','skipped','error')),
  transcript jsonb not null default '[]'::jsonb,
  quote text,
  duration_ms int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists runs_campaign_id_idx on runs(campaign_id);
create index if not exists runs_outcome_idx on runs(outcome);
create unique index if not exists runs_cell_unique on runs(campaign_id, matrix_row_id, matrix_column_id);

-- ============================================================
-- Row-level security
-- ============================================================
alter table campaigns enable row level security;
alter table matrices  enable row level security;
alter table personas  enable row level security;
alter table runs      enable row level security;

-- campaigns: user sees and writes their own
drop policy if exists "campaigns_select_own" on campaigns;
create policy "campaigns_select_own" on campaigns
  for select using (auth.uid() = user_id);

drop policy if exists "campaigns_insert_own" on campaigns;
create policy "campaigns_insert_own" on campaigns
  for insert with check (auth.uid() = user_id);

drop policy if exists "campaigns_update_own" on campaigns;
create policy "campaigns_update_own" on campaigns
  for update using (auth.uid() = user_id);

-- matrices/personas/runs: read if the parent campaign belongs to user
-- (writes happen via service-role only, from orchestrator)
drop policy if exists "matrices_select_own" on matrices;
create policy "matrices_select_own" on matrices
  for select using (
    exists (select 1 from campaigns c where c.id = matrices.campaign_id and c.user_id = auth.uid())
  );

drop policy if exists "personas_select_own" on personas;
create policy "personas_select_own" on personas
  for select using (
    exists (select 1 from campaigns c where c.id = personas.campaign_id and c.user_id = auth.uid())
  );

drop policy if exists "runs_select_own" on runs;
create policy "runs_select_own" on runs
  for select using (
    exists (select 1 from campaigns c where c.id = runs.campaign_id and c.user_id = auth.uid())
  );

-- ============================================================
-- updated_at triggers
-- ============================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end
$$ language plpgsql;

drop trigger if exists campaigns_set_updated_at on campaigns;
create trigger campaigns_set_updated_at
  before update on campaigns
  for each row execute function set_updated_at();
