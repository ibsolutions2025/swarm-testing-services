-- Production-readiness foundation for generic product testing.
-- Apply before deploying the matching application branch.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS docs_url text,
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'staging',
  ADD COLUMN IF NOT EXISTS authorization_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS product_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS test_plan_version integer NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE campaigns ADD CONSTRAINT campaigns_environment_check
    CHECK (environment IN ('staging', 'production'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE campaigns ADD CONSTRAINT campaigns_execution_mode_check
    CHECK (execution_mode IN ('simulated', 'browser'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS executor_mode text NOT NULL DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS attempt_no integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS confidence numeric(4,3),
  ADD COLUMN IF NOT EXISTS failure_category text,
  ADD COLUMN IF NOT EXISTS rubric_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

DO $$ BEGIN
  ALTER TABLE runs ADD CONSTRAINT runs_executor_mode_check
    CHECK (executor_mode IN ('simulated', 'browser'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE runs ADD CONSTRAINT runs_confidence_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_events_campaign_received_idx
  ON webhook_events (campaign_id, received_at DESC);

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON webhook_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_events TO service_role;

-- Enforce campaign intake quotas atomically in Postgres. The backing table is
-- never exposed to customers; authenticated callers can only consume their own
-- bucket through the narrowly scoped security-definer function.
CREATE TABLE IF NOT EXISTS campaign_quota_buckets (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, window_start)
);

ALTER TABLE campaign_quota_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campaign_quota_buckets FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_quota_buckets TO service_role;

CREATE OR REPLACE FUNCTION consume_campaign_quota(
  max_requests integer DEFAULT 3,
  window_seconds integer DEFAULT 600
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor uuid := auth.uid();
  bucket_start timestamptz;
  updated_count integer;
BEGIN
  IF actor IS NULL THEN
    RETURN false;
  END IF;
  IF max_requests < 1 OR max_requests > 20 OR window_seconds < 60 OR window_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid campaign quota bounds';
  END IF;

  bucket_start := to_timestamp(
    floor(extract(epoch FROM clock_timestamp()) / window_seconds) * window_seconds
  );

  INSERT INTO campaign_quota_buckets AS quota (user_id, window_start, request_count)
  VALUES (actor, bucket_start, 1)
  ON CONFLICT (user_id, window_start) DO UPDATE
    SET request_count = quota.request_count + 1
    WHERE quota.request_count < max_requests
  RETURNING request_count INTO updated_count;

  DELETE FROM campaign_quota_buckets
    WHERE user_id = actor
      AND window_start < clock_timestamp() - interval '7 days';

  RETURN updated_count IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION consume_campaign_quota(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION consume_campaign_quota(integer, integer) TO authenticated;

-- A user may create and read their campaigns, but only the service worker may
-- mutate lifecycle, cost, worker paths, or terminal status.
DROP POLICY IF EXISTS "campaigns_select_own" ON campaigns;
CREATE POLICY "campaigns_select_own" ON campaigns
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "campaigns_insert_own" ON campaigns;
CREATE POLICY "campaigns_insert_own" ON campaigns
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id AND authorization_confirmed_at IS NOT NULL);

DROP POLICY IF EXISTS "campaigns_update_own" ON campaigns;
REVOKE UPDATE ON campaigns FROM authenticated;

-- Child reads remain owner-scoped through the parent campaign.
DROP POLICY IF EXISTS "matrices_select_own" ON matrices;
CREATE POLICY "matrices_select_own" ON matrices
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = matrices.campaign_id
      AND c.user_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS "personas_select_own" ON personas;
CREATE POLICY "personas_select_own" ON personas
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = personas.campaign_id
      AND c.user_id = (SELECT auth.uid())
  ));

DROP POLICY IF EXISTS "runs_select_own" ON runs;
CREATE POLICY "runs_select_own" ON runs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.id = runs.campaign_id
      AND c.user_id = (SELECT auth.uid())
  ));

-- Fix the prior policy that unintentionally applied to PUBLIC.
DROP POLICY IF EXISTS "lifecycle_results_select_awp" ON lifecycle_results;
CREATE POLICY "lifecycle_results_select_awp" ON lifecycle_results
  FOR SELECT TO authenticated
  USING (project_id = 'awp');

-- tx_attempts is privileged evidence. It was previously created without RLS.
ALTER TABLE tx_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tx_attempts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tx_attempts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE tx_attempts_id_seq TO service_role;

-- Prevent customers from editing worker-owned fields on onboarding runs.
DROP POLICY IF EXISTS auth_update_own ON onboarding_runs;
REVOKE UPDATE ON onboarding_runs FROM authenticated;

-- Finalize the database half of a greenlight atomically. The external
-- filesystem cutover is deterministic and retryable; this transaction makes
-- the client_libs ledger and run status advance together or not at all.
CREATE OR REPLACE FUNCTION finalize_onboarding_greenlight(
  p_run_id text,
  p_user_id uuid,
  p_slug text,
  p_user_short text,
  p_lib_path text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  run_owner uuid;
  run_status text;
  finalized_id uuid;
BEGIN
  SELECT user_id, status
    INTO run_owner, run_status
    FROM onboarding_runs
    WHERE run_id = p_run_id
    FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'onboarding run not found'; END IF;
  IF run_owner <> p_user_id THEN RAISE EXCEPTION 'onboarding run owner mismatch'; END IF;
  IF run_status NOT IN ('complete', 'greenlit') THEN
    RAISE EXCEPTION 'onboarding run is not ready for greenlight';
  END IF;

  INSERT INTO client_libs (run_id, user_id, slug, user_short, lib_path)
  VALUES (p_run_id, p_user_id, p_slug, p_user_short, p_lib_path)
  ON CONFLICT (slug, user_short) DO UPDATE
    SET lib_path = EXCLUDED.lib_path,
        greenlit_at = now()
    WHERE client_libs.run_id = EXCLUDED.run_id
      AND client_libs.user_id = EXCLUDED.user_id
  RETURNING id INTO finalized_id;

  IF finalized_id IS NULL THEN
    RAISE EXCEPTION 'greenlight destination belongs to a different run';
  END IF;

  UPDATE onboarding_runs
    SET status = 'greenlit'
    WHERE run_id = p_run_id
      AND user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION finalize_onboarding_greenlight(text, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_onboarding_greenlight(text, uuid, text, text, text)
  TO service_role;
