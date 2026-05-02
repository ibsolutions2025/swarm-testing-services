-- Phase B — Per-Cell Verifier columns on lifecycle_results.
--
-- Phase A's status was "passed" iff job.status==2 && observedReviews>=expectedReviews —
-- two weak checks. Phase B adds a per-step verification model: each row carries a
-- list of step-level verification failures (empty when status='passed'), an explicit
-- config_validated flag, and HLO's recorded intent (diagnostic-only; canonical
-- config_key/scenario_key now reflect OBSERVED state at terminal).
--
-- See clients/.shared/PHASE-B-VERIFIER-SPEC.md for the design.

ALTER TABLE lifecycle_results
  ADD COLUMN IF NOT EXISTS config_validated boolean,
  ADD COLUMN IF NOT EXISTS verification_failures jsonb,
  ADD COLUMN IF NOT EXISTS intended_config text,
  ADD COLUMN IF NOT EXISTS intended_scenario text;

COMMENT ON COLUMN lifecycle_results.config_validated IS
  'On-chain getJobV15(id) config bytewise matches the cell.config_key. Required for status=passed.';

COMMENT ON COLUMN lifecycle_results.verification_failures IS
  'Array of step-level failures: [{ step, reason, expected, observed }, ...]. Empty when status=passed.';

COMMENT ON COLUMN lifecycle_results.intended_config IS
  'HLO''s recorded intent at dispatch time. Diagnostic-only; coverage uses canonical config_key.';

COMMENT ON COLUMN lifecycle_results.intended_scenario IS
  'HLO''s recorded intent at dispatch time. Diagnostic-only; coverage uses canonical scenario_key.';
