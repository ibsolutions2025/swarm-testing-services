-- Phase 6 — orchestration_events table
-- VPS scripts (swarm-drain, swarm-create) emit one row per scan / decision /
-- dispatch / skip / error so the Operations tab can show the full operating
-- brain (not just on-chain outcomes). Read-only for authenticated users
-- scoped to project_id='awp'; service_role writes.

CREATE TABLE IF NOT EXISTS orchestration_events (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text        NOT NULL DEFAULT 'awp',
  ran_at     timestamptz NOT NULL DEFAULT now(),
  cycle_id   text        NOT NULL,   -- groups events within one cron run
  source     text        NOT NULL,   -- 'swarm-drain' | 'swarm-create' | 'sts-scanner'
  event_type text        NOT NULL,   -- 'scan' | 'decision' | 'dispatch' | 'skip' | 'error'
  persona    text,                    -- dispatched agent name (Spark, Judge, etc.) when applicable
  job_id     int,                     -- on-chain JobNFT token id when applicable
  directive  text,                    -- plain-English instruction given to the agent (dispatch only)
  reasoning  text,                    -- one-line rationale the script logs
  tx_hash    text,                    -- on-chain tx that resulted, when known
  meta       jsonb
);

CREATE INDEX IF NOT EXISTS orchestration_events_project_ran_idx
  ON orchestration_events (project_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS orchestration_events_cycle_idx
  ON orchestration_events (project_id, cycle_id);
CREATE INDEX IF NOT EXISTS orchestration_events_job_idx
  ON orchestration_events (project_id, job_id);

ALTER TABLE orchestration_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON orchestration_events;
CREATE POLICY service_role_all ON orchestration_events
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS auth_read ON orchestration_events;
CREATE POLICY auth_read ON orchestration_events
  FOR SELECT TO authenticated
  USING (project_id = 'awp');
