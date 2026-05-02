#!/usr/bin/env node
/**
 * framework/scanner.mjs — STS Phase B scanner (thin orchestrator).
 *
 * Replaces the Phase A monolith with a three-module pipeline:
 *   indexer  → on-chain logs + receipts + tx_attempts
 *   verifier → per-job verdicts (per-step pass/fail with on-chain proof)
 *   aggregator → upserts to lifecycle_results
 *
 * Phase B changes vs Phase A:
 *   - Canonical scenario_key/config_key reflect OBSERVED state at terminal
 *     (not HLO's intent). HLO intent is preserved in intended_config /
 *     intended_scenario / intent_matched as diagnostic columns only.
 *   - status='passed' requires ALL lifecycle steps to verify with on-chain
 *     proof — actor matches, ordering correct, expected events present, no
 *     forbidden events. Phase A's two-check model (job.status==2 +
 *     observedReviews>=expectedReviews) is replaced.
 *   - Negative scenarios (s13, s15) verified via tx_attempts.outcome='reverted'
 *     with the right custom error name.
 *   - Predicate set tightened to be disjoint+exhaustive. classifyAllMatches
 *     surfaces non-disjoint matches as a verification_failure.
 *
 * The legacy Phase A scanner is preserved at framework/scanner.legacy.mjs.
 *
 * Usage:  node framework/scanner.mjs [--dry-run] [--since <jobId>]
 *                                     [--batch <N>] [--limit <N>]
 */
import { Indexer } from './indexer.mjs';
import { verifyJob } from './verifier.mjs';
import { Aggregator } from './aggregator.mjs';

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────
const ALCHEMY_RPC = process.env.ALCHEMY_RPC
  || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';

const JOBNFT_V15 = process.env.AWP_JOBNFT   || '';
const REVIEWGATE_V4 = process.env.AWP_RG    || '';
const DEPLOY_BLOCK = BigInt(process.env.AWP_DEPLOY_BLOCK || '0');
if (!JOBNFT_V15 || !REVIEWGATE_V4 || DEPLOY_BLOCK === 0n) {
  console.error('Required env: AWP_JOBNFT, AWP_RG, AWP_DEPLOY_BLOCK');
  process.exit(1);
}

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : def;
}
const BATCH_SIZE = parseInt(argVal('--batch', '5'));
const LIMIT      = parseInt(argVal('--limit', '0')) || null;
const SINCE_JOB  = parseInt(argVal('--since', '1'));
const DRY_RUN    = process.argv.includes('--dry-run');

const STS_URL = process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
const STS_KEY = process.env.STS_SUPABASE_KEY;

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
async function fetchIntentFromOrchEvents(jobId) {
  if (!STS_KEY || jobId == null) return null;
  const headers = { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` };
  const filter = `or=(job_id.eq.${jobId},meta->>job_id.eq.${jobId})`;
  const url = `${STS_URL}/rest/v1/orchestration_events`
    + `?project_id=eq.awp&event_type=eq.dispatch&${filter}`
    + `&select=meta,ran_at,source,persona,job_id&order=ran_at.desc&limit=5`;
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const hlo = rows.find(row => row.source === 'hlo-daemon' && row.meta
      && (row.meta.intended_config || row.meta.intended_scenario));
    const pick = hlo || rows[0];
    const meta = pick.meta || {};
    const intendedConfig = meta.intended_config || meta.target_config || null;
    const intendedScenario = meta.intended_scenario || meta.target_scenario || null;
    if (!intendedConfig && !intendedScenario) return null;
    return {
      intended_config: intendedConfig,
      intended_scenario: intendedScenario,
      dispatch_block: meta.block_number ?? meta.block ?? null,
      agent: pick.persona || meta.dispatched_agent || null,
      source: pick.source || null,
    };
  } catch {
    return null;
  }
}

async function emitHeartbeat(actions_count, note, extraMeta = {}) {
  if (DRY_RUN || !STS_KEY) return;
  try {
    await fetch(`${STS_URL}/rest/v1/system_heartbeats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        project_id: 'awp', component: 'sts-scanner-v15-phaseB',
        outcome: actions_count > 0 ? 'ok' : 'idle',
        actions_count, note, meta: extraMeta,
      }),
    });
  } catch { /* fire-and-forget */ }
}

// ─────────────────────────────────────────────────────────────────
// Main orchestration
// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== STS Scanner V15 (Phase B — verifier + aggregator) ===');
  console.log(`JobNFT V15:     ${JOBNFT_V15}`);
  console.log(`ReviewGate V4:  ${REVIEWGATE_V4}`);
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  const t0 = Date.now();

  const indexer = new Indexer({
    alchemyRpc: ALCHEMY_RPC,
    jobNFT: JOBNFT_V15,
    reviewGate: REVIEWGATE_V4,
    deployBlock: DEPLOY_BLOCK,
    stsUrl: STS_URL, stsKey: STS_KEY,
  });
  const aggregator = new Aggregator({ stsUrl: STS_URL, stsKey: STS_KEY, dryRun: DRY_RUN });

  // 1. Pull on-chain state
  const latest = await indexer.getLatestBlock();
  console.log(`Latest block:   ${latest} (from ${DEPLOY_BLOCK})`);

  const [jobNFT, reviewGate] = await Promise.all([
    indexer.prefetchLogs(JOBNFT_V15, DEPLOY_BLOCK, latest, 'JobNFTv15'),
    indexer.prefetchLogs(REVIEWGATE_V4, DEPLOY_BLOCK, latest, 'ReviewGateV4'),
  ]);

  const anyFailures = jobNFT.failedRanges.length > 0 || reviewGate.failedRanges.length > 0;
  if (anyFailures) {
    console.log(`  ⚠ Prefetch had chunk failures — affected jobs will be marked running with empty steps (NO partial verification).`);
  }

  const jobCount = await indexer.getJobCount();
  console.log(`jobCount:       ${jobCount}`);

  const endJob = LIMIT ? Math.min(SINCE_JOB + LIMIT - 1, jobCount) : jobCount;
  console.log(`Scanning jobs ${SINCE_JOB}..${endJob}`);

  // 2. Fill any pending tx_attempts receipts (best effort, runs once per tick)
  try {
    const filled = await indexer.fillPendingReceipts({ projectId: 'awp' });
    if (filled.updated > 0) console.log(`  [tx_attempts] filled ${filled.updated} pending receipts`);
  } catch (e) {
    console.log(`  [WARN] fillPendingReceipts: ${e.message?.slice(0, 200)}`);
  }

  // 3. Load tx_attempts grouped by jobId.
  const txAttemptsByJob = await indexer.loadTxAttempts({ projectId: 'awp' });
  console.log(`  [tx_attempts] loaded for ${txAttemptsByJob.size} jobs`);

  // 4. Per-job verify + upsert (in batches for parallelism).
  const stats = {
    scanned: 0, passed: 0, partial: 0, failed: 0, running: 0,
    config_mismatch: 0, errors: 0, intent_mismatch: 0, unclassified: 0,
    disjointness_violations: 0,
  };

  for (let batchStart = SINCE_JOB; batchStart <= endJob; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endJob);
    await Promise.all(
      Array.from({ length: batchEnd - batchStart + 1 }, (_, k) =>
        processJob({
          jobId: batchStart + k,
          jobNFTCache: jobNFT.byJob,
          reviewGateCache: reviewGate.byJob,
          txAttemptsByJob,
          cacheBroken: anyFailures,
          indexer,
          aggregator,
          stats,
        })
      )
    );
  }

  const duration = Date.now() - t0;
  console.log(
    `\nDONE — scanned=${stats.scanned} passed=${stats.passed} partial=${stats.partial} ` +
    `failed=${stats.failed} running=${stats.running} unclassified=${stats.unclassified} ` +
    `intent_mismatch=${stats.intent_mismatch} config_mismatch=${stats.config_mismatch} ` +
    `disjointness=${stats.disjointness_violations} errors=${stats.errors} (${(duration/1000).toFixed(1)}s)`
  );
  await emitHeartbeat(stats.scanned, `scanned ${stats.scanned} jobs (Phase B verifier)`,
    { ...stats, duration_ms: duration });
}

async function processJob({ jobId, jobNFTCache, reviewGateCache, txAttemptsByJob, cacheBroken, indexer, aggregator, stats }) {
  stats.scanned++;
  try {
    const jobView = await indexer.readJob(jobId);

    // If the prefetch failed for this job's range, write a conservative
    // running row with empty steps and skip verification.
    if (cacheBroken) {
      const row = {
        project_id: 'awp',
        run_id: `scan-v15-${jobId}-${Date.now()}`,
        onchain_job_id: jobId,
        config_key: 'soft-open-single-open-open',
        scenario_key: 's00-in-flight',
        status: 'running',
        steps: [],
        verification_failures: [],
        config_validated: null,
        started_at: new Date().toISOString(),
        cell_audit: { scanner_instance: 'scanner-v15-phaseB-partial' },
      };
      await aggregator.upsert(row, stats);
      stats.running++;
      return;
    }

    const jobLogs = jobNFTCache.get(jobId) || [];
    const rgLogs  = reviewGateCache.get(jobId) || [];
    const allLogs = [...jobLogs, ...rgLogs];

    const submissions = await indexer.readAllSubmissions(jobId);
    const txAttempts = txAttemptsByJob.get(jobId) || [];
    const intent = await fetchIntentFromOrchEvents(jobId);

    // Build a personaMap from intent metadata when available.
    const personaMap = {};
    if (intent?.agent) personaMap.agent = intent.agent;
    // Worker = the wallet on the first non-rejected submission, when present.
    const winner = submissions.find(s => s.status === 1) || submissions[0];
    if (winner?.worker) personaMap.worker = winner.worker;
    // Validator = activeValidator
    if (jobView.activeValidator) personaMap.validator = jobView.activeValidator;

    const verdict = verifyJob({
      jobId,
      jobView,
      submissions,
      rawLogs: allLogs,
      txAttempts,
      intent,
      personaMap,
    });

    // Update running stats from the verdict
    if (verdict.status === 'passed') stats.passed++;
    else if (verdict.status === 'partial') stats.partial++;
    else if (verdict.status === 'failed') stats.failed++;
    else if (verdict.status === 'running') stats.running++;
    if (verdict.status === 'config_mismatch') stats.config_mismatch++;
    if (verdict.intent_matched === false) stats.intent_mismatch++;
    if (verdict.scenario_key === 'unclassified') stats.unclassified++;
    if (verdict.verification_failures?.some(f => f.reason === 'predicate_set_not_disjoint')) {
      stats.disjointness_violations++;
    }

    const row = aggregator.buildRow(verdict, { jobView, submissions, intent });
    await aggregator.upsert(row, stats);

    // Concise log per job (truncated to keep noise low at scale)
    const summary = `${verdict.config_key}|${verdict.scenario_key}`;
    if (verdict.status === 'passed') {
      console.log(`  [PASS] job ${jobId} -> ${summary} (steps=${verdict.steps.length}, all-pass)`);
    } else if (verdict.status === 'partial') {
      const reasons = verdict.verification_failures.slice(0, 3).map(f => `${f.step}:${f.reason}`).join(',');
      console.log(`  [PARTIAL] job ${jobId} -> ${summary} (failures=${verdict.verification_failures.length} ${reasons})`);
    } else if (verdict.status === 'failed') {
      console.log(`  [FAILED] job ${jobId} -> ${summary} (status=${jobView.status})`);
    } else if (verdict.status === 'running') {
      // skip noisy log line
    } else {
      console.log(`  [${verdict.status.toUpperCase()}] job ${jobId} -> ${summary}`);
    }
  } catch (e) {
    stats.errors++;
    console.log(`  [ERR] job ${jobId}: ${e.message?.slice(0, 200)}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
