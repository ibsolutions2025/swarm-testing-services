-- Phase 4 — system_heartbeats table
-- VPS components (swarm-drain, swarm-create, sts-scanner) INSERT one row per
-- run so the Operations tab can show liveness + recent counts. Read-only
-- for authenticated users scoped to project_id='awp'.

CREATE TABLE IF NOT EXISTS system_heartbeats (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      text        NOT NULL DEFAULT 'awp',
  component       text        NOT NULL,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  outcome         text,
  actions_count   int,
  note            text,
  meta            jsonb
);

CREATE INDEX IF NOT EXISTS system_heartbeats_project_component_ran_idx
  ON system_heartbeats (project_id, component, ran_at DESC);

ALTER TABLE system_heartbeats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all ON system_heartbeats;
CREATE POLICY service_role_all ON system_heartbeats
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS auth_read ON system_heartbeats;
CREATE POLICY auth_read ON system_heartbeats
  FOR SELECT TO authenticated
  USING (project_id = 'awp');
