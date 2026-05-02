#!/usr/bin/env node
/**
 * framework/scanner.mjs — STS Phase A scanner.
 *
 * Replaces the inline EVENT_SIGS / PREDICATES / parseConfigKey definitions
 * with imports from the shared knowledge module at lib/awp/*. Phase A v2:
 *   - imports replace inline data
 *   - INTENT-DRIVEN classification (Fix 1): canonical scenario_key/config_key
 *     come from HLO's recorded intent in orchestration_events.meta. Predicate
 *     classification is preserved as observed_scenario_key/observed_config_key
 *     for audit. intent_matched flags mismatches (HLO dispatched s07, contract
 *     produced something else).
 *   - REVIEW-COUNT INVARIANT (Fix 2): completed-on-chain jobs with fewer than
 *     the per-validationMode required ReviewSubmitted events are flagged
 *     'partial' instead of inflating 'passed'. expected_reviews / observed_reviews
 *     persisted on every row.
 *
 * Source-of-truth: lib/awp/*.ts (compiled to lib/awp/*.js via
 * `npm run build:lib`). On VPS deploy, scp the framework/ dir AND the
 * compiled lib/ tree side-by-side under /root/test-swarm/.
 *
 * Per PHASE-8-EXECUTION-PLAN Step 8 + SWARM-V2-DESIGN.md section 2:
 *   - Steps[] is built DIRECTLY from observed events (one step per event,
 *     in block order). No "if txHashes.X then push step X" inference chain.
 *   - Classification runs lib/awp/cell-defs.js predicates against
 *     (authoritative job state + event log). First matching predicate wins.
 *   - Partial caches do NOT get written. If any block chunk failed its 3
 *     retries, jobs whose block range overlaps the failed chunk are marked
 *     status='running' with empty steps[] — no bad data overwrites a real
 *     row.
 *
 * Usage:  node framework/scanner.mjs [--dry-run] [--since <jobId>]
 *                                     [--batch <N>] [--limit <N>]
 */
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, http, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';

import { EVENT_SIGS, SIG_TO_NAME } from '../lib/awp/events.js';
import { PREDICATES, PRIORITY, classify, computeCounts, ZERO_ADDRESS } from '../lib/awp/cell-defs.js';
import { parseConfigKey, jobStateToConfigKey } from '../lib/awp/matrix.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────
const ALCHEMY_RPC = process.env.ALCHEMY_RPC
  || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';

const JOBNFT_V15 = process.env.AWP_JOBNFT   || '';   // REQUIRED
const REVIEWGATE_V4 = process.env.AWP_RG    || '';   // REQUIRED
const DEPLOY_BLOCK = BigInt(process.env.AWP_DEPLOY_BLOCK || '0'); // REQUIRED
if (!JOBNFT_V15 || !REVIEWGATE_V4 || DEPLOY_BLOCK === 0n) {
  console.error('Required env: AWP_JOBNFT, AWP_RG, AWP_DEPLOY_BLOCK');
  process.exit(1);
}

const PREFETCH_CHUNK = 10000n;
// argv helper — see prior commit for backstory; flagless invocations need
// `indexOf >= 0` guard so cron's no-arg run doesn't fall into argv[0]==node.
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

const pub = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_RPC) });

// ─────────────────────────────────────────────────────────────────
// Alchemy raw-fetch helpers (per evm-indexing skill patterns)
// ─────────────────────────────────────────────────────────────────
function toHex(n) { return '0x' + BigInt(n).toString(16); }

async function rpc(method, params) {
  const r = await fetch(ALCHEMY_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!r.ok) throw new Error(`Alchemy ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`Alchemy ${method}: ${j.error.message}`);
  return j.result;
}

async function getLatestBlock() {
  return BigInt(await rpc('eth_blockNumber', []));
}

// Returns { byJob: Map<jobId, log[]>, failedRanges: [{from, to}] }
async function prefetchLogs(address, fromBlock, toBlock, label) {
  const byJob = new Map();
  const failedRanges = [];
  let totalLogs = 0;
  for (let f = fromBlock; f <= toBlock; f += PREFETCH_CHUNK) {
    const t = (f + PREFETCH_CHUNK - 1n) > toBlock ? toBlock : (f + PREFETCH_CHUNK - 1n);
    let logs = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        logs = await rpc('eth_getLogs', [{
          address, fromBlock: toHex(f), toBlock: toHex(t), topics: []
        }]);
        break;
      } catch (e) {
        if (attempt === 2) {
          failedRanges.push({ from: f, to: t });
          console.log(`  [WARN ${label}] chunk ${f}-${t} FAILED — jobs in range will be skipped`);
        } else {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
    if (!logs) continue;
    for (const log of logs) {
      const t1 = log.topics?.[1];
      if (!t1) continue;
      const jobId = Number(BigInt(t1));
      if (!byJob.has(jobId)) byJob.set(jobId, []);
      byJob.get(jobId).push(log);
      totalLogs++;
    }
  }
  console.log(`  [PREFETCH ${label}] logs=${totalLogs} failures=${failedRanges.length} jobs=${byJob.size}`);
  return { byJob, failedRanges };
}

function cacheIncomplete(failedRanges) {
  return failedRanges.length > 0;
}

// ─────────────────────────────────────────────────────────────────
// classifyJobKey — derive config key from observed job state when the title
// tag is missing. Delegates to lib/awp/matrix.jobStateToConfigKey().
// ─────────────────────────────────────────────────────────────────
function classifyJobKey(job) {
  // jobStateToConfigKey reads job.title for an embedded "(soft-...-...)" tag
  // first, then falls back to derivation from on-chain fields.
  const key = jobStateToConfigKey(job);
  return key || 'soft-open-single-open-open'; // safe default if state is unparseable
}

// ─────────────────────────────────────────────────────────────────
// Viem read helpers
// ─────────────────────────────────────────────────────────────────
const JOB_ABI = parseAbi([
  'function jobCount() view returns (uint256)',
  'function getSubmissionCount(uint256) view returns (uint256)',
  'function getJobV15(uint256 jobId) view returns (address poster,uint256 reward,uint8 status,address activeValidator,address[] validatorWaitlist,uint256 validatorTimeout,bool openValidation,string title,string description,string requirementsJson,uint256 claimWindowHours,uint8 validationMode,uint8 submissionMode,uint256 submissionWindow,string validationScriptCID,bool requireSecurityAudit,string securityAuditTemplate,uint256 submissionDeadline,bool allowResubmission,bool allowRejectAll,address[] approvedWorkers,string validationInstructions,uint256 minWorkerRating,uint256 minValidatorRating)',
  'function getSubmissionV11(uint256,uint256) view returns (address worker,string deliverableUrl,bytes32 encryptedDeliverableHash,uint256 timestamp,uint8 status,bytes decryptionKey,bytes32 scriptResultHash,uint256 scriptScore,bool scriptPassed,string securityAuditCID)'
]);

async function readJob(jobId) {
  const r = await pub.readContract({ address: JOBNFT_V15, abi: JOB_ABI, functionName: 'getJobV15', args: [BigInt(jobId)] });
  return {
    id: jobId, poster: r[0], reward: r[1], status: Number(r[2]),
    activeValidator: r[3], title: r[7], description: r[8], requirementsJson: r[9],
    validationMode: Number(r[11]), submissionMode: Number(r[12]),
    submissionWindow: Number(r[13]), submissionDeadline: Number(r[17]),
    allowResubmission: r[18], allowRejectAll: r[19], approvedWorkers: r[20],
    minWorkerRating: Number(r[22]), minValidatorRating: Number(r[23]),
    openValidation: r[6]
  };
}

async function readAllSubmissions(jobId) {
  const count = Number(await pub.readContract({ address: JOBNFT_V15, abi: JOB_ABI, functionName: 'getSubmissionCount', args: [BigInt(jobId)] }));
  const subs = [];
  for (let i = 0; i < count; i++) {
    const r = await pub.readContract({ address: JOBNFT_V15, abi: JOB_ABI, functionName: 'getSubmissionV11', args: [BigInt(jobId), BigInt(i)] });
    subs.push({
      worker: r[0], deliverableUrl: r[1], timestamp: Number(r[3]),
      status: Number(r[4]), scriptPassed: r[8], scriptScore: Number(r[7])
    });
  }
  return subs;
}

// ─────────────────────────────────────────────────────────────────
// Build step array directly from events (one step per event, block order)
// ─────────────────────────────────────────────────────────────────
function buildSteps(logs) {
  const sorted = [...logs].sort((a, b) => {
    const ba = BigInt(a.blockNumber), bb = BigInt(b.blockNumber);
    if (ba !== bb) return ba < bb ? -1 : 1;
    return Number(BigInt(a.logIndex || '0x0')) - Number(BigInt(b.logIndex || '0x0'));
  });
  const steps = [];
  let stepIdx = 1;
  for (const log of sorted) {
    const name = SIG_TO_NAME[log.topics[0]?.toLowerCase()];
    if (!name) continue; // unknown event — skip, don't fabricate
    steps.push({
      step: stepIdx++, name, status: 'passed',
      details: {
        txHash: log.transactionHash,
        blockNumber: Number(BigInt(log.blockNumber))
      }
    });
  }
  return steps;
}

// ─────────────────────────────────────────────────────────────────
// Index events by name for predicate evaluation. Predicates expect
// objects shaped like { blockNumber, logIndex, txHash, topics }.
// ─────────────────────────────────────────────────────────────────
function groupEventsForPredicates(logs) {
  const out = {};
  for (const log of logs) {
    const name = SIG_TO_NAME[log.topics[0]?.toLowerCase()];
    if (!name) continue;
    if (!out[name]) out[name] = [];
    out[name].push({
      blockNumber: Number(BigInt(log.blockNumber)),
      logIndex: Number(BigInt(log.logIndex || '0x0')),
      txHash: log.transactionHash,
      topics: log.topics
    });
  }
  for (const arr of Object.values(out)) {
    arr.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Supabase write via /rest/v1/lifecycle_results
// ─────────────────────────────────────────────────────────────────
async function upsertLifecycle(row, stats) {
  if (DRY_RUN || !STS_KEY) {
    console.log(`  [DRY] ${JSON.stringify(row).slice(0, 200)}`);
    return;
  }
  try {
    const r = await fetch(`${STS_URL}/rest/v1/lifecycle_results?on_conflict=project_id,run_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: STS_KEY,
        Authorization: `Bearer ${STS_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.log(`  [ERR lifecycle upsert] status=${r.status} body=${txt.slice(0, 240)}`);
      if (stats) stats.errors++;
    }
  } catch (e) {
    console.log(`  [ERR lifecycle upsert] network: ${e.message?.slice(0, 200)}`);
    if (stats) stats.errors++;
  }
}

// ─────────────────────────────────────────────────────────────────
// Fix 1 — read HLO's recorded intent for a given on-chain job_id from
// orchestration_events. HLO emits dispatch rows with meta.intended_config +
// meta.intended_scenario; the direct-viem path also writes meta.job_id once
// the createJob tx is mined. Legacy swarm-create.mjs writes target_config +
// target_scenario in meta and the on-chain job_id at the top level.
//
// We look up by both (top-level job_id and meta->>job_id) so HLO direct-viem,
// CLI dispatch (no job_id binding), and legacy swarm-create rows are all
// considered. Returns { intended_config, intended_scenario, ... } or null
// when no recorded intent is found (pre-HLO / off-orchestration job).
// ─────────────────────────────────────────────────────────────────
async function fetchIntentFromOrchEvents(jobId) {
  if (!STS_KEY || jobId == null) return null;
  const headers = {
    apikey: STS_KEY,
    Authorization: `Bearer ${STS_KEY}`,
  };
  // Match either top-level job_id (legacy swarm-create) or meta->>job_id
  // (HLO direct-viem path). Take most recent verified dispatch.
  const filter = `or=(job_id.eq.${jobId},meta->>job_id.eq.${jobId})`;
  const url = `${STS_URL}/rest/v1/orchestration_events`
    + `?project_id=eq.awp&event_type=eq.dispatch&${filter}`
    + `&select=meta,ran_at,source,persona,job_id&order=ran_at.desc&limit=5`;
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    // Prefer the row that actually carries intent (HLO daemon). Fall back to
    // the most recent dispatch row regardless.
    const hlo = rows.find(row => row.source === 'hlo-daemon' && row.meta
      && (row.meta.intended_config || row.meta.intended_scenario));
    const pick = hlo || rows[0];
    const meta = pick.meta || {};
    const intendedConfig   = meta.intended_config   || meta.target_config   || null;
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
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        project_id: 'awp', component: 'sts-scanner-v15',
        outcome: actions_count > 0 ? 'ok' : 'idle',
        actions_count, note, meta: extraMeta
      })
    });
  } catch (e) { /* fire-and-forget */ }
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== STS Scanner V15 (Phase A — shared lib/awp/) ===');
  console.log(`JobNFT V15:     ${JOBNFT_V15}`);
  console.log(`ReviewGate V4:  ${REVIEWGATE_V4}`);
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  const t0 = Date.now();

  const latest = await getLatestBlock();
  console.log(`Latest block:   ${latest} (from ${DEPLOY_BLOCK})`);

  // Prefetch both contracts' logs.
  const [jobNFT, reviewGate] = await Promise.all([
    prefetchLogs(JOBNFT_V15, DEPLOY_BLOCK, latest, 'JobNFTv15'),
    prefetchLogs(REVIEWGATE_V4, DEPLOY_BLOCK, latest, 'ReviewGateV4')
  ]);

  const anyFailures = cacheIncomplete(jobNFT.failedRanges) || cacheIncomplete(reviewGate.failedRanges);
  if (anyFailures) {
    console.log(`  ⚠ Prefetch had chunk failures — affected jobs will be marked running with empty steps (NO partial write).`);
  }

  const jobCount = Number(await pub.readContract({ address: JOBNFT_V15, abi: JOB_ABI, functionName: 'jobCount' }));
  console.log(`jobCount:       ${jobCount}`);

  const endJob = LIMIT ? Math.min(SINCE_JOB + LIMIT - 1, jobCount) : jobCount;
  console.log(`Scanning jobs ${SINCE_JOB}..${endJob}`);

  const stats = { scanned: 0, classified: 0, unclassified: 0, in_flight: 0, skipped: 0, errors: 0, partial: 0, intent_mismatch: 0 };

  for (let batchStart = SINCE_JOB; batchStart <= endJob; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endJob);
    await Promise.all(
      Array.from({ length: batchEnd - batchStart + 1 }, (_, k) =>
        processJob(batchStart + k, jobNFT.byJob, reviewGate.byJob, anyFailures, stats))
    );
  }

  const duration = Date.now() - t0;
  console.log(`\nDONE — scanned=${stats.scanned} classified=${stats.classified} partial=${stats.partial} in_flight=${stats.in_flight} unclassified=${stats.unclassified} intent_mismatch=${stats.intent_mismatch} errors=${stats.errors} (${(duration/1000).toFixed(1)}s)`);
  await emitHeartbeat(stats.scanned, `scanned ${stats.scanned} jobs`, { ...stats, duration_ms: duration });
}

async function processJob(jobId, jobNFTCache, reviewGateCache, cacheBroken, stats) {
  stats.scanned++;
  try {
    const job = await readJob(jobId);

    if (cacheBroken) {
      // Conservative — don't overwrite potentially-good data with partial classification.
      // Note: cell_audit no longer carries intended_scenario (HLO writes intent
      // privately to orchestration_events; dashboard joins for in-flight rows).
      await upsertLifecycle({
        project_id: 'awp',
        run_id: `scan-v15-${jobId}-${Date.now()}`,
        onchain_job_id: jobId,
        config_key: classifyJobKey(job),
        scenario_key: 's00-in-flight',
        status: 'running',
        steps: [],
        started_at: new Date().toISOString(),
        cell_audit: { scanner_instance: 'scanner-v15-partial' }
      }, stats);
      stats.skipped++;
      return;
    }

    const jobLogs = jobNFTCache.get(jobId) || [];
    const rgLogs  = reviewGateCache.get(jobId) || [];
    const allLogs = [...jobLogs, ...rgLogs];

    const events = groupEventsForPredicates(allLogs);
    const steps  = buildSteps(allLogs);
    const submissions = await readAllSubmissions(jobId);

    const counts = computeCounts(submissions);

    // ── Observation: predicate-based classification of the on-chain shape ──
    // Kept as audit columns even though the canonical scenario/config below
    // come from HLO's recorded dispatch intent.
    const observedConfig = classifyJobKey(job);
    const configParams = parseConfigKey(observedConfig);
    const ctx = { job, submissions, events, counts, configParams };
    const observedScenario = classify(ctx);

    // ── Fix 1: canonical scenario/config = HLO's intent when available ──
    const intent = await fetchIntentFromOrchEvents(jobId);
    const scenarioKey = intent?.intended_scenario || observedScenario;
    const configKey   = intent?.intended_config   || observedConfig;
    const intent_matched = intent
      ? (intent.intended_scenario === observedScenario && intent.intended_config === observedConfig)
      : null;

    // ── Fix 2: per-validationMode review-count invariant ──
    //   HARD_ONLY      (validationMode=0): expect 2 ReviewSubmitted events
    //   SOFT_ONLY      (validationMode=1): expect 5 ReviewSubmitted events
    //   HARD_THEN_SOFT (validationMode=2): expect 5 ReviewSubmitted events
    const expectedReviews =
      job.validationMode === 0 ? 2 :
      job.validationMode === 1 ? 5 :
      job.validationMode === 2 ? 5 : null;
    const observedReviews = (events.ReviewSubmitted || []).length;

    // ── Status: chain-state driven; review invariant flips passed→partial. ──
    let status;
    if (observedScenario === 'unclassified' && job.status !== 2 && job.status !== 3) {
      // No predicate matched and chain isn't terminal yet — treat as in-flight
      // for status, but observed_scenario_key='unclassified' surfaces this for
      // audit. cell-defs may need a new predicate.
      status = 'running';
      stats.in_flight++;
    } else if (job.status === 0 || job.status === 1) {
      status = 'running';
      stats.in_flight++;
    } else if (job.status === 3) {
      status = 'failed';
      stats.errors++;
    } else if (job.status === 2) {
      if (expectedReviews !== null && observedReviews < expectedReviews) {
        status = 'partial';
        stats.partial++;
      } else {
        status = 'passed';
        stats.classified++;
      }
    } else {
      // Unknown on-chain status code — flag and mark error.
      status = 'error';
      stats.errors++;
    }
    if (observedScenario === 'unclassified') stats.unclassified++;
    if (intent_matched === false) stats.intent_mismatch++;

    await upsertLifecycle({
      project_id: 'awp',
      run_id: `scan-v15-${jobId}`,
      onchain_job_id: jobId,
      // Canonical (intent-driven when available; falls back to observed):
      config_key: configKey,
      scenario_key: scenarioKey,
      // Audit columns (Fix 1):
      observed_config_key: observedConfig,
      observed_scenario_key: observedScenario,
      intent_matched,
      // Review-count invariant (Fix 2):
      expected_reviews: expectedReviews,
      observed_reviews: observedReviews,
      status, steps,
      agent_wallets: {
        poster: job.poster,
        worker: submissions[0]?.worker || null,
        validator: job.activeValidator !== ZERO_ADDRESS ? job.activeValidator : null
      },
      started_at: new Date().toISOString(),
      completed_at: (status === 'passed' || status === 'partial') ? new Date().toISOString() : null,
      cell_audit: {
        scanner_instance: 'scanner-v15',
        intent_source: intent?.source || null,
        intent_agent: intent?.agent || null,
      }
    }, stats);

    if (observedScenario === 'unclassified' && status !== 'running') {
      console.log(`  [UNCLASSIFIED] job ${jobId} status=${job.status} approved=${counts.approved} rejected=${counts.rejected} — cell-defs needs a predicate for this shape`);
    } else if (status === 'partial') {
      console.log(`  [PARTIAL] job ${jobId} -> ${configKey} : ${scenarioKey} (reviews ${observedReviews}/${expectedReviews})`);
    } else if (intent_matched === false) {
      console.log(`  [MISMATCH] job ${jobId} intended ${intent.intended_config}|${intent.intended_scenario} ; observed ${observedConfig}|${observedScenario} (${status})`);
    } else {
      console.log(`  [OK] job ${jobId} -> ${configKey} : ${scenarioKey} (${status})`);
    }
  } catch (e) {
    stats.errors++;
    console.log(`  [ERR] job ${jobId}: ${e.message?.slice(0, 120)}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
