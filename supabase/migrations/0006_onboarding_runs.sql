-- Phase C.2 — onboarding runs schema
-- Backs the Hire-the-Swarm UI: customer submits a URL, engine runs on the
-- VPS, dashboard polls these tables for live progress + final results.
-- Customer reviews + edits via HITL, then greenlights to copy the engine
-- output into a canonical lib/<slug>-<user_short>/ directory.
--
-- See clients/.shared/PHASE-C-DESIGN.md section C.2 for the design rationale.

-- ============================================================
-- onboarding_runs — one row per submission
-- ============================================================
CREATE TABLE IF NOT EXISTS onboarding_runs (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          text          NOT NULL UNIQUE,                -- engine's runId, e.g. "phaseC-smoke"
  user_id         uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  url             text          NOT NULL,
  status          text          NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','complete','failed','greenlit','cancelled')),
  current_step    text,                                          -- "07-generate-rules", etc.
  slug            text,                                          -- discovered slug, set after step 02
  total_cost_usd  numeric(10,4) DEFAULT 0,
  total_tokens_in  int          DEFAULT 0,
  total_tokens_out int          DEFAULT 0,
  error           text,
  vps_run_dir     text,                                          -- absolute path on VPS
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onboarding_runs_user_created_idx
  ON onboarding_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS onboarding_runs_status_idx
  ON onboarding_runs (status);

-- ============================================================
-- onboarding_step_events — one row per step transition per run
-- Drives the 12-step live stepper on /hire/runs/[runId].
-- ============================================================
CREATE TABLE IF NOT EXISTS onboarding_step_events (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       text          NOT NULL REFERENCES onboarding_runs(run_id) ON DELETE CASCADE,
  step_id      text          NOT NULL,                          -- "07-generate-rules"
  status       text          NOT NULL CHECK (status IN ('running','ok','fail')),
  elapsed_ms   int,
  summary      text,                                            -- one-line per-step output
  output_json  jsonb,                                           -- full step.output
  cost_usd     numeric(10,4),
  emitted_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onboarding_step_events_run_emitted_idx
  ON onboarding_step_events (run_id, emitted_at);

-- ============================================================
-- onboarding_edits — customer HITL edits stored as patches
-- The engine output is never modified directly; greenlight (C.7) applies
-- patches in order to produce the final files.
-- ============================================================
CREATE TABLE IF NOT EXISTS onboarding_edits (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      text          NOT NULL REFERENCES onboarding_runs(run_id) ON DELETE CASCADE,
  user_id     uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target      text          NOT NULL CHECK (target IN ('matrix','scenarios','rules-backlog')),
  patch_json  jsonb         NOT NULL,                            -- shape per target
  note        text,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onboarding_edits_run_created_idx
  ON onboarding_edits (run_id, created_at);

-- ============================================================
-- client_libs — engine -> swarm cutover. One row per greenlit run.
-- (slug, user_short) is unique so two greenlights for the same protocol
-- by the same user collide rather than silently double-write.
-- ============================================================
CREATE TABLE IF NOT EXISTS client_libs (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          text          NOT NULL REFERENCES onboarding_runs(run_id),
  user_id         uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug            text          NOT NULL,                       -- e.g. "agentwork-protocol"
  user_short      text          NOT NULL,                       -- first 6 of user_id
  lib_path        text          NOT NULL,                       -- "lib/agentwork-protocol-a3f2e1/"
  blob_url        text,                                          -- Vercel Blob signed URL for download
  greenlit_at     timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (slug, user_short)
);

CREATE INDEX IF NOT EXISTS client_libs_user_idx
  ON client_libs (user_id, greenlit_at DESC);

-- ============================================================
-- RLS — every customer sees only their own rows; service role bypasses.
-- The engine writer (VPS process) uses the service-role key.
-- ============================================================

ALTER TABLE onboarding_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_step_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_edits       ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_libs            ENABLE ROW LEVEL SECURITY;

-- onboarding_runs
DROP POLICY IF EXISTS service_role_all ON onboarding_runs;
CREATE POLICY service_role_all ON onboarding_runs
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS auth_select_own ON onboarding_runs;
CREATE POLICY auth_select_own ON onboarding_runs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS auth_insert_own ON onboarding_runs;
CREATE POLICY auth_insert_own ON onboarding_runs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS auth_update_own ON onboarding_runs;
CREATE POLICY auth_update_own ON onboarding_runs
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- onboarding_step_events (read-only for customers; service role writes)
DROP POLICY IF EXISTS service_role_all ON onboarding_step_events;
CREATE POLICY service_role_all ON onboarding_step_events
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS auth_select_own ON onboarding_step_events;
CREATE POLICY auth_select_own ON onboarding_step_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM onboarding_runs r
      WHERE r.run_id = onboarding_step_events.run_id
        AND r.user_id = auth.uid()
    )
  );

-- onboarding_edits
DROP POLICY IF EXISTS service_role_all ON onboarding_edits;
CREATE POLICY service_role_all ON onboarding_edits
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS auth_select_own ON onboarding_edits;
CREATE POLICY auth_select_own ON onboarding_edits
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS auth_insert_own ON onboarding_edits;
CREATE POLICY auth_insert_own ON onboarding_edits
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- client_libs (read-only for customers; service role writes from greenlight handler)
DROP POLICY IF EXISTS service_role_all ON client_libs;
CREATE POLICY service_role_all ON client_libs
  FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS auth_select_own ON client_libs;
CREATE POLICY auth_select_own ON client_libs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- Auto-bump updated_at on UPDATE for onboarding_runs
-- ============================================================
CREATE OR REPLACE FUNCTION onboarding_runs_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS onboarding_runs_updated_at_trg ON onboarding_runs;
CREATE TRIGGER onboarding_runs_updated_at_trg
  BEFORE UPDATE ON onboarding_runs
  FOR EACH ROW EXECUTE FUNCTION onboarding_runs_touch_updated_at();
