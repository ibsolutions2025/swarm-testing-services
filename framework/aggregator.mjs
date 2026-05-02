// framework/aggregator.mjs — Phase B aggregator.
//
// Converts per-job verdicts into lifecycle_results rows. The aggregator is
// thin: writes a SINGLE row per job (keyed by run_id = scan-v15-<jobId>),
// using verifier-output fields. Cell-level aggregation happens in the API
// layer at read time (the dashboard groups rows by config_key + scenario_key).
//
// This module exists as a separate file so the scanner stays a thin
// orchestrator and so backfill scripts can reuse the same upsert path.

const STS_REST_PATH = '/rest/v1/lifecycle_results';

export class Aggregator {
  constructor({ stsUrl, stsKey, dryRun = false }) {
    this.stsUrl = stsUrl;
    this.stsKey = stsKey;
    this.dryRun = dryRun;
  }

  // Build the lifecycle_results row from a verifier verdict.
  buildRow(verdict, { jobView, submissions = [], intent = null, partialIndex = false } = {}) {
    const ZERO = '0x0000000000000000000000000000000000000000';
    const completedAt = (verdict.status === 'passed' || verdict.status === 'partial')
      ? new Date().toISOString() : null;

    return {
      project_id: 'awp',
      run_id: `scan-v15-${verdict.onchain_job_id}`,
      onchain_job_id: verdict.onchain_job_id,

      // Canonical = OBSERVED (Phase B change vs Phase A's intent-driven canonical)
      config_key: verdict.config_key,
      scenario_key: verdict.scenario_key,

      // Audit columns (kept from Phase A schema)
      observed_config_key: verdict.observed_config_key,
      observed_scenario_key: verdict.observed_scenario_key,
      intent_matched: verdict.intent_matched,
      expected_reviews: verdict.expected_reviews,
      observed_reviews: verdict.observed_reviews,

      // Phase B columns (migration 0009)
      config_validated: verdict.config_validated,
      verification_failures: verdict.verification_failures || [],
      intended_config: verdict.intended_config,
      intended_scenario: verdict.intended_scenario,

      // Status + steps
      status: verdict.status,
      steps: this.stepsForRow(verdict),

      // Wallets snapshot
      agent_wallets: {
        poster: jobView?.poster || null,
        worker: submissions[0]?.worker || null,
        validator: jobView?.activeValidator && jobView.activeValidator.toLowerCase() !== ZERO
          ? jobView.activeValidator : null,
      },

      // Cell audit (free-form telemetry)
      cell_audit: {
        scanner_instance: partialIndex ? 'scanner-v15-phaseB-partial' : 'scanner-v15-phaseB',
        intent_source: intent?.source || null,
        intent_agent: intent?.agent || null,
        distinct_validators: verdict.distinct_validators ?? null,
        decoded_event_count: verdict.decoded_event_count ?? null,
      },

      started_at: new Date().toISOString(),
      completed_at: completedAt,
    };
  }

  // Per-step rows for the lifecycle_results.steps JSONB column.
  // The dashboard renders these in the modal.
  stepsForRow(verdict) {
    return (verdict.steps || []).map(s => ({
      step: s.step_index,
      name: stepNameFor(s),
      status: s.status,
      reason: s.reason || null,
      expected: s.expected || null,
      observed: s.observed || null,
      details: {
        txHash: s.tx_hash || null,
        blockNumber: s.block || null,
      },
    }));
  }

  async upsert(row, stats) {
    if (this.dryRun || !this.stsKey) {
      console.log(`  [DRY] ${row.run_id} status=${row.status} cell=${row.config_key}|${row.scenario_key} failures=${(row.verification_failures||[]).length}`);
      return;
    }
    const result = await this._postUpsert(row);
    if (result.ok) return;
    // Phase B columns may not exist yet (migration 0009 not applied). PostgREST
    // returns PGRST204/PGRST202/42703 with the column name; strip those
    // columns and retry once. Logged at WARN level so the operator notices.
    if (result.body && /Could not find the .* column|column .* does not exist|relation .* does not exist/i.test(result.body)) {
      const stripped = this._stripPhaseBColumns(row);
      const result2 = await this._postUpsert(stripped);
      if (result2.ok) {
        if (stats) stats.errors++; // count once so the op knows migrations are pending
        if (!this._warnedMissingCols) {
          console.log(`  [WARN] Phase B columns missing in lifecycle_results / tx_attempts — apply migrations 0009+0010. Retried without them.`);
          this._warnedMissingCols = true;
        }
        return;
      }
    }
    console.log(`  [ERR lifecycle upsert] status=${result.status} body=${(result.body || '').slice(0, 240)}`);
    if (stats) stats.errors++;
  }

  async _postUpsert(row) {
    try {
      const r = await fetch(`${this.stsUrl}${STS_REST_PATH}?on_conflict=project_id,run_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.stsKey,
          Authorization: `Bearer ${this.stsKey}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(row),
      });
      if (r.ok) return { ok: true };
      const txt = await r.text().catch(() => '');
      return { ok: false, status: r.status, body: txt };
    } catch (e) {
      return { ok: false, status: 0, body: e.message || 'network error' };
    }
  }

  _stripPhaseBColumns(row) {
    const stripped = { ...row };
    delete stripped.config_validated;
    delete stripped.verification_failures;
    delete stripped.intended_config;
    delete stripped.intended_scenario;
    return stripped;
  }
}

function stepNameFor(stepResult) {
  // The verifier returns the step_index but doesn't echo the step name. Use a
  // generic placeholder; the modal can cross-reference generateLifecycle by
  // index to render the name.
  return `step-${stepResult.step_index}`;
}
