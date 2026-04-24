#!/usr/bin/env node
/**
 * swarm-create.mjs — Scenario-targeted job creation for AWP.
 *
 * Replaces auto-cycle.mjs doCreateJob(). No LLM calls. Runs every 15 min via
 * cron. Posts ONE new job per run, targeting an under-represented (config,
 * scenario) cell.
 *
 * Logic:
 *   1. Read SCENARIO_PRIORITY list (hard-coded; empty scenarios first)
 *   2. For chosen scenario, pick a compatible config (valid constraints per
 *      scenario — e.g., s08/s09 need timed, s16 needs allowResubmission, s12
 *      needs rating access)
 *   3. Round-robin the posting agent by cycle count
 *   4. Build createJob params deterministically from config_key
 *   5. Pick title/description from JOB_TEMPLATES
 *   6. Post, then write intended-scenarios.json[jobId] = scenario
 *
 * Drain layer reads intended-scenarios.json and walks each job through the
 * required event pattern for its target scenario.
 */

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { runAgent } from './swarm-agent-runner.mjs';

const STARTED_AT = Date.now();

const CYCLE_ID  = `create-${new Date().toISOString()}`;
const COMPONENT = 'swarm-create';

const STS_SUPABASE_URL =
  process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
const STS_SUPABASE_KEY = process.env.STS_SUPABASE_KEY;

async function emitHeartbeat(component, actions_count, note, extraMeta = {}) {
  if (!STS_SUPABASE_KEY) {
    console.log(`[heartbeat] skipped (${component}): STS_SUPABASE_KEY not set`);
    return;
  }
  try {
    const resp = await fetch(`${STS_SUPABASE_URL}/rest/v1/system_heartbeats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: STS_SUPABASE_KEY,
        Authorization: `Bearer ${STS_SUPABASE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        project_id: 'awp',
        component,
        outcome: actions_count > 0 ? 'ok' : 'idle',
        actions_count,
        note,
        meta: { duration_ms: Date.now() - STARTED_AT, ...extraMeta },
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.log(`[heartbeat] POST failed ${resp.status}: ${t.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`[heartbeat] error: ${e.message?.slice(0, 200)}`);
  }
}

async function emitOrchestrationEvent(fields) {
  const url = (process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co')
    + '/rest/v1/orchestration_events';
  const key = process.env.STS_SUPABASE_KEY;
  if (!key) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        project_id: 'awp',
        cycle_id: CYCLE_ID,
        source: COMPONENT,
        ...fields,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.log(`[orch-emit] failed ${res.status}: ${t.slice(0,200)}`);
    }
  } catch (e) {
    console.log(`[orch-emit] error: ${e.message?.slice(0,200)}`);
  }
}

const RPC       = process.env.AWP_RPC_URL || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';
const JOB_NFT   = '0xc95ed85a6722399ee8eaa878adec79a8bea3c895';
const MOCK_USDC = '0x7ae8519d5fb7be655be9846553a595de8e00c209';
const SCENARIOS_FILE = '/root/test-swarm/intended-scenarios.json';
const CYCLE_FILE     = '/root/test-swarm/.create-cycle';
const RUN_ID = new Date().toISOString();

// ============================================================
// Load agents
// ============================================================
const NAMES = { 1:'Spark', 2:'Grind', 3:'Judge', 4:'Chaos', 5:'Scout', 6:'Flash', 7:'Bridge' };
const AGENTS = [];
for (let i = 1; i <= 7; i++) {
  const raw = readFileSync(`/root/test-swarm/agent-${i}/IDENTITY.md`, 'utf8');
  const m = raw.match(/Private Key:\s*(0x[a-fA-F0-9]{64})/);
  if (!m) throw new Error(`agent-${i}: no private key found`);
  const account = privateKeyToAccount(m[1]);
  AGENTS.push({ id: i, name: NAMES[i], account, address: account.address });
}
const ALL_ADDRESSES = AGENTS.map(a => a.address);

// ============================================================
// Cycle counter
// ============================================================
let cycleCount = 0;
try { cycleCount = parseInt(readFileSync(CYCLE_FILE, 'utf8').trim()) || 0; } catch {}
cycleCount++;
writeFileSync(CYCLE_FILE, String(cycleCount));

// ============================================================
// Scenario priority — earlier = higher priority
// Reflects the 2026-04-23 audit showing these empty/sparse
// ============================================================
const SCENARIO_PRIORITY = [
  's12-rating-gate-pass',      // 0 rows
  's02-validator-first',       // 0 rows
  's10-reject-all-cancel',     // 0 rows
  's16-multiple-submissions',  // 0 rows
  's08-worker-no-show',        // 2 rows
  's04-rejection-loop',        // 2 rows
  's05-total-rejection',       // 19 rows
  's09-validator-no-show',     // 14 rows
  's06-validator-waitlist',    // 15 rows
  's03-competitive-workers',   // 21 rows
  's01-happy-path',            // 63 rows — fallback only
];

// ============================================================
// Scenario → config constraints
// Returns true if config_key is compatible with the target scenario
// ============================================================
function isScenarioCompatible(scenario, key) {
  const [valMode, deadline, subMode, workerAccess, validatorAccess] = key.split('-');

  switch (scenario) {
    case 's01-happy-path':
      return true; // any config
    case 's02-validator-first':
      // Need non-HARD (HARD_ONLY has no validator concept)
      return valMode !== 'hard';
    case 's03-competitive-workers':
      // Need multi submission mode (allows multiple workers) + non-HARD
      return subMode === 'multi' && valMode !== 'hard';
    case 's04-rejection-loop':
      // Need multi (resubmission) + non-HARD validator flow
      return subMode === 'multi' && valMode !== 'hard';
    case 's05-total-rejection':
      // Need SOFT (allowRejectAll=true only when validationMode==1=SOFT)
      return valMode === 'soft' && subMode === 'multi';
    case 's06-validator-waitlist':
      // Need non-HARD + openValidation preferred so multiple can claim
      return valMode !== 'hard' && validatorAccess === 'open';
    case 's08-worker-no-show':
      // Need timed + any mode
      return deadline === 'timed';
    case 's09-validator-no-show':
      // Need timed + non-HARD
      return deadline === 'timed' && valMode !== 'hard';
    case 's10-reject-all-cancel':
      // Need SOFT + multi (needs rejectAll then cancel)
      return valMode === 'soft' && subMode === 'multi';
    case 's12-rating-gate-pass':
      // Need rating on worker and/or validator access
      return workerAccess === 'rating' || validatorAccess === 'rating';
    case 's16-multiple-submissions':
      // Need multi submission mode + non-HARD (validator approves one)
      return subMode === 'multi' && valMode !== 'hard';
    default:
      return false;
  }
}

// ============================================================
// 84 config keys
// ============================================================
const ALL_CONFIG_KEYS = [
  'soft-open-single-open-open','soft-open-single-open-approved','soft-open-single-open-rating',
  'soft-open-single-approved-open','soft-open-single-approved-approved','soft-open-single-approved-rating',
  'soft-open-single-rating-open','soft-open-single-rating-approved','soft-open-single-rating-rating',
  'soft-open-multi-open-open','soft-open-multi-open-approved','soft-open-multi-open-rating',
  'soft-open-multi-approved-open','soft-open-multi-approved-approved','soft-open-multi-approved-rating',
  'soft-open-multi-rating-open','soft-open-multi-rating-approved','soft-open-multi-rating-rating',
  'soft-timed-single-open-open','soft-timed-single-open-approved','soft-timed-single-open-rating',
  'soft-timed-single-approved-open','soft-timed-single-approved-approved','soft-timed-single-approved-rating',
  'soft-timed-single-rating-open','soft-timed-single-rating-approved','soft-timed-single-rating-rating',
  'soft-timed-multi-open-open','soft-timed-multi-open-approved','soft-timed-multi-open-rating',
  'soft-timed-multi-approved-open','soft-timed-multi-approved-approved','soft-timed-multi-approved-rating',
  'soft-timed-multi-rating-open','soft-timed-multi-rating-approved','soft-timed-multi-rating-rating',
  'hard-open-single-open-na','hard-open-single-approved-na','hard-open-single-rating-na',
  'hard-open-multi-open-na','hard-open-multi-approved-na','hard-open-multi-rating-na',
  'hard-timed-single-open-na','hard-timed-single-approved-na','hard-timed-single-rating-na',
  'hard-timed-multi-open-na','hard-timed-multi-approved-na','hard-timed-multi-rating-na',
  'hardsift-open-single-open-open','hardsift-open-single-open-approved','hardsift-open-single-open-rating',
  'hardsift-open-single-approved-open','hardsift-open-single-approved-approved','hardsift-open-single-approved-rating',
  'hardsift-open-single-rating-open','hardsift-open-single-rating-approved','hardsift-open-single-rating-rating',
  'hardsift-open-multi-open-open','hardsift-open-multi-open-approved','hardsift-open-multi-open-rating',
  'hardsift-open-multi-approved-open','hardsift-open-multi-approved-approved','hardsift-open-multi-approved-rating',
  'hardsift-open-multi-rating-open','hardsift-open-multi-rating-approved','hardsift-open-multi-rating-rating',
  'hardsift-timed-single-open-open','hardsift-timed-single-open-approved','hardsift-timed-single-open-rating',
  'hardsift-timed-single-approved-open','hardsift-timed-single-approved-approved','hardsift-timed-single-approved-rating',
  'hardsift-timed-single-rating-open','hardsift-timed-single-rating-approved','hardsift-timed-single-rating-rating',
  'hardsift-timed-multi-open-open','hardsift-timed-multi-open-approved','hardsift-timed-multi-open-rating',
  'hardsift-timed-multi-approved-open','hardsift-timed-multi-approved-approved','hardsift-timed-multi-approved-rating',
  'hardsift-timed-multi-rating-open','hardsift-timed-multi-rating-approved','hardsift-timed-multi-rating-rating',
];

// ============================================================
// Parse config_key → createJob params
// ============================================================
function configKeyToParams(key, poster) {
  const [valMode, deadline, subMode, workerAccess, validatorAccess] = key.split('-');
  const otherAgents = ALL_ADDRESSES.filter(a => a.toLowerCase() !== poster.address.toLowerCase());

  const validationMode = valMode === 'soft' ? 1 : valMode === 'hard' ? 0 : 2;
  const submissionMode = subMode === 'multi' ? 1 : 0;
  const submissionWindow = submissionMode === 1 ? 7200 : 0; // 2h for timed

  let approvedWorkers = [];
  let minWorkerRating = 0;
  if (workerAccess === 'approved') approvedWorkers = otherAgents.slice(0, 3);
  else if (workerAccess === 'rating') minWorkerRating = 400;

  let approvedValidators = [];
  let openValidation = true;
  let minValidatorRating = 0;
  if (validatorAccess === 'approved') {
    openValidation = false;
    approvedValidators = otherAgents.slice(3, 6);
  } else if (validatorAccess === 'rating') {
    minValidatorRating = 400;
  }

  const validationScriptCID = (validationMode === 0 || validationMode === 2)
    ? 'QmTestValidationScript_AWP_v1' : '';

  return {
    validationMode, submissionMode, submissionWindow,
    approvedWorkers, approvedValidators, openValidation,
    minWorkerRating, minValidatorRating,
    validationScriptCID,
    allowResubmission: submissionMode === 1,
    allowRejectAll: validationMode === 1 && submissionMode === 1,
  };
}

// ============================================================
// Translate config params → natural-language constraint bullets for the
// poster agent. Must be insider-info clean — no enum names, no scenario
// IDs, no "HARD_ONLY"-style strings.
// ============================================================
function configKeyToConstraints(key) {
  const [valMode, deadline, subMode, workerAccess, validatorAccess] = key.split('-');
  const lines = [];
  if (valMode === 'soft') lines.push('Reviewer judges by hand');
  else if (valMode === 'hard') lines.push('Automated script checks the submission');
  else if (valMode === 'hardsift') lines.push('Automated check first, then human review');

  if (subMode === 'single') lines.push('First valid submission wins the job');
  else if (subMode === 'multi') lines.push('Multiple workers can submit; reviewer picks the best');

  if (deadline === 'timed') lines.push('2-hour submission window');
  else lines.push('No submission deadline');

  if (workerAccess === 'open') lines.push('Any worker can take this');
  else if (workerAccess === 'approved') lines.push('Only specific workers you trust can take this');
  else if (workerAccess === 'rating') lines.push('Workers need a reputation score of at least 4.0');

  if (validatorAccess === 'open') lines.push('Any qualified reviewer can judge this');
  else if (validatorAccess === 'approved') lines.push('Only specific reviewers you trust');
  else if (validatorAccess === 'rating') lines.push('Reviewers need a reputation score of at least 4.0');

  return lines;
}

// ============================================================
// Clients
// ============================================================
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const walletFor = (agent) =>
  createWalletClient({ account: agent.account, chain: baseSepolia, transport: http(RPC) });

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const JOB_ABI = parseAbi([
  'function createJob(string title, string description, string requirementsJson, uint256 rewardAmount, bool openValidation, address[] approvedValidators, uint256 validatorTimeoutSeconds, uint256 claimWindowHours_, uint8 validationMode_, uint8 submissionMode_, uint256 submissionWindow_, string validationScriptCID_, bool requireSecurityAudit_, string securityAuditTemplate_, bool allowResubmission_, bool allowRejectAll_, address[] approvedWorkers_, string validationInstructions_, uint256 minWorkerRating_, uint256 minValidatorRating_) returns (uint256)',
]);

// ============================================================
// Main
// ============================================================

// 1. Pick a target scenario — round-robin through priority list so we hit
//    each empty scenario first a few times, then cycle the rest.
const scenarioIdx = cycleCount % SCENARIO_PRIORITY.length;
const targetScenario = SCENARIO_PRIORITY[scenarioIdx];
console.log(`[${RUN_ID}] cycle=${cycleCount} targeting scenario=${targetScenario}`);

// 2. Pick a compatible config. Prefer configs not yet heavily used.
const compatible = ALL_CONFIG_KEYS.filter(k => isScenarioCompatible(targetScenario, k));
if (compatible.length === 0) {
  console.log(`[${RUN_ID}] no configs compatible with ${targetScenario} — falling back to s01`);
  process.exit(0);
}
// Pick deterministically based on cycleCount for spread
const targetConfig = compatible[cycleCount % compatible.length];
console.log(`[${RUN_ID}] config=${targetConfig}`);

// 3. Pick posting agent (round-robin)
const poster = AGENTS[cycleCount % AGENTS.length];
console.log(`[${RUN_ID}] poster=${poster.name} (${poster.address})`);

// Emit scan row — scenario + config selection decision
await emitOrchestrationEvent({
  event_type: 'scan',
  persona: poster.name,
  reasoning: `selecting next job to post: scenario=${targetScenario}, config=${targetConfig}`,
  meta: { target_scenario: targetScenario, target_config: targetConfig, poster: poster.name, cycle: cycleCount },
});

// 4. Build params + ask the poster agent to name the job in their own voice
const params = configKeyToParams(targetConfig, poster);
const constraints = configKeyToConstraints(targetConfig);
const agentOut = await runAgent({
  persona: poster.name,
  taskType: 'create',
  context: {
    rewardUSDC: '5',
    constraints,
  },
});
const tpl = { title: agentOut.title, desc: agentOut.description };
if (agentOut.fell_back) {
  console.log(`[${RUN_ID}] agent-runner fell back on create for ${poster.name}`);
}

// Emit pre-create dispatch row
await emitOrchestrationEvent({
  event_type: 'dispatch',
  persona: poster.name,
  directive: `Post a new job with these constraints: ${constraints.join(' / ')}. Reward: 5 USDC.`,
  reasoning: 'round-robin poster + matrix-gap target',
  meta: { constraints, target_config: targetConfig, target_scenario: targetScenario, runner_fallback: !!agentOut.fell_back },
});

// 5. Requirements JSON (embed minRating here since contract only has one setter)
const requirementsJson = JSON.stringify({
  minWorkerRating: params.minWorkerRating,
  minValidatorRating: params.minValidatorRating,
  scenario: targetScenario,
  config: targetConfig,
});

// 6. Check USDC balance + approve
// Hoist the wallet client ONCE for this poster and reuse for all writes in
// the cycle. Creating a fresh walletClient per tx gives each its own
// in-memory nonce tracker, which races when approve + createJob share the
// same account (the createJob client's cached nonce doesn't know the
// approve just spent one). Single instance ⇒ viem refreshes via
// getTransactionCount correctly between writes.
const pwal = walletFor(poster);
const rewardUSDC = 5n * 10n ** 6n; // 5 USDC (6 decimals)
const bal = await pub.readContract({ address: MOCK_USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [poster.address] });
if (bal < rewardUSDC) {
  console.log(`[${RUN_ID}] poster ${poster.name} has insufficient USDC (${bal}) — needs ${rewardUSDC}. Skipping.`);
  await emitOrchestrationEvent({
    event_type: 'error',
    persona: poster.name,
    reasoning: `insufficient USDC balance: ${bal} < ${rewardUSDC}`,
    meta: { action: 'balance-check', balance: String(bal) },
  });
  process.exit(0);
}
const allow = await pub.readContract({ address: MOCK_USDC, abi: USDC_ABI, functionName: 'allowance', args: [poster.address, JOB_NFT] });
if (allow < rewardUSDC) {
  console.log(`[${RUN_ID}] approving USDC...`);
  const approveHash = await pwal.writeContract({
    address: MOCK_USDC, abi: USDC_ABI, functionName: 'approve',
    args: [JOB_NFT, 10_000n * 10n ** 6n], gas: 100_000n,
  });
  await pub.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 });
  console.log(`[${RUN_ID}] approve tx=${approveHash}`);
}

// 7. createJob
// V15 signature from JobNFT ABI (20 args — ratings moved to trailing positions,
// two new params: validatorTimeoutSeconds + claimWindowHours_ at positions 7-8):
//   createJob(title, description, requirementsJson, rewardAmount, openValidation,
//     approvedValidators, validatorTimeoutSeconds, claimWindowHours_,
//     validationMode_, submissionMode_, submissionWindow_, validationScriptCID_,
//     requireSecurityAudit_, securityAuditTemplate_, allowResubmission_,
//     allowRejectAll_, approvedWorkers_, validationInstructions_,
//     minWorkerRating_, minValidatorRating_)
const args = [
  tpl.title,
  tpl.desc,
  requirementsJson,
  rewardUSDC,
  params.openValidation,
  params.approvedValidators,
  0n,                           // validatorTimeoutSeconds (0 = contract default 2h)
  0n,                           // claimWindowHours_
  params.validationMode,
  params.submissionMode,
  BigInt(params.submissionWindow),
  params.validationScriptCID,
  false,                        // requireSecurityAudit_
  '',                           // securityAuditTemplate_
  params.allowResubmission,
  params.allowRejectAll,
  params.approvedWorkers,
  // validationInstructions_ — contract requires non-empty. Generic,
  // persona-agnostic note for any validator that picks up the job.
  // Revert reason when empty: "J: validation instructions required".
  'Judge the submission against the job description. Score 1-5 and briefly explain your rating.',
  BigInt(params.minWorkerRating),    // minWorkerRating_ (trailing in V15)
  BigInt(params.minValidatorRating), // minValidatorRating_ (trailing in V15)
];

let createdJobId = null;
try {
  const hash = await pwal.writeContract({
    address: JOB_NFT, abi: JOB_ABI, functionName: 'createJob', args, gas: 3_000_000n,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  console.log(`[${RUN_ID}] createJob tx=${hash} status=${rcpt.status} block=${rcpt.blockNumber}`);
  if (rcpt.status !== 'success') {
    console.log(`[${RUN_ID}] createJob reverted`);
    await emitOrchestrationEvent({
      event_type: 'error',
      persona: poster.name,
      reasoning: 'createJob tx reverted',
      meta: { action: 'createJob', tx_hash: hash },
    });
    process.exit(1);
  }
  // Parse the JobCreated event from logs to get the token id
  const JOB_CREATED_TOPIC = '0x'; // we'll find from logs
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() === JOB_NFT.toLowerCase() && log.topics.length >= 2) {
      // First indexed param is jobId (uint256) in JobCreated event
      const topic = log.topics[1];
      if (topic && topic !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        createdJobId = parseInt(topic, 16);
        break;
      }
    }
  }
  if (!createdJobId) {
    // Fallback: read jobCount and assume latest
    const jc = await pub.readContract({
      address: JOB_NFT, abi: parseAbi(['function jobCount() view returns (uint256)']),
      functionName: 'jobCount', args: [],
    });
    createdJobId = Number(jc) - 1;
  }
  console.log(`[${RUN_ID}] created jobId=${createdJobId}`);

  // Emit post-create dispatch row with tx_hash + job_id
  await emitOrchestrationEvent({
    event_type: 'dispatch',
    persona: poster.name,
    job_id: createdJobId,
    directive: `Posted job #${createdJobId}: "${tpl.title}"`,
    reasoning: 'create tx landed',
    tx_hash: hash,
    meta: { action: 'createJob', target_config: targetConfig, target_scenario: targetScenario, receipt_status: rcpt.status, block: Number(rcpt.blockNumber), agent_fell_back: !!agentOut.fell_back },
  });

} catch (e) {
  console.log(`[${RUN_ID}] createJob FAILED: ${e.shortMessage || e.message?.slice(0, 300)}`);
  await emitOrchestrationEvent({
    event_type: 'error',
    persona: poster.name,
    reasoning: `createJob failed: ${e.shortMessage || e.message?.slice(0,200)}`,
    meta: { action: 'createJob', error: String(e.shortMessage || e.message).slice(0,500) },
  });
  process.exit(1);
}

// 8. Annotate intended-scenarios.json
let scenarios = {};
try {
  if (existsSync(SCENARIOS_FILE)) scenarios = JSON.parse(readFileSync(SCENARIOS_FILE, 'utf8'));
} catch {}
scenarios[String(createdJobId)] = targetScenario;
writeFileSync(SCENARIOS_FILE, JSON.stringify(scenarios, null, 2));

appendFileSync('/var/log/awp-create.log',
  `[${RUN_ID}] cycle=${cycleCount} jobId=${createdJobId} config=${targetConfig} scenario=${targetScenario} poster=${poster.name}\n`);

console.log(`[${RUN_ID}] DONE — annotated job #${createdJobId} as ${targetScenario}`);

await emitHeartbeat(
  'swarm-create',
  1,
  `created job #${createdJobId}`,
  { jobId: createdJobId, agent_fell_back: !!agentOut.fell_back }
);

process.exit(0);
