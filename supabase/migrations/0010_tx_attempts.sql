-- Phase B — tx_attempts table.
--
-- Required for negative-scenario verification (s13 rating-gate-fail,
-- s14 rating-gate-new-user, s15 approved-not-approved). HLO writes a row
-- per dispatched transaction; the indexer fills outcome + revert_reason
-- from the receipt; the verifier reads from this table for revert-step
-- predicates.
--
-- See clients/.shared/PHASE-B-VERIFIER-SPEC.md.

CREATE TABLE IF NOT EXISTS tx_attempts (
  id              bigserial PRIMARY KEY,
  project_id      text NOT NULL,
  tx_hash         text NOT NULL,
  block_number    bigint,
  intended_action text,         -- 'createJob' | 'submitWork' | 'claimJobAsValidator' | 'approveSubmission' | 'rejectAllSubmissions' | etc.
  intended_job_id bigint,
  actor           text NOT NULL,
  outcome         text NOT NULL,  -- 'success' | 'reverted' | 'pending' | 'timeout'
  revert_reason   text,           -- decoded custom-error name when reverted
  raw_revert_data text,
  meta            jsonb,
  ran_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS tx_attempts_project_job_idx
  ON tx_attempts (project_id, intended_job_id);

CREATE INDEX IF NOT EXISTS tx_attempts_project_action_idx
  ON tx_attempts (project_id, intended_action);

COMMENT ON TABLE tx_attempts IS
  'Phase B — every transaction the swarm dispatches, success OR revert. HLO writes (intended_action, actor, tx_hash); indexer fills outcome + revert_reason. Verifier reads here for negative scenarios.';

COMMENT ON COLUMN tx_attempts.intended_action IS
  'createJob | submitWork | claimJobAsValidator | approveSubmission | rejectSubmission | rejectAllSubmissions | cancelJob | submitReview | rotateValidator | finalizeTimedJob';

COMMENT ON COLUMN tx_attempts.outcome IS
  'success = receipt.status==success; reverted = receipt.status==reverted; pending = no receipt yet; timeout = receipt poll exhausted';

COMMENT ON COLUMN tx_attempts.revert_reason IS
  'When outcome=reverted: decoded custom-error name (e.g. RatingGateFailed, NotApprovedWorker). NULL when outcome=success.';
