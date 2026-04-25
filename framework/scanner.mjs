#!/usr/bin/env node
/**
 * framework/scanner.mjs — Phase 8 programmatic lifecycle scanner.
 *
 * Replaces the V14-era pattern-matching scanner. Per PHASE-8-EXECUTION-PLAN
 * Step 8:
 *   - Steps[] is built DIRECTLY from observed events (one step per event, in
 *     block order). No "if txHashes.X then push step X" inference chain.
 *   - Classification runs cell-definitions.json predicates against
 *     (authoritative job state + event log). First matching predicate wins.
 *   - Partial caches do NOT get written. If any block chunk failed its 3
 *     retries, jobs whose block range overlaps the failed chunk are marked
 *     status='running' with empty steps[] — no bad data overwrites a real
 *     row.
 *   - Writes to STS Supabase via the app's /api/test-results/lifecycle
 *     route (same as the V14 scanner).
 *
 * Usage:  node framework/scanner.mjs [--dry-run] [--since <jobId>]
 *                                     [--batch <N>] [--limit <N>]
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));
// NOTE: JSON configs are resolved relative to __dirname so this script
// runs identically from the STS repo (framework/scanner.mjs) and from a
// flat VPS dir (/root/test-swarm/awp-scanner-v15.mjs). The two JSONs
// must live side-by-side with the script in both layouts.

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────
const ALCHEMY_RPC = process.env.ALCHEMY_RPC
  || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';

// Loaded from deployment-v15.json on VPS OR env override.
const JOBNFT_V15 = process.env.AWP_JOBNFT   || '';   // REQUIRED
const REVIEWGATE_V4 = process.env.AWP_RG    || '';   // REQUIRED
const DEPLOY_BLOCK = BigInt(process.env.AWP_DEPLOY_BLOCK || '0'); // REQUIRED
if (!JOBNFT_V15 || !REVIEWGATE_V4 || DEPLOY_BLOCK === 0n) {
  console.error('Required env: AWP_JOBNFT, AWP_RG, AWP_DEPLOY_BLOCK');
  process.exit(1);
}

const PREFETCH_CHUNK = 10000n;
// argv helper — the old pattern `process.argv[indexOf(flag) + 1] || default`
// broke for flagless invocations: indexOf returns -1, +1 = 0, argv[0] is the
// node binary path (truthy), fallback never fires, parseInt → NaN, scan loop
// never runs. Cron passes no flags, so every cron tick was silently scanning
// 0 jobs. Fixed: only consume the next token when the flag actually appears.
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

// Event signature hashes — canonical Solidity sigs → keccak256 (same as V14
// scanner for the common events; V15 adds RatingGateFailed).
const EVENT_SIGS = {
  JobCreated:            '0x8678ba2d99dba901dafc51009f8d402d37a5a0275752cf0e263b827aeca906f2',
  WorkSubmitted:         '0xeaf66c9016a991665a7582b129182d19b8525216aca968483fe860f2a459ce87',
  ValidatorClaimed:      '0xf7615534252f5c4222f231ceb09fba15f7bfab2a6ec3958aa431855ffe10efc7',
  SubmissionApproved:    '0xc26c858ff8e61f25088ae05177b0fcbbedebc15afccac12444e34ac04e912307',
  SubmissionRejected:    '0x0c85652d2ac95894ed3aa3311d30cef8a307693957451a95f4b7ace387907c2a',
  AllSubmissionsRejected:'0xdcddfb3a7500e64439b1381a028edbd33a3bb99b4bcc0494c0f0a67fae21d1f1',
  JobCancelled:          '0xa80c76c474b34cc7af71dec63d733b959fff08f4eb0789e288be5db6b608f942',
  DecryptionKeyReleased: '0x6dd073b5f787686fd496ebaedc900ddb6fe6c567cc668129b24f0854f63a2a34',
  ValidatorRewarded:     '0xf748876df18b552193d7cc2b9ba41429489708fa04a5a7e964a02f4bef478baa',
  ReviewSubmitted:       '0x73838c8181e68ccb58141bf7cbb01b8fcb260ebc4843abe09ed0e310bb091e14',
  ScriptResultRecorded:  '0xa8a3f1caeccc5c07ceae4f712a6cd188c0214ab048235accdd7ac7f08310af25',
  ValidatorRotated:      '0x22a27adcea5eefbe73aa3e03e4e75a3dae8b8d70fd75a68e3bce86eaf14cda27'
  // RatingGateFailed hash isn't needed — emitted only in reverted txs (trace-level).
};
const SIG_TO_NAME = Object.fromEntries(Object.entries(EVENT_SIGS).map(([n, s]) => [s, n]));
const ZERO = '0x0000000000000000000000000000000000000000';

const pub = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_RPC) });

// Load cell-definitions + configs — resolved relative to __dirname so VPS
// flat layout (JSONs next to the script) and repo layout both work.
const cellDefs = JSON.parse(readFileSync(join(__dirname, 'cell-definitions.json'), 'utf8'));
const configs  = JSON.parse(readFileSync(join(__dirname, 'configs.json'), 'utf8'));

// ─────────────────────────────────────────────────────────────────
// Predicate functions — one per scenario. Each takes `ctx` = {
//   job, submissions, events (map: name → sorted log[]), counts,
//   configParams
// } and returns true/false.
//
// Terminology mirrored from cell-definitions.json.terminology.
// ─────────────────────────────────────────────────────────────────
const PREDICATES = {
  's01-happy-path': (c) =>
    c.job.status === 2 &&
    c.counts.approved === 1 &&
    c.counts.rejected === 0 &&
    (c.events.ValidatorClaimed?.length || 0) <= 1 &&
    (c.events.WorkSubmitted?.length || 0) === 1,

  's02-validator-first': (c) =>
    c.job.status === 2 &&
    (c.events.ValidatorClaimed?.length || 0) >= 1 &&
    (c.events.WorkSubmitted?.length || 0) >= 1 &&
    c.events.ValidatorClaimed[0].blockNumber < c.events.WorkSubmitted[0].blockNumber &&
    c.counts.approved === 1,

  's03-competitive-workers': (c) =>
    c.job.status === 2 &&
    c.counts.distinctWorkers >= 2 &&
    c.counts.approved === 1,

  's04-rejection-loop': (c) =>
    c.job.status === 2 &&
    c.counts.rejected >= 1 &&
    c.counts.approved === 1,

  's05-total-rejection': (c) =>
    (c.events.AllSubmissionsRejected?.length || 0) > 0 &&
    !(c.events.JobCancelled?.length > 0) &&
    c.counts.all_rejected === true,

  's06-validator-waitlist': (c) =>
    (c.events.ValidatorClaimed?.length || 0) >= 2 &&
    (c.job.status === 2 || c.job.status === 3),

  's08-worker-no-show': (c) =>
    c.job.status === 3 && c.submissions.length === 0,

  's09-validator-no-show': (c) =>
    c.job.status === 3 &&
    c.job.activeValidator.toLowerCase() === ZERO &&
    c.submissions.length >= 1 &&
    !(c.events.ValidatorClaimed?.length > 0),

  's10-reject-all-cancel': (c) => {
    const ar = c.events.AllSubmissionsRejected?.[0];
    const jc = c.events.JobCancelled?.[0];
    return ar && jc && ar.blockNumber < jc.blockNumber && c.job.status === 3;
  },

  's12-rating-gate-pass': (c) =>
    c.job.status === 2 &&
    (Number(c.configParams.minWorkerRating) > 0 || Number(c.configParams.minValidatorRating) > 0) &&
    c.counts.approved === 1,

  's16-multiple-submissions': (c) =>
    c.submissions.length >= 2 &&
    c.counts.approved === 1 &&
    c.job.status === 2
};

// Priority order matches cell-definitions.json top-to-bottom classifier.
const PRIORITY = [
  's10-reject-all-cancel',  // must be checked before s05 + s08
  's05-total-rejection',
  's08-worker-no-show',
  's09-validator-no-show',
  's06-validator-waitlist',
  's02-validator-first',
  's04-rejection-loop',
  's03-competitive-workers',
  's16-multiple-submissions',
  's12-rating-gate-pass',
  's01-happy-path'
];

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

// Did any failed chunk intersect this job's on-chain lifetime?
// We don't know the job's creation block without reading on-chain, but
// for cache-incompleteness detection we treat any failed range in the
// overall scan as "might have affected any job". Conservative: mark
// affected for ALL jobs if any failure, per the plan's "do NOT write
// partial data" rule.
function cacheIncomplete(failedRanges) {
  return failedRanges.length > 0;
}

// ─────────────────────────────────────────────────────────────────
// Derive configParams from config_key using configs.json axisRules
// ─────────────────────────────────────────────────────────────────
function parseConfigKey(key) {
  const [valMode, deadline, subMode, workerAccess, validatorAccess] = key.split('-');
  return {
    valMode, deadline, subMode, workerAccess, validatorAccess,
    validationMode: { soft: 1, hard: 0, hardsift: 2 }[valMode],
    submissionMode: { single: 0, multi: 1 }[subMode],
    submissionWindow: deadline === 'timed' ? 7200 : 0,
    allowResubmission: subMode === 'multi',
    allowRejectAll:    valMode === 'soft' && subMode === 'multi',
    minWorkerRating:   workerAccess === 'rating' ? 400 : 0,
    minValidatorRating: validatorAccess === 'rating' && valMode !== 'hard' ? 400 : 0
  };
}

// swarm-create embeds {scenario, config, ...} in the on-chain requirementsJson
// when posting a job. The scanner classifies job state into a scenario_key
// based on observable on-chain behavior, but in-flight jobs (s00-in-flight)
// have no terminal evidence yet. Capturing the *intended* scenario lets the
// dashboard bucket those rows under the cell they're headed for, instead of
// invisibly piling up in an unbucketed s00 column.
function parseIntendedScenario(requirementsJson) {
  if (!requirementsJson || typeof requirementsJson !== 'string') return null;
  try {
    const r = JSON.parse(requirementsJson);
    return typeof r?.scenario === 'string' ? r.scenario : null;
  } catch { return null; }
}

function classifyJobKey(job) {
  // Try to pull from title tag first (swarm-create embeds the config key)
  const m = job.title?.match(/\(([a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+)\)$/);
  if (m) return m[1];
  const valModes = { 0: 'hard', 1: 'soft', 2: 'hardsift' };
  const vm = valModes[Number(job.validationMode)] || 'soft';
  const dl = (Number(job.submissionWindow) > 0 || Number(job.submissionDeadline) > 0) ? 'timed' : 'open';
  const sm = Number(job.submissionMode) === 1 ? 'multi' : 'single';
  let wa = 'open';
  if (Array.isArray(job.approvedWorkers) && job.approvedWorkers.length > 0) wa = 'approved';
  else if (Number(job.minWorkerRating) > 0) wa = 'rating';
  let va = 'open';
  if (vm === 'hard') va = 'na';
  else if (!job.openValidation) va = 'approved';
  else if (Number(job.minValidatorRating) > 0) va = 'rating';
  return `${vm}-${dl}-${sm}-${wa}-${va}`;
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
    const name = SIG_TO_NAME[log.topics[0]];
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
// Index events by name for predicate evaluation
// ─────────────────────────────────────────────────────────────────
function groupEvents(logs) {
  const out = {};
  for (const log of logs) {
    const name = SIG_TO_NAME[log.topics[0]];
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
// Classify one job
// ─────────────────────────────────────────────────────────────────
function classify(ctx) {
  for (const key of PRIORITY) {
    const pred = PREDICATES[key];
    try {
      if (pred(ctx)) return key;
    } catch (e) { /* predicate lookup on missing field — skip */ }
  }
  // No terminal predicate matched.
  if (ctx.job.status === 2 || ctx.job.status === 3) return 'unclassified';
  return 's00-in-flight';
}

// ─────────────────────────────────────────────────────────────────
// Supabase write via /rest/v1/lifecycle_results
// ─────────────────────────────────────────────────────────────────
// Upsert a lifecycle row. Caller passes the stats bag so that Supabase
// 4xx/5xx responses AND network-layer throws both bump stats.errors — the
// DONE-line errors counter was previously only incremented from the
// per-job try/catch and never from the upsert path, which hid PGRST204
// schema-drift failures (e.g. unknown column `instance_id`) that looked
// like "scanned 3 errors 0" but wrote zero rows.
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
  console.log('=== STS Scanner V15 (programmatic) ===');
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

  const stats = { scanned: 0, classified: 0, unclassified: 0, in_flight: 0, skipped: 0, errors: 0 };

  for (let batchStart = SINCE_JOB; batchStart <= endJob; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endJob);
    await Promise.all(
      Array.from({ length: batchEnd - batchStart + 1 }, (_, k) =>
        processJob(batchStart + k, jobNFT.byJob, reviewGate.byJob, anyFailures, stats))
    );
  }

  const duration = Date.now() - t0;
  console.log(`\nDONE — scanned=${stats.scanned} classified=${stats.classified} in_flight=${stats.in_flight} unclassified=${stats.unclassified} errors=${stats.errors} (${(duration/1000).toFixed(1)}s)`);
  await emitHeartbeat(stats.scanned, `scanned ${stats.scanned} jobs`, { ...stats, duration_ms: duration });
}

async function processJob(jobId, jobNFTCache, reviewGateCache, cacheBroken, stats) {
  stats.scanned++;
  try {
    const job = await readJob(jobId);

    if (cacheBroken) {
      // Conservative — don't overwrite potentially-good data with partial classification.
      await upsertLifecycle({
        project_id: 'awp',
        run_id: `scan-v15-${jobId}-${Date.now()}`,
        onchain_job_id: jobId,
        config_key: classifyJobKey(job),
        scenario_key: 's00-in-flight',
        status: 'running',
        steps: [],
        started_at: new Date().toISOString(),
        // scanner_instance tag preserved in cell_audit (schema-flexible JSON
        // blob). STS lifecycle_results has no top-level instance_id column.
        // intended_scenario lets the dashboard bucket this in-flight row under
        // the cell it's headed for; falls back to s00-in-flight if absent.
        cell_audit: {
          scanner_instance: 'scanner-v15-partial',
          intended_scenario: parseIntendedScenario(job.requirementsJson)
        }
      }, stats);
      stats.skipped++;
      return;
    }

    const jobLogs = jobNFTCache.get(jobId) || [];
    const rgLogs  = reviewGateCache.get(jobId) || [];
    const allLogs = [...jobLogs, ...rgLogs];

    const events = groupEvents(allLogs);
    const steps  = buildSteps(allLogs);
    const submissions = await readAllSubmissions(jobId);

    const counts = {
      approved:  submissions.filter(s => s.status === 1).length,
      rejected:  submissions.filter(s => s.status === 2).length,
      pending:   submissions.filter(s => s.status === 0).length,
      notSel:    submissions.filter(s => s.status === 3).length,
      distinctWorkers: new Set(submissions.map(s => s.worker.toLowerCase())).size,
      all_rejected: submissions.length > 0 && submissions.every(s => s.status === 2)
    };

    const configKey = classifyJobKey(job);
    const configParams = parseConfigKey(configKey);

    const ctx = { job, submissions, events, counts, configParams };
    const scenarioKey = classify(ctx);

    let status;
    if (scenarioKey === 's00-in-flight') { status = 'running'; stats.in_flight++; }
    else if (scenarioKey === 'unclassified') { status = 'error'; stats.unclassified++; }
    else { status = 'passed'; stats.classified++; }

    await upsertLifecycle({
      project_id: 'awp',
      run_id: `scan-v15-${jobId}`,
      onchain_job_id: jobId,
      config_key: configKey,
      scenario_key: scenarioKey,
      status, steps,
      agent_wallets: {
        poster: job.poster,
        worker: submissions[0]?.worker || null,
        validator: job.activeValidator !== ZERO ? job.activeValidator : null
      },
      started_at: new Date().toISOString(),
      completed_at: status === 'passed' ? new Date().toISOString() : null,
      // scanner_instance tag preserved in cell_audit — STS has no
      // top-level instance_id column (see note above). intended_scenario
      // is captured even on terminal rows so that downstream consumers can
      // tell where an "almost there" job was supposed to land.
      cell_audit: {
        scanner_instance: 'scanner-v15',
        intended_scenario: parseIntendedScenario(job.requirementsJson)
      }
    }, stats);

    if (scenarioKey === 'unclassified') {
      console.log(`  [UNCLASSIFIED] job ${jobId} status=${job.status} approved=${counts.approved} rejected=${counts.rejected} — cell-definitions needs a predicate for this shape`);
    } else {
      console.log(`  [OK] job ${jobId} -> ${configKey} : ${scenarioKey} (${status})`);
    }
  } catch (e) {
    stats.errors++;
    console.log(`  [ERR] job ${jobId}: ${e.message?.slice(0, 120)}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
