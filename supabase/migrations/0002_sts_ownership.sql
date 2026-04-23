-- STS Architectural Pivot — lifecycle_results table
-- STS owns its own scanner writing on-chain test events. AWP is client #1 (project_id='awp').
-- Run once per Supabase project. Idempotent.

-- ============================================================
-- lifecycle_results
-- ============================================================
create table if not exists lifecycle_results (
  id               uuid        primary key default gen_random_uuid(),
  project_id       text        not null default 'awp',
  run_id           text        not null,
  config_key       text        not null,
  scenario_key     text        not null,
  status           text        not null check (status in ('passed','failed','partial','skipped','error','running')),
  steps            jsonb       not null default '[]'::jsonb,
  wallets          jsonb,
  agent_wallets    jsonb,
  job_id           text,
  onchain_job_id   bigint,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  duration_ms      integer,
  error_message    text,
  current_step     text,
  step_audits      jsonb,
  cell_audit       jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Indexes
create index if not exists lifecycle_results_project_config_scenario_idx
  on lifecycle_results(project_id, config_key, scenario_key);

create index if not exists lifecycle_results_project_started_idx
  on lifecycle_results(project_id, started_at desc);

create index if not exists lifecycle_results_project_status_idx
  on lifecycle_results(project_id, status);

-- Unique constraint: one canonical row per (project, run)
create unique index if not exists lifecycle_results_project_run_id_unique
  on lifecycle_results(project_id, run_id);

-- ============================================================
-- Row-level security
-- ============================================================
alter table lifecycle_results enable row level security;

-- service_role bypasses RLS by default in Supabase — no explicit policy needed.
-- Authenticated users can SELECT rows for project 'awp'.
drop policy if exists "lifecycle_results_select_awp" on lifecycle_results;
create policy "lifecycle_results_select_awp" on lifecycle_results
  for select
  using (project_id = 'awp');

-- ============================================================
-- updated_at trigger (reuse set_updated_at from 0001_init.sql)
-- ============================================================
drop trigger if exists lifecycle_results_set_updated_at on lifecycle_results;
create trigger lifecycle_results_set_updated_at
  before update on lifecycle_results
  for each row execute function set_updated_at();
