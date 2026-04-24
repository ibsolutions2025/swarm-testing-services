/**
 * sts-scanner.mjs — STS-owned onchain lifecycle scanner
 *
 * Mirrors awp-lifecycle-scanner.mjs (Fix E5+E6) but writes directly to
 * STS Supabase (ldxcenmhazelrnrlxuwq) under project_id='awp'.
 *
 * AWP infra stays running untouched. This scanner is an INDEPENDENT process.
 *
 * Key differences from AWP scanner:
 *   - No AWP API calls (apiGet/apiPost removed)
 *   - Direct Supabase writes via @supabase/supabase-js
 *   - Inserts/upserts into lifecycle_results with project_id='awp'
 *   - Reads existing rows directly from STS Supabase
 *   - run_id derived from onchain_job_id to keep rows stable across rescans
 *
 * INTEGRITY RULE: Every step and txHash comes from REAL on-chain events.
 * No placeholders, no fallbacks, no fabricated data.
 */

import { createClient } from '@supabase/supabase-js';
import { createPublicClient, http, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';

// ============================================================
// Config — loaded from env
// ============================================================
const STS_SUPABASE_URL    = process.env.STS_SUPABASE_URL    || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
const STS_SUPABASE_KEY    = process.env.STS_SUPABASE_KEY;  // service_role key — required
const ALCHEMY_RPC         = process.env.ALCHEMY_RPC         || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';
const PROJECT_ID          = 'awp';
const DRY_RUN             = process.argv.includes('--dry-run');
const SINCE_IDX           = process.argv.indexOf('--since');
const SINCE_JOB           = SINCE_IDX >= 0 ? parseInt(process.argv[SINCE_IDX + 1]) : null;
const BATCH_IDX           = process.argv.indexOf('--batch');
const BATCH_SIZE          = BATCH_IDX >= 0 ? parseInt(process.argv[BATCH_IDX + 1]) : 5;
const LOOP                = process.argv.includes('--loop');
const LOOP_INTERVAL_MS    = 15 * 60 * 1000; // 15 minutes

if (!STS_SUPABASE_KEY) {
  console.error('FATAL: STS_SUPABASE_KEY env var is required (service_role key)');
  process.exit(1);
}

// ============================================================
// Supabase client (service_role — bypasses RLS)
// ============================================================
const supabase = createClient(STS_SUPABASE_URL, STS_SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ============================================================
// Chain + contracts
// ============================================================
const JOBNFT_ADDRESS    = '0xc95ed85a6722399ee8eaa878adec79a8bea3c895';
const REVIEWGATE_ADDRESS = '0x7856191147766f4421aaa312def42a885820550d';
const DEPLOY_BLOCK      = 40216956n;
const PREFETCH_CHUNK    = 10000n;
const ZERO_ADDR         = '0x0000000000000000000000000000000000000000';

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_RPC) });

// ============================================================
// ABIs
// ============================================================
import { parseAbi } from 'viem';

const JOB_ABI = parseAbi([
  'function jobCount() view returns (uint256)',
  'function getJobV12(uint256 jobId) view returns (address poster, uint256 reward, uint8 status, address activeValidator, address[] validatorWaitlist, uint256 validatorTimeout, bool openValidation, string title, string description, string requirementsJson, uint256 claimWindowHours, uint8 validationMode, uint8 submissionMode, uint256 submissionWindow, string validationScriptCID, bool requireSecurityAudit, string securityAuditTemplate, uint256 submissionDeadline, bool allowResubmission, bool allowRejectAll, address[] approvedWorkers, string validationInstructions)',
  'function getSubmissionCount(uint256 jobId) view returns (uint256)',
  'function getSubmission(uint256 jobId, uint256 index) view returns (address worker, string deliverableUrl, uint256 timestamp, uint8 status)',
]);

// ============================================================
// Event signatures
// ============================================================
const EVENT_SIGS = {
  JobCreated:            '0x8678ba2d99dba901dafc51009f8d402d37a5a0275752cf0e263b827aeca906f2',
  WorkSubmitted:         '0xeaf66c9016a991665a7582b129182d19b8525216aca968483fe860f2a459ce87',
  ValidatorClaimed:      '0xf7615534252f5c4222f231ceb09fba15f7bfab2a6ec3958aa431855ffe10efc7',
  SubmissionApproved:    '0xc26c858ff8e61f25088ae05177b0fcbbedebc15afccac12444e34ac04e912307',
  SubmissionRejected:    '0x0c85652d2ac95894ed3aa3311d30cef8a307693957451a95f4b7ace387907c2a',
  AllSubmissionsRejected:'0xdcddfb3a7500e64439b1381a028edbd33a3bb99b4bcc0494c0f0a67fae21d1f1',
  JobCancelled:          '0xa80c76c474b34cc7af71dec63d733b959fff08f4eb0789e288be5db6b608f942',
  JobCompleted:          '0x02244c8529cb95e213ee542e76e7776342b3dabd10203d01472bbf4441be8929',
  DecryptionKeyReleased: '0x6dd073b5f787686fd496ebaedc900ddb6fe6c567cc668129b24f0854f63a2a34',
  ValidatorRewarded:     '0xf748876df18b552193d7cc2b9ba41429489708fa04a5a7e964a02f4bef478baa',
  ReviewSubmitted:       '0x73838c8181e68ccb58141bf7cbb01b8fcb260ebc4843abe09ed0e310bb091e14',
  NewFeedback:           '0xade4f46e703a47ccec90bf3f51b5dfe8b783b90a5f80190a98b5fb486b5c701b',
  ScriptResultRecorded:  '0xa8a3f1caeccc5c07ceae4f712a6cd188c0214ab048235accdd7ac7f08310af25',
};
const SIG_TO_NAME = {};
for (const [name, sig] of Object.entries(EVENT_SIGS)) SIG_TO_NAME[sig] = name;

const SWARM_ADDRESSES = new Set([
  '0x35bd1F28e93afdd929b82fF47612d00BEfc136CE',
  '0xd318DedfFfa5616e1c9Fb7080d02d03cC8D33100',
  '0xB0c19176E7477bf8B035e349d698a897eBE05044',
  '0xe62796e71dE1Ff0DA3b95e596a6a16307BF198c5',
  '0xD19306b699AF464b62fbBA03f34aF7b2f57cd4A8',
  '0xd924618566108628224162045cd65f6bb09201F1',
  '0xd547345c4b85B750056Cda193357Bc4Af1c9c8E4',
].map(a => a.toLowerCase()));

// ============================================================
// Chain reads
// ============================================================
async function getJobCount() {
  return publicClient.readContract({ address: JOBNFT_ADDRESS, abi: JOB_ABI, functionName: 'jobCount' });
}

async function getJobV12(jobId) {
  const raw = await publicClient.readContract({ address: JOBNFT_ADDRESS, abi: JOB_ABI, functionName: 'getJobV12', args: [BigInt(jobId)] });
  return {
    poster: raw[0], reward: raw[1], status: raw[2], activeValidator: raw[3],
    validatorWaitlist: raw[4], validatorTimeout: raw[5], openValidation: raw[6],
    title: raw[7], description: raw[8], requirementsJson: raw[9],
    claimWindowHours: raw[10], validationMode: raw[11], submissionMode: raw[12],
    submissionWindow: raw[13], validationScriptCID: raw[14], requireSecurityAudit: raw[15],
    securityAuditTemplate: raw[16], submissionDeadline: raw[17], allowResubmission: raw[18],
    allowRejectAll: raw[19], approvedWorkers: raw[20], validationInstructions: raw[21],
  };
}

async function getSubmissionCount(jobId) {
  return publicClient.readContract({ address: JOBNFT_ADDRESS, abi: JOB_ABI, functionName: 'getSubmissionCount', args: [BigInt(jobId)] });
}

async function getSubmission(jobId, index) {
  const raw = await publicClient.readContract({ address: JOBNFT_ADDRESS, abi: JOB_ABI, functionName: 'getSubmission', args: [BigInt(jobId), BigInt(index)] });
  return { worker: raw[0], deliverableUrl: raw[1], timestamp: raw[2], status: Number(raw[3]) };
}

// ============================================================
// Alchemy raw-fetch (E5: O(chunks) not O(jobs×chunks))
// ============================================================
function toHex(n) { return '0x' + BigInt(n).toString(16); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function alchemyGetLogs({ address, fromBlock, toBlock }) {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address, fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [] }] };
  const resp = await fetch(ALCHEMY_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`Alchemy HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(`Alchemy RPC: ${json.error.message}`);
  return json.result || [];
}

async function alchemyGetBlockNumber() {
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] };
  const resp = await fetch(ALCHEMY_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await resp.json();
  if (json.error) throw new Error(`Alchemy RPC: ${json.error.message}`);
  return BigInt(json.result);
}

async function prefetchAddressLogsByJobId(address, fromBlock, toBlock, label) {
  const byJob = new Map();
  let totalChunks = 0, totalLogs = 0, failures = 0;
  for (let f = fromBlock; f <= toBlock; f += PREFETCH_CHUNK) {
    const t = (f + PREFETCH_CHUNK - 1n) > toBlock ? toBlock : (f + PREFETCH_CHUNK - 1n);
    let logs = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { logs = await alchemyGetLogs({ address, fromBlock: f, toBlock: t }); break; }
      catch (e) { if (attempt === 2) { failures++; console.log(`  [WARN ${label}] chunk ${f}-${t}: ${(e.message||'').slice(0,80)}`); } else { await sleep(300 * (attempt + 1)); } }
    }
    totalChunks++;
    if (!logs) continue;
    for (const log of logs) {
      const t1 = log.topics && log.topics[1];
      if (!t1) continue;
      const jobId = Number(BigInt(t1));
      if (!byJob.has(jobId)) byJob.set(jobId, []);
      byJob.get(jobId).push(log);
      totalLogs++;
    }
  }
  console.log(`  [PREFETCH ${label}] chunks=${totalChunks} logs=${totalLogs} failures=${failures} jobsTouched=${byJob.size}`);
  return byJob;
}

// ============================================================
// Job classification + lifecycle
// ============================================================
function classifyJob(job) {
  const titleMatch = job.title?.match(/\(([a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+)\)$/);
  if (titleMatch) return titleMatch[1];
  const valModes = { 0: 'hard', 1: 'soft', 2: 'hardsift' };
  const valMode = valModes[Number(job.validationMode)] || 'soft';
  const deadline = (Number(job.submissionWindow) > 0 || Number(job.submissionDeadline) > 0) ? 'timed' : 'open';
  const subMode = job.submissionMode === 1 ? 'multi' : 'single';
  let workerAccess = 'open';
  if (job.approvedWorkers && job.approvedWorkers.length > 0) workerAccess = 'approved';
  else { try { const req = JSON.parse(job.requirementsJson || '{}'); if (req.minWorkerRating > 0) workerAccess = 'rating'; } catch {} }
  let validatorAccess = 'open';
  if (!job.openValidation) validatorAccess = 'approved';
  try { const req = JSON.parse(job.requirementsJson || '{}'); if (req.minValidatorRating > 0) validatorAccess = 'rating'; } catch {}
  if (Number(job.validationMode) === 0) validatorAccess = 'na';
  return `${valMode}-${deadline}-${subMode}-${workerAccess}-${validatorAccess}`;
}

function txHash(txInfo) { return txInfo ? (txInfo.hash || txInfo) : null; }
function txBlock(txInfo) { return txInfo ? (txInfo.blockNumber || 0) : 0; }

function extractJobTxHashesFromCache(jobId, jobNFTCache, reviewGateCache) {
  const txHashes = {
    created: null, submissions: [], validator: null, approval: null, rejected: [],
    allRejected: null, jobCancelled: null, jobCompleted: null, decryptionKey: null,
    validatorRewarded: null, scriptResultRecorded: null, reviews: [], validatorClaims: []
  };
  const jobNFTLogs = (jobNFTCache.get(jobId) || []).slice().sort((a, b) => {
    const ba = BigInt(a.blockNumber), bb = BigInt(b.blockNumber);
    if (ba !== bb) return ba < bb ? -1 : 1;
    return Number(BigInt(a.logIndex || '0x0')) - Number(BigInt(b.logIndex || '0x0'));
  });
  for (const log of jobNFTLogs) {
    const eventName = SIG_TO_NAME[log.topics[0]];
    const txInfo = { hash: log.transactionHash, blockNumber: Number(BigInt(log.blockNumber)) };
    switch (eventName) {
      case 'JobCreated':            txHashes.created = txInfo; break;
      case 'WorkSubmitted':         txHashes.submissions.push(txInfo); break;
      case 'ValidatorClaimed':      txHashes.validator = txInfo; txHashes.validatorClaims.push(txInfo); break;
      case 'SubmissionApproved':    txHashes.approval = txInfo; break;
      case 'SubmissionRejected':    txHashes.rejected.push(txInfo); break;
      case 'AllSubmissionsRejected':txHashes.allRejected = txInfo; break;
      case 'JobCancelled':          txHashes.jobCancelled = txInfo; break;
      case 'JobCompleted':          txHashes.jobCompleted = txInfo; break;
      case 'DecryptionKeyReleased': txHashes.decryptionKey = txInfo; break;
      case 'ValidatorRewarded':     txHashes.validatorRewarded = txInfo; break;
      case 'ScriptResultRecorded':  txHashes.scriptResultRecorded = txInfo; break;
    }
  }
  for (const log of (reviewGateCache.get(jobId) || [])) {
    const en = SIG_TO_NAME[log.topics[0]];
    if (en === 'ReviewSubmitted' || en === 'NewFeedback') {
      txHashes.reviews.push({
        hash: log.transactionHash,
        blockNumber: Number(BigInt(log.blockNumber)),
        reviewer: log.topics[2] ? ('0x' + log.topics[2].slice(26)).toLowerCase() : null,
        reviewee: log.topics[3] ? ('0x' + log.topics[3].slice(26)).toLowerCase() : null,
      });
    }
  }
  return txHashes;
}

function determineLifecycle(job, submissions, txHashes = {}) {
  const steps = [];
  if (txHashes.created) steps.push({ step: 1, name: 'JobCreated', status: 'passed', details: { poster: job.poster, reward: formatUnits(job.reward, 6) + ' USDC', txHash: txHash(txHashes.created), blockNumber: txBlock(txHashes.created) } });
  if (txHashes.submissions.length > 0) steps.push({ step: 2, name: 'WorkSubmitted', status: 'passed', details: { count: submissions.length, workers: submissions.map(s => s.worker), txHash: txHash(txHashes.submissions[0]), blockNumber: txBlock(txHashes.submissions[0]) } });
  const hasValidator = txHashes.validator !== null;
  if (txHashes.validator) steps.push({ step: 3, name: 'ValidatorClaimed', status: 'passed', details: { validator: job.activeValidator, txHash: txHash(txHashes.validator), blockNumber: txBlock(txHashes.validator) } });
  const approved = submissions.filter(s => s.status === 1);
  const rejected = submissions.filter(s => s.status === 2);
  if (txHashes.approval) steps.push({ step: 4, name: 'SubmissionApproved', status: 'passed', details: { txHash: txHash(txHashes.approval), blockNumber: txBlock(txHashes.approval) } });
  else if (txHashes.allRejected) steps.push({ step: 4, name: 'AllSubmissionsRejected', status: 'passed', details: { rejected: rejected.length || txHashes.submissions.length, txHash: txHash(txHashes.allRejected), blockNumber: txBlock(txHashes.allRejected) } });
  else if (txHashes.rejected.length > 0 && txHashes.rejected.length === txHashes.submissions.length) steps.push({ step: 4, name: 'AllRejected', status: 'passed', details: { rejected: txHashes.rejected.length, txHash: txHash(txHashes.rejected[0]), blockNumber: txBlock(txHashes.rejected[0]) } });
  if (txHashes.jobCancelled) steps.push({ step: 4.5, name: 'JobCancelled', status: 'passed', details: { txHash: txHash(txHashes.jobCancelled), blockNumber: txBlock(txHashes.jobCancelled) } });
  const completionInfo = txHashes.jobCompleted || txHashes.decryptionKey || txHashes.validatorRewarded || txHashes.scriptResultRecorded || txHashes.approval;
  const completionEvent = txHashes.jobCompleted ? 'JobCompleted' : txHashes.decryptionKey ? 'DecryptionKeyReleased' : txHashes.validatorRewarded ? 'ValidatorRewarded' : txHashes.scriptResultRecorded ? 'ScriptResultRecorded' : txHashes.approval ? 'SubmissionApproved' : null;
  if (completionInfo && completionEvent && completionEvent !== 'SubmissionApproved') steps.push({ step: 5, name: completionEvent, status: 'passed', details: { jobStatus: job.status, txHash: txHash(completionInfo), blockNumber: txBlock(completionInfo) } });
  if (txHashes.reviews.length > 0) {
    const uniqueReviews = new Map();
    for (const r of txHashes.reviews) {
      const key = (r.reviewer || 'unknown') + '->' + (r.reviewee || 'unknown');
      const existing = uniqueReviews.get(key);
      if (!existing || r.blockNumber > existing.blockNumber) uniqueReviews.set(key, r);
    }
    for (const r of uniqueReviews.values()) steps.push({ step: 6, name: 'ReviewSubmitted', status: 'passed', details: { txHash: txHash(r), blockNumber: txBlock(r), reviewer: r.reviewer || null, reviewee: r.reviewee || null } });
  }

  const stepNames = new Set(steps.map(s => s.name));
  const hasJobCreated = stepNames.has('JobCreated');
  const hasWorkSubmitted = stepNames.has('WorkSubmitted');
  const hasValidatorStep = stepNames.has('ValidatorClaimed') || !hasValidator;
  const hasApprovalStep = stepNames.has('SubmissionApproved') || stepNames.has('AllRejected') || stepNames.has('AllSubmissionsRejected') || stepNames.has('JobCancelled');
  const hasCompletion = stepNames.has('JobCompleted') || stepNames.has('DecryptionKeyReleased') || stepNames.has('ValidatorRewarded') || stepNames.has('ScriptResultRecorded') || stepNames.has('SubmissionApproved');
  const allCoreStepsVerified = hasJobCreated && hasWorkSubmitted && hasValidatorStep && hasApprovalStep && hasCompletion;
  const valMode = Number(job.validationMode || 0);
  const EXPECTED_REVIEWS = valMode === 0 ? 2 : 5;
  const isApprovedTerminal = stepNames.has('SubmissionApproved');
  const isRejectedTerminal = stepNames.has('AllRejected') || stepNames.has('AllSubmissionsRejected') || stepNames.has('JobCancelled');
  const reviewsComplete = txHashes.reviews.length >= EXPECTED_REVIEWS;
  let overallStatus = 'running';
  if (allCoreStepsVerified) {
    if (isApprovedTerminal && !isRejectedTerminal) overallStatus = reviewsComplete ? 'passed' : 'running';
    else overallStatus = 'passed';
  }

  const uniqueWorkers = new Set(submissions.map(s => s.worker?.toLowerCase())).size;
  let minWorkerRating = 0;
  try { const req = JSON.parse(job.requirementsJson || '{}'); minWorkerRating = req.minWorkerRating || 0; } catch {}
  const isNoShowTerminal = txHashes.submissions.length === 0 && Number(job.submissionDeadline) > 0 && Math.floor(Date.now() / 1000) > Number(job.submissionDeadline);
  const hasReachedTerminal = isApprovedTerminal || isRejectedTerminal || isNoShowTerminal;
  let scenarioKey;
  if (!hasReachedTerminal) scenarioKey = 's00-in-flight';
  else if (txHashes.jobCancelled) scenarioKey = txHashes.allRejected ? 's10-reject-all-cancel' : txHashes.submissions.length === 0 ? 's08-worker-no-show' : 's10-reject-all-cancel';
  else if (isNoShowTerminal) scenarioKey = 's08-worker-no-show';
  else if (txHashes.submissions.length > 0 && !hasValidator) scenarioKey = 's09-validator-no-show';
  else if (txHashes.validatorClaims && txHashes.validatorClaims.length > 1) scenarioKey = 's06-validator-waitlist';
  else if (txHashes.validator && txHashes.submissions.length > 0 && txBlock(txHashes.validator) < txBlock(txHashes.submissions[0])) scenarioKey = 's02-validator-first';
  else if (rejected.length > 0 && approved.length > 0) scenarioKey = 's04-rejection-loop';
  else if (rejected.length > 0 && approved.length === 0) scenarioKey = 's05-total-rejection';
  else if (uniqueWorkers > 1 && approved.length === 1) scenarioKey = 's03-competitive-workers';
  else if (submissions.length > 1 && approved.length > 0) scenarioKey = 's16-multiple-submissions';
  else if (minWorkerRating > 0 && submissions.length > 0 && approved.length > 0) scenarioKey = 's12-rating-gate-pass';
  else scenarioKey = 's01-happy-path';

  return { steps, overallStatus, scenarioKey };
}

// ============================================================
// Bootstrap — create lifecycle_results if it doesn't exist
// Uses Supabase SQL API (service_role bypasses RLS for DDL)
// ============================================================
async function bootstrapTable() {
  // Check if table already exists via REST introspection
  const resp = await fetch(`${STS_SUPABASE_URL}/rest/v1/lifecycle_results?limit=1`, {
    headers: { 'apikey': STS_SUPABASE_KEY, 'Authorization': `Bearer ${STS_SUPABASE_KEY}` },
  });

  if (resp.status === 200) {
    console.log('[bootstrap] lifecycle_results already exists — skipping DDL');
    return;
  }

  if (resp.status !== 404 && resp.status !== 406) {
    console.log(`[bootstrap] unexpected status ${resp.status} — attempting DDL anyway`);
  }

  console.log('[bootstrap] lifecycle_results not found — running CREATE TABLE via SQL API...');

  // Use Supabase's pg SQL endpoint (available with service_role JWT)
  const ddl = `
    create table if not exists lifecycle_results (
      id               uuid        primary key default gen_random_uuid(),
      project_id       text        not null default 'awp',
      run_id           text        not null,
      config_key       text        not null,
      scenario_key     text        not null,
      status           text        not null check (status in ('passed','failed','partial','skipped','error','running')),
      steps            jsonb       not null default '[]'::jsonb,
      wallets          jsonb,
      agent_wallets    jsonb,
      job_id           text,
      onchain_job_id   bigint,
      started_at       timestamptz not null default now(),
      completed_at     timestamptz,
      duration_ms      integer,
      error_message    text,
      current_step     text,
      step_audits      jsonb,
      cell_audit       jsonb,
      created_at       timestamptz not null default now(),
      updated_at       timestamptz not null default now()
    );
    create index if not exists lifecycle_results_project_config_scenario_idx on lifecycle_results(project_id, config_key, scenario_key);
    create index if not exists lifecycle_results_project_started_idx on lifecycle_results(project_id, started_at desc);
    create index if not exists lifecycle_results_project_status_idx on lifecycle_results(project_id, status);
    create unique index if not exists lifecycle_results_project_run_id_unique on lifecycle_results(project_id, run_id);
    alter table lifecycle_results enable row level security;
    drop policy if exists "lifecycle_results_select_awp" on lifecycle_results;
    create policy "lifecycle_results_select_awp" on lifecycle_results for select using (project_id = 'awp');
    create or replace function set_updated_at()
      returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
    drop trigger if exists lifecycle_results_set_updated_at on lifecycle_results;
    create trigger lifecycle_results_set_updated_at before update on lifecycle_results
      for each row execute function set_updated_at();
  `;

  // Supabase SQL API endpoint (only available to service_role via their internal pg proxy)
  const sqlResp = await fetch(`${STS_SUPABASE_URL}/rest/v1/rpc/query`, {
    method: 'POST',
    headers: {
      'apikey': STS_SUPABASE_KEY,
      'Authorization': `Bearer ${STS_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: ddl }),
  });

  if (sqlResp.ok) {
    console.log('[bootstrap] DDL executed via RPC — lifecycle_results created');
    return;
  }

  // Fallback: supabase-js admin .rpc() won't work for DDL without stored proc
  // Last resort: try the pg REST SQL endpoint (undocumented but available for service_role)
  const pgResp = await fetch(`${STS_SUPABASE_URL}/pg/query`, {
    method: 'POST',
    headers: {
      'apikey': STS_SUPABASE_KEY,
      'Authorization': `Bearer ${STS_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: ddl }),
  });

  if (pgResp.ok) {
    console.log('[bootstrap] DDL executed via /pg/query — lifecycle_results created');
    return;
  }

  const errText = await pgResp.text().catch(() => '');
  console.error(`[bootstrap] WARN: Could not auto-create table (HTTP ${pgResp.status}: ${errText.slice(0,200)})`);
  console.error('[bootstrap] Proceeding — table may exist under a different schema or need manual creation via Supabase SQL editor.');
  console.error('[bootstrap] Run migration manually: supabase/migrations/0002_sts_ownership.sql');
}

// ============================================================
// Supabase read/write
// ============================================================
async function fetchExistingRows() {
  const allRows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('lifecycle_results')
      .select('run_id, onchain_job_id, status, config_key, scenario_key')
      .eq('project_id', PROJECT_ID)
      .range(from, from + PAGE - 1);
    if (error) throw new Error('Supabase fetch: ' + error.message);
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return allRows;
}

async function upsertRow(row) {
  const { error } = await supabase
    .from('lifecycle_results')
    .upsert(row, { onConflict: 'project_id,run_id', ignoreDuplicates: false });
  if (error) throw new Error('Supabase upsert: ' + error.message);
}

// ============================================================
// Main scan loop
// ============================================================
async function runScan(isFirstRun = false) {
  console.log('=== STS Lifecycle Scanner (project_id=awp, Fix E5+E6) ===');
  console.log('Mode: ' + (DRY_RUN ? 'DRY RUN' : 'LIVE') + ' | Batch: ' + BATCH_SIZE);
  console.log('Target: ' + STS_SUPABASE_URL);

  // Bootstrap table on first run only
  if (isFirstRun) await bootstrapTable();

  const jobCount = Number(await getJobCount());
  console.log('Total jobs on-chain: ' + jobCount);

  console.log('\n[PREFETCH] Building event cache via Alchemy raw-fetch...');
  const latestBlock = await alchemyGetBlockNumber();
  console.log('  Latest block: ' + latestBlock);
  const t0 = Date.now();
  const [jobNFTCache, reviewGateCache] = await Promise.all([
    prefetchAddressLogsByJobId(JOBNFT_ADDRESS,    DEPLOY_BLOCK, latestBlock, 'JobNFT'),
    prefetchAddressLogsByJobId(REVIEWGATE_ADDRESS, DEPLOY_BLOCK, latestBlock, 'ReviewGate'),
  ]);
  console.log(`  Prefetch complete in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  const startJob = SINCE_JOB || 1;
  console.log('Fetching existing STS rows...');
  const existingRows = await fetchExistingRows();
  console.log('Existing STS lifecycle_results rows: ' + existingRows.length);

  const byJobId = new Map();
  for (const r of existingRows) {
    if (r.onchain_job_id != null) {
      const existing = byJobId.get(Number(r.onchain_job_id));
      if (!existing || r.run_id > existing.run_id) byJobId.set(Number(r.onchain_job_id), r);
    }
  }

  const stats = { scanned: 0, upserted: 0, skipped: 0, errors: 0, nonSwarm: 0 };

  for (let batchStart = startJob; batchStart <= jobCount; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, jobCount);
    const promises = [];
    for (let id = batchStart; id <= batchEnd; id++) {
      promises.push(processJob(id, byJobId, stats, jobNFTCache, reviewGateCache));
    }
    await Promise.all(promises);
    if (batchEnd < jobCount) await sleep(300);
  }

  console.log('\n=== SCAN COMPLETE ===');
  console.log(`Jobs: scanned=${stats.scanned} upserted=${stats.upserted} skipped=${stats.skipped} nonSwarm=${stats.nonSwarm} errors=${stats.errors}`);

  // Final row count
  const { count } = await supabase
    .from('lifecycle_results')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', PROJECT_ID);
  console.log('STS lifecycle_results total rows: ' + count);
  return count;
}

async function processJob(jobId, byJobId, stats, jobNFTCache, reviewGateCache) {
  stats.scanned++;
  try {
    const job = await getJobV12(jobId);
    if (!SWARM_ADDRESSES.has(job.poster.toLowerCase())) { stats.nonSwarm++; return; }
    const configKey = classifyJob(job);
    const subCount = Number(await getSubmissionCount(jobId));
    const submissions = [];
    for (let i = 0; i < subCount; i++) submissions.push(await getSubmission(jobId, i));
    const txHashes = extractJobTxHashesFromCache(jobId, jobNFTCache, reviewGateCache);
    const { steps, overallStatus, scenarioKey } = determineLifecycle(job, submissions, txHashes);
    const runId = `awp-job-${jobId}`;
    const existing = byJobId.get(jobId);
    if (existing && existing.status === overallStatus && existing.scenario_key === scenarioKey) {
      stats.skipped++;
      return;
    }
    if (DRY_RUN) {
      const tag = existing ? '[DRY-UPD]' : '[DRY-NEW]';
      console.log(`${tag} Job ${jobId} -> ${configKey}:${scenarioKey} = ${overallStatus} (${steps.length} steps)`);
      return;
    }
    const row = {
      project_id:     PROJECT_ID,
      run_id:         runId,
      config_key:     configKey,
      scenario_key:   scenarioKey,
      status:         overallStatus,
      steps:          steps,
      agent_wallets:  { poster: job.poster, worker: submissions[0]?.worker || null, validator: job.activeValidator !== ZERO_ADDR ? job.activeValidator : null },
      onchain_job_id: jobId,
      started_at:     new Date().toISOString(),
      completed_at:   overallStatus === 'passed' ? new Date().toISOString() : null,
      updated_at:     new Date().toISOString(),
    };
    await upsertRow(row);
    stats.upserted++;
    const tag = existing ? '[UPD]' : '[NEW]';
    console.log(`${tag} Job ${jobId} -> ${configKey}:${scenarioKey} = ${overallStatus} (${steps.length} steps)`);
    byJobId.set(jobId, { run_id: runId, onchain_job_id: jobId, status: overallStatus, config_key: configKey, scenario_key: scenarioKey });
  } catch (e) {
    stats.errors++;
    console.log(`[ERR] Job ${jobId}: ${e.message.slice(0, 120)}`);
  }
}

// ============================================================
// Entry point
// ============================================================
if (LOOP) {
  console.log(`Running in loop mode (interval: ${LOOP_INTERVAL_MS / 60000}m)`);
  let firstRun = true;
  async function loopForever() {
    while (true) {
      try { await runScan(firstRun); firstRun = false; } catch (e) { console.error('SCAN ERROR:', e.message); }
      console.log(`\nSleeping ${LOOP_INTERVAL_MS / 60000}m before next scan...\n`);
      await sleep(LOOP_INTERVAL_MS);
    }
  }
  loopForever().catch(e => { console.error('FATAL:', e); process.exit(1); });
} else {
  runScan(true).catch(e => { console.error('FATAL:', e); process.exit(1); });
}
