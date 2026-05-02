#!/usr/bin/env node
/**
 * scripts/backfill-phase-b.mjs — re-classify existing lifecycle_results rows
 * with the Phase B verifier.
 *
 * For every row in lifecycle_results (project_id=awp), re-run verifyJob and
 * upsert the new verdict. Reports cells whose status changed.
 *
 * Expected outcome: many rows currently 'passed' will flip to 'partial' as
 * step-level verification fails for actor mismatches, missing events, etc.
 * The dashboard's 'passed' count is EXPECTED to drop. That's the goal.
 *
 * Usage: node scripts/backfill-phase-b.mjs [--dry-run] [--limit N] [--concurrency N]
 *   --dry-run        log what would change but don't write
 *   --limit N        process only first N rows (default: all)
 *   --concurrency N  per-batch parallelism (default: 5)
 */

import { Indexer } from '../framework/indexer.mjs';
import { verifyJob } from '../framework/verifier.mjs';
import { Aggregator } from '../framework/aggregator.mjs';

const ALCHEMY_RPC = process.env.ALCHEMY_RPC
  || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';
const JOBNFT_V15 = process.env.AWP_JOBNFT || '';
const REVIEWGATE_V4 = process.env.AWP_RG || '';
const DEPLOY_BLOCK = BigInt(process.env.AWP_DEPLOY_BLOCK || '0');
const STS_URL = process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
const STS_KEY = process.env.STS_SUPABASE_KEY;

if (!JOBNFT_V15 || !REVIEWGATE_V4 || DEPLOY_BLOCK === 0n) {
  console.error('Required env: AWP_JOBNFT, AWP_RG, AWP_DEPLOY_BLOCK');
  process.exit(1);
}
if (!STS_KEY) {
  console.error('Required env: STS_SUPABASE_KEY');
  process.exit(1);
}

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : def;
}
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(argVal('--limit', '0')) || 10000;
const CONCURRENCY = parseInt(argVal('--concurrency', '5'));

async function loadAllRows() {
  console.log('Loading lifecycle_results rows...');
  const rows = [];
  let offset = 0;
  const PAGE = 1000;
  while (rows.length < LIMIT) {
    const url = `${STS_URL}/rest/v1/lifecycle_results?project_id=eq.awp` +
      `&select=run_id,onchain_job_id,status,config_key,scenario_key` +
      `&order=onchain_job_id.asc&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, {
      headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` },
    });
    if (!r.ok) throw new Error(`load failed: ${r.status}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  console.log(`Loaded ${rows.length} rows`);
  return rows.slice(0, LIMIT);
}

async function fetchIntent(jobId) {
  const filter = `or=(job_id.eq.${jobId},meta->>job_id.eq.${jobId})`;
  const url = `${STS_URL}/rest/v1/orchestration_events`
    + `?project_id=eq.awp&event_type=eq.dispatch&${filter}`
    + `&select=meta,source,persona,job_id&order=ran_at.desc&limit=5`;
  try {
    const r = await fetch(url, { headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` } });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length) return null;
    const hlo = rows.find(row => row.source === 'hlo-daemon' && row.meta
      && (row.meta.intended_config || row.meta.intended_scenario));
    const pick = hlo || rows[0];
    const meta = pick.meta || {};
    return {
      intended_config: meta.intended_config || meta.target_config || null,
      intended_scenario: meta.intended_scenario || meta.target_scenario || null,
      agent: pick.persona || meta.dispatched_agent || null,
      source: pick.source || null,
    };
  } catch { return null; }
}

async function main() {
  console.log(`=== Phase B Backfill ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}  limit=${LIMIT} concurrency=${CONCURRENCY}`);

  const indexer = new Indexer({
    alchemyRpc: ALCHEMY_RPC,
    jobNFT: JOBNFT_V15,
    reviewGate: REVIEWGATE_V4,
    deployBlock: DEPLOY_BLOCK,
    stsUrl: STS_URL, stsKey: STS_KEY,
  });
  const aggregator = new Aggregator({ stsUrl: STS_URL, stsKey: STS_KEY, dryRun: DRY_RUN });

  // 1. Load all rows we'll re-verify.
  const rows = await loadAllRows();

  // 2. Prefetch all logs ONCE for the full block range.
  const latest = await indexer.getLatestBlock();
  console.log(`Prefetching logs from ${DEPLOY_BLOCK} to ${latest}...`);
  const [jobNFT, reviewGate] = await Promise.all([
    indexer.prefetchLogs(JOBNFT_V15, DEPLOY_BLOCK, latest, 'JobNFTv15'),
    indexer.prefetchLogs(REVIEWGATE_V4, DEPLOY_BLOCK, latest, 'ReviewGateV4'),
  ]);

  // 3. Load all tx_attempts for the project.
  const txAttemptsByJob = await indexer.loadTxAttempts({ projectId: 'awp' });

  // 4. Re-verify each row. Track diffs.
  const diff = {
    total: 0,
    unchanged: 0,
    status_changed: 0,
    cell_changed: 0,
    new_failures: 0,
    by_old_status: {},
    by_new_status: {},
    flipped_passed_to_partial: 0,
    flipped_passed_to_failed: 0,
  };

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async oldRow => {
      diff.total++;
      try {
        const jobId = oldRow.onchain_job_id;
        if (jobId == null) return;
        const jobView = await indexer.readJob(jobId);
        const submissions = await indexer.readAllSubmissions(jobId);
        const allLogs = [
          ...(jobNFT.byJob.get(jobId) || []),
          ...(reviewGate.byJob.get(jobId) || []),
        ];
        const txAttempts = txAttemptsByJob.get(jobId) || [];
        const intent = await fetchIntent(jobId);
        const personaMap = {};
        if (intent?.agent) personaMap.agent = intent.agent;
        const winner = submissions.find(s => s.status === 1) || submissions[0];
        if (winner?.worker) personaMap.worker = winner.worker;
        if (jobView.activeValidator) personaMap.validator = jobView.activeValidator;

        const verdict = verifyJob({
          jobId, jobView, submissions, rawLogs: allLogs, txAttempts, intent, personaMap,
        });

        // Diff
        diff.by_old_status[oldRow.status] = (diff.by_old_status[oldRow.status] || 0) + 1;
        diff.by_new_status[verdict.status] = (diff.by_new_status[verdict.status] || 0) + 1;
        const cellChanged =
          oldRow.config_key !== verdict.config_key ||
          oldRow.scenario_key !== verdict.scenario_key;
        if (cellChanged) diff.cell_changed++;
        if (oldRow.status !== verdict.status) {
          diff.status_changed++;
          if (oldRow.status === 'passed' && verdict.status === 'partial') diff.flipped_passed_to_partial++;
          if (oldRow.status === 'passed' && verdict.status === 'failed') diff.flipped_passed_to_failed++;
        } else if (!cellChanged) {
          diff.unchanged++;
        }
        if (verdict.verification_failures?.length > 0) diff.new_failures++;

        // Upsert
        const row = aggregator.buildRow(verdict, { jobView, submissions, intent });
        await aggregator.upsert(row, null);

        if (oldRow.status !== verdict.status || cellChanged) {
          console.log(
            `  [DIFF] job ${jobId}: ` +
            `${oldRow.config_key}|${oldRow.scenario_key} (${oldRow.status}) → ` +
            `${verdict.config_key}|${verdict.scenario_key} (${verdict.status})` +
            (verdict.verification_failures?.length ? ` failures=${verdict.verification_failures.length}` : '')
          );
        }
      } catch (e) {
        console.log(`  [ERR] row ${oldRow.run_id}: ${e.message?.slice(0, 200)}`);
      }
    }));
  }

  console.log('\n=== Backfill Diff Summary ===');
  console.log(`Total: ${diff.total}`);
  console.log(`Unchanged: ${diff.unchanged}`);
  console.log(`Status changed: ${diff.status_changed}`);
  console.log(`Cell changed: ${diff.cell_changed}`);
  console.log(`Flipped passed → partial: ${diff.flipped_passed_to_partial}`);
  console.log(`Flipped passed → failed: ${diff.flipped_passed_to_failed}`);
  console.log(`Rows with new verification_failures: ${diff.new_failures}`);
  console.log(`Old status distribution: ${JSON.stringify(diff.by_old_status)}`);
  console.log(`New status distribution: ${JSON.stringify(diff.by_new_status)}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
