#!/usr/bin/env node
/**
 * framework/hlo-daemon.mjs — STS Phase A Human-Like Orchestrator
 *
 * Long-running Node daemon (no LLM) that drives the AWP test swarm by
 * dispatching natural-language tasks to 7 blank OpenClaw agents. The daemon
 * decides what action moves coverage forward, picks an eligible agent, and
 * verifies on-chain afterward. Intent is recorded privately in
 * orchestration_events.meta — never on-chain.
 *
 * Source-of-truth: lib/awp/* (compiled to lib/awp/*.js via `npm run build:lib`).
 *
 * Per SWARM-V2-DESIGN.md section 2 Layer 1:
 *   - 30s tick interval
 *   - Decision priority A=unblock_agent, B=progress_stuck_job,
 *                       C=create_in_untested_cell, D=idle
 *   - Eligibility filter via lib/awp/rules.checkAgentEligibility
 *   - Dispatch message NEVER references scenarios/configs/test-vocab
 *     (assertInsiderInfoClean throws if it does — refusing to dispatch)
 *   - On-chain verification AFTER agent reports done (HLO never trusts the
 *     agent's self-report; it reads the chain to confirm)
 *
 * Usage:  node framework/hlo-daemon.mjs [--dry-run] [--once] [--tick-ms <N>]
 *
 *   --dry-run   Don't actually dispatch (just log) and don't write to STS.
 *   --once      Run a single tick then exit (smoke test).
 *   --tick-ms   Tick interval (default 30000).
 *
 * Required env on VPS:
 *   AWP_JOBNFT, AWP_RG, AWP_DEPLOY_BLOCK, ALCHEMY_RPC
 *   STS_SUPABASE_URL, STS_SUPABASE_KEY
 *   HLO_DISPATCH_MODE        "dryrun" | "http"  (default: dryrun)
 *   OPENCLAW_GATEWAY_URL     when HLO_DISPATCH_MODE=http
 *   OPENCLAW_GATEWAY_TOKEN   bearer token for the gateway
 */
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';

import {
  CONTRACT_ADDRESSES,
  ALL_CONFIGS,
  CLASSIFIABLE_SCENARIO_IDS,
  parseConfigKey,
  configToParams,
  isCellApplicable,
  checkAgentEligibility,
} from '../lib/awp/index.js';
import { assertInsiderInfoClean, findInsiderInfoLeaks } from '../lib/insider-info-regex.js';

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────
const ALCHEMY_RPC = process.env.ALCHEMY_RPC
  || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';
const JOBNFT_V15 = process.env.AWP_JOBNFT  || CONTRACT_ADDRESSES.JobNFT;
const REVIEWGATE = process.env.AWP_RG      || CONTRACT_ADDRESSES.ReviewGate;
const USDC_ADDR  = CONTRACT_ADDRESSES.MockUSDC;

const STS_URL = process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
const STS_KEY = process.env.STS_SUPABASE_KEY;

const ARGV = process.argv;
const DRY_RUN = ARGV.includes('--dry-run');
const RUN_ONCE = ARGV.includes('--once');
const TICK_MS = parseInt(argVal('--tick-ms', '30000'));
// Dispatch mode env: prefer DISPATCH_MODE (Phase-A-naming), accept legacy
// HLO_DISPATCH_MODE for backwards compat. Defaults to dryrun.
const DISPATCH_MODE = process.env.DISPATCH_MODE || process.env.HLO_DISPATCH_MODE || (DRY_RUN ? 'dryrun' : 'dryrun');
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || '';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
// Path to openclaw CLI binary on this host. Defaults to the standard npm
// shim install path on Windows; override via OPENCLAW_CLI_PATH for other
// install locations or non-Windows hosts (where it's typically just `openclaw`).
const OPENCLAW_CLI_PATH = process.env.OPENCLAW_CLI_PATH
  || (process.platform === 'win32'
        ? 'C:\\Users\\isaia\\AppData\\Roaming\\npm\\openclaw.cmd'
        : 'openclaw');

// 7 swarm agents (last-4-of-wallet naming).
// Spark was rotated 2026-04-26: agent-36ce (OLD 0x35bd...36CE) → agent-55a8 (NEW 0xb255...55a8).
// Other agents inherit their addresses from the prior persona-named workspaces (Grind/Judge/etc.).
// agent-c8e4 = permanent newbie — MEMORY.md auto-wiped after every dispatch (A.4 hook).
const AGENTS = [
  { name: 'agent-55a8', wallet: '0xb255Be63FaA790b3616De39fBdCc45D26d4455a8' }, // NEW Spark
  { name: 'agent-3100', wallet: '0xd318DedfFfa5616e1c9Fb7080d02d03cC8D33100' }, // Grind
  { name: 'agent-5044', wallet: '0xB0c19176E7477bf8B035e349d698a897eBE05044' }, // Judge
  { name: 'agent-98c5', wallet: '0xe62796e71dE1Ff0DA3b95e596a6a16307BF198c5' }, // Chaos
  { name: 'agent-d4a8', wallet: '0xD19306b699AF464b62fbBA03f34aF7b2f57cd4A8' }, // Scout
  { name: 'agent-01f1', wallet: '0xd924618566108628224162045cd65f6bb09201F1' }, // Flash
  { name: 'agent-c8e4', wallet: '0xd547345c4b85B750056Cda193357Bc4Af1c9c8E4' }, // Bridge — permanent newbie
];

const ZERO = '0x0000000000000000000000000000000000000000';

const pub = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_RPC) });

const JOB_ABI = parseAbi([
  'function jobCount() view returns (uint256)',
  'function getSubmissionCount(uint256) view returns (uint256)',
  'function getJobV15(uint256 jobId) view returns (address poster,uint256 reward,uint8 status,address activeValidator,address[] validatorWaitlist,uint256 validatorTimeout,bool openValidation,string title,string description,string requirementsJson,uint256 claimWindowHours,uint8 validationMode,uint8 submissionMode,uint256 submissionWindow,string validationScriptCID,bool requireSecurityAudit,string securityAuditTemplate,uint256 submissionDeadline,bool allowResubmission,bool allowRejectAll,address[] approvedWorkers,string validationInstructions,uint256 minWorkerRating,uint256 minValidatorRating)',
  // Phase H — direct dispatch path for create_job (bypasses OpenClaw CLI)
  'function createJob(string title, string description, string requirementsJson, uint256 rewardAmount, bool openValidation, address[] approvedValidators, uint256 validatorTimeoutSeconds, uint256 claimWindowHours_, uint8 validationMode_, uint8 submissionMode_, uint256 submissionWindow_, string validationScriptCID_, bool requireSecurityAudit_, string securityAuditTemplate_, bool allowResubmission_, bool allowRejectAll_, address[] approvedWorkers_, string validationInstructions_, uint256 minWorkerRating_, uint256 minValidatorRating_) returns (uint256)',
]);
const RG_ABI = parseAbi([
  'function getPendingReviewCount(address) view returns (uint256)',
  'function getAgentRating(address) view returns (uint256 ratingBps, uint256 reviewCount)',
  'function getRemainingPerJob(uint256, address) view returns (uint256)',
]);
const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const MOCK_USDC = CONTRACT_ADDRESSES.MockUSDC;
// File written by HLO direct-dispatch + read by swarm-drain on the VPS to
// know each job's intended scenario. Path is VPS-local; on Windows the
// writes are best-effort (swarm-drain reads from VPS regardless).
const SCENARIOS_FILE = process.env.AWP_SCENARIOS_FILE || '/root/test-swarm/intended-scenarios.json';

// ─────────────────────────────────────────────────────────────────
// Phase H — direct viem dispatch for create_job
// ─────────────────────────────────────────────────────────────────
// Loads each agent's private key (env first, IDENTITY.md fallback), keyed
// by lowercase wallet address. Agents missing a key still participate in
// HLO's read-side decisions (eligibility, etc.) but skip direct-dispatch.
const AGENT_ACCOUNTS = new Map();

function loadAgentKeys() {
  for (let i = 0; i < AGENTS.length; i++) {
    const agent = AGENTS[i];
    const last4 = agent.name.slice(-4); // e.g. "55a8"
    const last4Upper = last4.toUpperCase();
    // Existing Windows .env convention is AGENT_<LAST4>_PRIVATE_KEY; AWP-side
    // env (./awp-env) historically used AGENT_<LAST4>_PK. Accept either.
    let pk =
      process.env[`AGENT_${last4Upper}_PRIVATE_KEY`] ||
      process.env[`AGENT_${last4Upper}_PK`];

    // VPS fallback — swarm-create.mjs convention. No-op on Windows where
    // /root/test-swarm/agent-N/IDENTITY.md doesn't exist.
    if (!pk) {
      const idPath = `/root/test-swarm/agent-${i + 1}/IDENTITY.md`;
      try {
        if (existsSync(idPath)) {
          const raw = readFileSync(idPath, 'utf8');
          const m = raw.match(/Private Key:\s*(0x[a-fA-F0-9]{64})/);
          if (m) pk = m[1];
        }
      } catch { /* file unreadable, skip */ }
    }

    if (!pk) {
      console.log(`[hlo] no private key for ${agent.name} (set AGENT_${last4Upper}_PRIVATE_KEY or AGENT_${last4Upper}_PK)`);
      continue;
    }
    let account;
    try { account = privateKeyToAccount(pk); }
    catch (e) {
      console.log(`[hlo] ${agent.name}: invalid private key (${e.message})`);
      continue;
    }
    if (account.address.toLowerCase() !== agent.wallet.toLowerCase()) {
      console.log(`[hlo] ${agent.name}: PK derives to ${account.address} but configured wallet is ${agent.wallet} — skipping`);
      continue;
    }
    AGENT_ACCOUNTS.set(agent.wallet.toLowerCase(), account);
  }
  console.log(`[hlo] loaded ${AGENT_ACCOUNTS.size}/${AGENTS.length} agent private keys for direct dispatch`);
}

// configKey → createJob params (mirrors swarm-create.mjs's configKeyToParams)
function configKeyToCreateJobParams(key, posterAddress) {
  const [valMode, deadline, subMode, workerAccess, validatorAccess] = key.split('-');
  const otherAgents = AGENTS.map(a => a.wallet)
    .filter(a => a.toLowerCase() !== posterAddress.toLowerCase());

  const validationMode = valMode === 'soft' ? 1 : valMode === 'hard' ? 0 : 2;
  const submissionMode = subMode === 'multi' ? 1 : 0;
  // submissionWindow is the MULTI-mode resubmission window — contract
  // requires it nonzero whenever submissionMode==1, regardless of the
  // `deadline` axis. Mirrors swarm-create.mjs verbatim. (Previous attempt
  // tied this to deadline and got 5/7 simulate reverts on multi-* cells.)
  const submissionWindow = submissionMode === 1 ? 7200 : 0;

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

  const validationScriptCID =
    (validationMode === 0 || validationMode === 2) ? 'QmTestValidationScript_AWP_v1' : '';

  return {
    validationMode, submissionMode, submissionWindow,
    approvedWorkers, approvedValidators, openValidation,
    minWorkerRating, minValidatorRating,
    validationScriptCID,
    allowResubmission: submissionMode === 1,
    allowRejectAll: validationMode === 1 && submissionMode === 1,
  };
}

// Persona-agnostic, deterministic title/description so we don't need an LLM
// in the dispatch path. The TOPIC_BANK already lives below; we just template
// around it. Kept short enough to fit any title<80-char rule the contract
// enforces.
function makeJobTitleAndDesc(topic, constraintBullets) {
  const title = `Task: ${topic}`.slice(0, 79);
  const constraintLine = constraintBullets.length
    ? ` Constraints: ${constraintBullets.join('; ')}.`
    : '';
  const desc = (
    `Produce ${topic}. Reward 5 USDC.` + constraintLine +
    ' Submit deliverable URL when ready.'
  ).slice(0, 1500);
  return { title, desc };
}

function configKeyToConstraints(key) {
  const [valMode, deadline, subMode, workerAccess, validatorAccess] = key.split('-');
  const lines = [];
  if (valMode === 'soft') lines.push('reviewer judges by hand');
  else if (valMode === 'hard') lines.push('automated script checks the submission');
  else if (valMode === 'hardsift') lines.push('automated check first then human review');
  if (subMode === 'single') lines.push('first valid submission wins');
  else if (subMode === 'multi') lines.push('multiple workers can submit; reviewer picks one');
  if (deadline === 'timed') lines.push('2-hour submission window');
  if (workerAccess === 'approved') lines.push('approved workers only');
  else if (workerAccess === 'rating') lines.push('worker reputation >= 4.0 required');
  if (validatorAccess === 'approved') lines.push('approved reviewers only');
  else if (validatorAccess === 'rating') lines.push('reviewer reputation >= 4.0 required');
  return lines;
}

// Annotate /root/test-swarm/intended-scenarios.json so swarm-drain can walk
// the new job through its target scenario. On Windows this is a best-effort
// write to a path that probably doesn't exist; harmless. On VPS deploys this
// is the canonical mechanism (matches swarm-create.mjs).
function annotateScenario(jobId, scenarioId) {
  try {
    let scenarios = {};
    if (existsSync(SCENARIOS_FILE)) {
      try { scenarios = JSON.parse(readFileSync(SCENARIOS_FILE, 'utf8')); } catch {}
    }
    scenarios[String(jobId)] = scenarioId;
    writeFileSync(SCENARIOS_FILE, JSON.stringify(scenarios, null, 2));
  } catch (e) {
    // Path likely doesn't exist on this host (Windows); fine.
    if (process.env.HLO_LOG_LEVEL === 'debug') {
      console.log(`[hlo] scenarios annotation skipped: ${e.message?.slice(0, 80)}`);
    }
  }
}

const REWARD_USDC_AMOUNT = 5n * 10n ** 6n; // 5 USDC, 6 decimals

// Direct viem dispatch for create_job. No CLI, no LLM, no agent process.
// Pure on-chain post: simulate → (approve if needed) → createJob → parse
// JobCreated event for jobId. Returns { ok, jobId?, txHash?, error? }.
async function dispatchCreateJobDirect(action) {
  const agent = action.agent.agent;
  const account = AGENT_ACCOUNTS.get(agent.wallet.toLowerCase());
  if (!account) {
    return { ok: false, error: `no private key loaded for ${agent.name}` };
  }
  if (action.kind !== 'create_job') {
    return { ok: false, error: `direct dispatch only supports create_job (got ${action.kind})` };
  }

  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(ALCHEMY_RPC) });
  const params = configKeyToCreateJobParams(action.configKey, agent.wallet);

  // USDC balance / allowance (5 USDC reward)
  let bal;
  try {
    bal = await pub.readContract({ address: MOCK_USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [agent.wallet] });
  } catch (e) {
    return { ok: false, error: `usdc.balanceOf failed: ${e.shortMessage || e.message?.slice(0, 200)}` };
  }
  if (bal < REWARD_USDC_AMOUNT) {
    return { ok: false, error: `insufficient USDC: have ${bal}, need ${REWARD_USDC_AMOUNT}` };
  }

  let allow;
  try {
    allow = await pub.readContract({ address: MOCK_USDC, abi: USDC_ABI, functionName: 'allowance', args: [agent.wallet, JOBNFT_V15] });
  } catch (e) {
    return { ok: false, error: `usdc.allowance failed: ${e.shortMessage || e.message?.slice(0, 200)}` };
  }
  if (allow < REWARD_USDC_AMOUNT) {
    try {
      const approveHash = await wallet.writeContract({
        address: MOCK_USDC, abi: USDC_ABI, functionName: 'approve',
        args: [JOBNFT_V15, 10_000n * 10n ** 6n], gas: 100_000n,
      });
      await pub.waitForTransactionReceipt({ hash: approveHash, timeout: 60_000 });
    } catch (e) {
      return { ok: false, error: `usdc.approve failed: ${e.shortMessage || e.message?.slice(0, 200)}` };
    }
  }

  // Build createJob args (V15 ABI — 20 args, ratings trailing)
  const constraints = configKeyToConstraints(action.configKey);
  const topic = TOPIC_BANK[Math.floor(Math.random() * TOPIC_BANK.length)];
  const { title, desc } = makeJobTitleAndDesc(topic, constraints);

  const requirementsJson = JSON.stringify({
    minWorkerRating: params.minWorkerRating,
    minValidatorRating: params.minValidatorRating,
    scenario: action.scenarioId,
    config: action.configKey,
  });

  const args = [
    title, desc, requirementsJson, REWARD_USDC_AMOUNT,
    params.openValidation, params.approvedValidators,
    0n, 0n, // validatorTimeoutSeconds, claimWindowHours_ (contract defaults)
    params.validationMode, params.submissionMode, BigInt(params.submissionWindow),
    params.validationScriptCID,
    false, '', // requireSecurityAudit_, securityAuditTemplate_
    params.allowResubmission, params.allowRejectAll,
    params.approvedWorkers,
    'Judge the submission against the job description. Score 1-5 and briefly explain your rating.',
    BigInt(params.minWorkerRating),
    BigInt(params.minValidatorRating),
  ];

  // Simulate first — abort cleanly on revert without spending gas
  try {
    await pub.simulateContract({ address: JOBNFT_V15, abi: JOB_ABI, functionName: 'createJob', args, account });
  } catch (e) {
    return { ok: false, error: `simulate revert: ${e.shortMessage || e.message?.slice(0, 200)}` };
  }

  let hash;
  try {
    hash = await wallet.writeContract({
      address: JOBNFT_V15, abi: JOB_ABI, functionName: 'createJob', args, gas: 3_000_000n,
    });
  } catch (e) {
    return { ok: false, error: `writeContract failed: ${e.shortMessage || e.message?.slice(0, 200)}` };
  }

  let rcpt;
  try {
    rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  } catch (e) {
    return { ok: false, error: `receipt wait failed: ${e.message?.slice(0, 200)}`, txHash: hash };
  }
  if (rcpt.status !== 'success') {
    return { ok: false, error: `tx reverted (status=${rcpt.status})`, txHash: hash };
  }

  // Parse JobCreated event topic for jobId (first indexed param after topic[0]).
  let jobId = null;
  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() === JOBNFT_V15.toLowerCase() && log.topics.length >= 2) {
      const topic = log.topics[1];
      if (topic && topic !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        jobId = parseInt(topic, 16);
        break;
      }
    }
  }
  if (jobId == null) {
    // Fallback: read jobCount post-tx — not perfectly attribution-safe under
    // parallel posts but better than nothing.
    try {
      const jc = await pub.readContract({ address: JOBNFT_V15, abi: JOB_ABI, functionName: 'jobCount' });
      jobId = Number(jc) - 1;
    } catch { /* leave null */ }
  }

  if (jobId != null && action.scenarioId) {
    annotateScenario(jobId, action.scenarioId);
  }

  return {
    ok: true,
    jobId,
    txHash: hash,
    blockNumber: Number(rcpt.blockNumber),
    title, // for log lines downstream
  };
}

// ─────────────────────────────────────────────────────────────────
// argv helper (same shape as scanner.mjs)
// ─────────────────────────────────────────────────────────────────
function argVal(flag, def) {
  const i = ARGV.indexOf(flag);
  return (i >= 0 && i + 1 < ARGV.length) ? ARGV[i + 1] : def;
}

// ─────────────────────────────────────────────────────────────────
// On-chain reads
// ─────────────────────────────────────────────────────────────────
async function readAgentSnapshot(agent) {
  const [ethBal, usdcBal, pendingRev, ratingPair] = await Promise.all([
    pub.getBalance({ address: agent.wallet }),
    pub.readContract({ address: USDC_ADDR, abi: USDC_ABI, functionName: 'balanceOf', args: [agent.wallet] }),
    pub.readContract({ address: REVIEWGATE, abi: RG_ABI, functionName: 'getPendingReviewCount', args: [agent.wallet] }),
    pub.readContract({ address: REVIEWGATE, abi: RG_ABI, functionName: 'getAgentRating', args: [agent.wallet] }),
  ]);
  return {
    address: agent.wallet,
    ethWei: ethBal,
    usdcMicros: usdcBal,
    pendingReviewCount: Number(pendingRev),
    ratingBps: Number(ratingPair[0]),
    reviewCount: Number(ratingPair[1]),
  };
}

async function readJobSnapshot(jobId) {
  try {
    const r = await pub.readContract({ address: JOBNFT_V15, abi: JOB_ABI, functionName: 'getJobV15', args: [BigInt(jobId)] });
    return {
      jobId,
      poster: r[0],
      status: Number(r[2]),
      activeValidator: r[3],
      validatorWaitlist: r[4],
      validationMode: Number(r[11]),
      submissionMode: Number(r[12]),
      submissionWindow: Number(r[13]),
      submissionDeadline: Number(r[17]),
      allowResubmission: r[18],
      allowRejectAll: r[19],
      approvedWorkers: r[20],
      approvedValidators: [], // not in V15 getter; HLO can read job.approvedValidators via mapping if needed
      openValidation: r[6],
      minWorkerRating: Number(r[22]),
      minValidatorRating: Number(r[23]),
      title: r[7],
    };
  } catch (e) {
    return null;
  }
}

async function readJobCount() {
  return Number(await pub.readContract({ address: JOBNFT_V15, abi: JOB_ABI, functionName: 'jobCount' }));
}

async function readMatrixCoverage() {
  if (!STS_KEY) return new Map(); // dashboard not reachable; HLO falls back to greedy
  try {
    const r = await fetch(`${STS_URL}/rest/v1/lifecycle_results?project_id=eq.awp&select=config_key,scenario_key,status&limit=2000`, {
      headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` }
    });
    if (!r.ok) return new Map();
    const rows = await r.json();
    const map = new Map();
    for (const row of rows) {
      const key = `${row.config_key}|${row.scenario_key}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row.status);
    }
    return map;
  } catch { return new Map(); }
}

async function readRecentDispatches(minutes = 30) {
  if (!STS_KEY) return [];
  try {
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const r = await fetch(`${STS_URL}/rest/v1/orchestration_events?project_id=eq.awp&created_at=gte.${since}&select=*&limit=200`, {
      headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` }
    });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

/**
 * GAP 2 fix: returns Set of "config|scenario" cells where HLO emitted
 * a `lifecycle=verified` orchestration_events row in the last `minutes`
 * minutes. The matrix coverage map only refreshes when the scanner runs
 * (~every 15 min), so without this exclusion the daemon picks the same
 * cell on every 30s tick until the scanner catches up. Set defaults to
 * 30 min — long enough to bridge a scanner gap, short enough that we
 * keep retrying after legitimate failures.
 */
async function readRecentlyDispatchedCells(minutes = 30) {
  if (!STS_KEY) return new Set();
  try {
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    const r = await fetch(
      `${STS_URL}/rest/v1/orchestration_events?project_id=eq.awp` +
      `&source=eq.hlo-daemon&ran_at=gte.${since}` +
      `&select=meta&limit=500`,
      { headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` } }
    );
    if (!r.ok) return new Set();
    const rows = await r.json();
    const set = new Set();
    for (const row of rows) {
      const m = row.meta || {};
      // Only count cells that we actually verified — requested-but-failed
      // shouldn't block re-attempts.
      if (m.lifecycle === 'verified' && m.intended_config && m.intended_scenario) {
        set.add(`${m.intended_config}|${m.intended_scenario}`);
      }
    }
    return set;
  } catch { return new Set(); }
}

// ─────────────────────────────────────────────────────────────────
// Decision algorithm (priorities A → D)
// ─────────────────────────────────────────────────────────────────
//
// Phase G adds steering: scripts/matrix-steering.mjs (VPS cron */15) computes
// under-covered cells from lifecycle_results and writes the top ~200 to a
// system_heartbeats row with component=matrix-steering. HLO pulls that row
// each tick and prefers a randomized pick from the top-50 most under-covered
// cells; only when steering data is missing/stale does it fall back to the
// pre-G greedy ALL_CONFIGS rotation.
//
// Steering is what gets us off "soft-open-single-open-open" hill-climb and
// into the harder cells (rating-gates, hardsift validation, timed deadlines).
const STEERING_FRESH_MIN = 30; // minutes; older payloads are ignored
const STEERED_TOP_LIMIT = 50;   // pick uniformly at random from top-N gaps
// Parallel-tick concurrency cap. Phase H bypasses the OpenClaw CLI for
// create_job (which was the bottleneck — gateway serialized parallel cli
// invocations and 6/7 timed out at 10min). With direct viem dispatch each
// agent posts on its own RPC connection, so 7-wide parallel is safe.
// Tunable via env if a future bottleneck (RPC rate limits, mempool, etc.)
// shows up.
const HLO_PARALLEL_LIMIT = Math.max(1, parseInt(process.env.HLO_PARALLEL_LIMIT || '7', 10));

async function readTargetGaps() {
  if (!STS_KEY) return null;
  try {
    const r = await fetch(
      `${STS_URL}/rest/v1/system_heartbeats?project_id=eq.awp` +
      `&component=eq.matrix-steering&order=ran_at.desc&limit=1`,
      { headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows.length) return null;
    const row = rows[0];
    const ageMs = Date.now() - new Date(row.ran_at).getTime();
    if (ageMs > STEERING_FRESH_MIN * 60_000) return null;
    return row.meta || null;
  } catch { return null; }
}

// Phase I — sample N cells WITHOUT replacement from the top-50 under-covered.
// Pre-I pickSteeredCell was called once per agent in a loop with a usedCells
// Set check, which worked but relied on the caller to thread state correctly.
// This shuffle-once-take-N pattern guarantees uniqueness within a tick by
// construction. Returns up to `count` cells; fewer if the available pool is
// smaller after exclusions.
//
// We deliberately do NOT re-apply the recentlyDispatched / coverage filters
// here — steering itself already excludes any cell with a passed lifecycle
// row OR an HLO dispatch in the last 6 hours (matrix-steering.mjs builds
// inFlightCells from orchestration_events). Re-filtering here would shrink
// the available pool to near zero once HLO has been running for a few
// minutes (every cell in the gaps list would also be in recentlyDispatched).
function pickSteeredCellsForTick(gaps, count) {
  if (!gaps || !Array.isArray(gaps.underCoveredCells) || !gaps.underCoveredCells.length) return [];
  const avail = gaps.underCoveredCells.slice(0, STEERED_TOP_LIMIT);
  // Fisher-Yates shuffle — equal prob over the available top-50, no repeats.
  const shuffled = avail.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const out = [];
  for (const c of shuffled.slice(0, count)) {
    let params;
    try { params = parseConfigKey(c.config_key); } catch { continue; }
    out.push({ configKey: c.config_key, scenarioId: c.scenario_id, params });
  }
  return out;
}

// GAP 2 fix (2026-04-27): pickUntestedCell takes an additional
// `recentlyDispatched` Set of "config|scenario" keys for cells where HLO
// already verified a dispatch in the last ~30 min. The matrix-coverage map
// only updates when the scanner runs (every 15 min), so without this
// exclusion the daemon re-picks the same cell for every tick in the window
// between the dispatch and the next scanner run. Caller (tick) builds the
// set from orchestration_events.
//
// Phase G: also takes `usedCells` so parallel-tick posts don't all collide
// on the same cell. First applicable cell not in any exclude set wins.
function pickUntestedCell(coverage, recentlyDispatched, agentSnapshots, usedCells) {
  for (const cfg of ALL_CONFIGS) {
    const params = parseConfigKey(cfg);
    for (const sid of CLASSIFIABLE_SCENARIO_IDS) {
      if (!isCellApplicable(params, sid)) continue;
      const key = `${cfg}|${sid}`;
      // Exclude if scanner has classified it OR HLO has just dispatched it
      // OR another action already claimed it in this same tick.
      const states = coverage.get(key) || [];
      const hasCoverage = states.some(s => s === 'passed' || s === 'running');
      if (hasCoverage) continue;
      if (recentlyDispatched && recentlyDispatched.has(key)) continue;
      if (usedCells && usedCells.has(key)) continue;
      return { configKey: cfg, scenarioId: sid, params };
    }
  }
  return null;
}

// GAP 1 fix (2026-04-27): round-robin counter so successive priority-C
// dispatches walk through all 7 agents instead of always sending to the
// first eligible one (which was always agent-55a8). Counter persists for
// the lifetime of the daemon process; resets on restart, which is fine —
// rotation pattern doesn't need to be cross-restart deterministic.
let posterRotationIndex = 0;

function pickPosterAgent(params, agentSnapshots) {
  // Eligible to create a job if has USDC + low pending reviews + ETH for gas.
  // For configs with workerAccess=approved or validatorAccess=approved, the
  // poster's not in either of those lists, so any agent works.
  const n = agentSnapshots.length;
  for (let i = 0; i < n; i++) {
    const idx = (posterRotationIndex + i) % n;
    const a = agentSnapshots[idx];
    const elig = checkAgentEligibility(a.snapshot, null, 'create_job');
    if (!elig.eligible) continue;
    // Need USDC ≥ a small reward (5 USDC = 5_000_000 micros)
    if (a.snapshot.usdcMicros < 5_000_000n) continue;
    // Advance the rotation cursor PAST the picked agent so the next call
    // starts at the agent after this one. Skipped agents stay first in line.
    posterRotationIndex = (idx + 1) % n;
    return a;
  }
  return null;
}

function decideNextAction({ jobs, agentSnapshots, coverage, recentlyDispatched }) {
  // Priority A — unblock any agent at pending-review cap
  for (const a of agentSnapshots) {
    if (a.snapshot.pendingReviewCount >= 5) {
      return {
        kind: 'submit_review',
        priority: 'A',
        agent: a,
        reason: `agent ${a.agent.name} is at review cap (${a.snapshot.pendingReviewCount}/5)`,
      };
    }
  }

  // Priority B — progress a stuck job (in-flight that hasn't moved in 30+ min)
  // Stub: the matrix-audit cron handles this today. Phase A v1 falls through.
  // (Future: read orchestration_events meta.last_activity per job and pick
  // jobs where deadline has passed without a finalize step.)

  // Priority C — create a new job in an untested cell
  const cell = pickUntestedCell(coverage, recentlyDispatched, agentSnapshots);
  if (cell) {
    const poster = pickPosterAgent(cell.params, agentSnapshots);
    if (!poster) {
      return { kind: 'idle', priority: 'D', reason: `no eligible poster for untested cell ${cell.configKey}|${cell.scenarioId}` };
    }
    return {
      kind: 'create_job',
      priority: 'C',
      agent: poster,
      configKey: cell.configKey,
      scenarioId: cell.scenarioId,
      params: cell.params,
      reason: `untested cell: ${cell.configKey} → ${cell.scenarioId}`,
    };
  }

  // Priority D — idle
  return { kind: 'idle', priority: 'D', reason: 'no actions worth dispatching this tick' };
}

// ─────────────────────────────────────────────────────────────────
// Dispatch message generation — natural language ONLY, insider-clean
// ─────────────────────────────────────────────────────────────────
const TOPIC_BANK = [
  'a 200-word essay summarizing one Bitcoin scaling proposal',
  'a markdown outline for a beginner Solidity tutorial',
  'a 5-question multiple-choice quiz on EVM gas costs',
  'a brief comparison of three popular Layer-2 networks',
  'a sample privacy policy for a hobby web app',
  'a 300-word product page for a fictional dev tool',
  'a one-page game design doc for a 2D platformer',
  'a research note on three open-source vector databases',
  'a quick tutorial outline for fine-tuning a small LLM',
];

function generateDispatchMessage(action) {
  if (action.kind === 'create_job') {
    const params = action.params;
    const reward = 5; // USDC; small to limit blast radius during Phase A bring-up

    // Build human description without leaking config/scenario internals.
    const constraints = [];
    if (params.subMode === 'multi') constraints.push('Allow multiple submissions on the same job.');
    if (params.deadline === 'timed') constraints.push('Set a 2-hour submission window.');
    if (params.workerAccess === 'approved') constraints.push('Restrict workers to a small allowlist (you pick three agent addresses).');
    if (params.validatorAccess === 'approved') constraints.push('Restrict validators to a small allowlist (you pick three agent addresses).');
    if (params.workerAccess === 'rating') constraints.push('Require workers to have at least a 4.0-star average rating with 3 or more prior reviews.');
    if (params.validatorAccess === 'rating') constraints.push('Require validators to have at least a 4.0-star average rating with 3 or more prior reviews.');
    if (params.valMode === 'hard') constraints.push('Use the platform\'s automated-script validation only — no human reviewer.');
    if (params.valMode === 'hardsift') constraints.push('Use the platform\'s automated script as a first pass, then a human reviewer to confirm.');
    if (params.allowRejectAll) constraints.push('Allow the reviewer to mass-reject submissions.');

    const topic = TOPIC_BANK[Math.floor(Math.random() * TOPIC_BANK.length)];
    const lines = [
      `Post a new job on the AgentWork Protocol. Reward: ${reward} USDC.`,
      `Goal: ${topic}.`,
      ...constraints,
      `Choose your own title (under 80 characters) and a 2-3 sentence description ` +
      `that another agent could act on. Use the AWP MCP server or raw viem; the platform docs ` +
      `at https://agentwork-protocol-puce.vercel.app/agent-docs explain the action surface.`,
      `Reply when the job is posted; include the job ID and the tx hash.`,
    ];
    return lines.filter(Boolean).join(' ');
  }

  if (action.kind === 'submit_review') {
    return (
      `You have pending reviews on the AgentWork Protocol — currently ` +
      `${action.agent.snapshot.pendingReviewCount} are blocking you from other actions. ` +
      `Visit the platform docs at https://agentwork-protocol-puce.vercel.app/agent-docs ` +
      `to find your assigned review pairs and submit a 1-5 star review for each. ` +
      `Reply with the tx hashes once cleared.`
    );
  }

  // Stubs for future priorities
  return `Idle.`;
}

// ─────────────────────────────────────────────────────────────────
// Dispatch transport
// ─────────────────────────────────────────────────────────────────
async function dispatchToAgent(agent, message, timeoutMin = 10) {
  if (DISPATCH_MODE === 'dryrun') {
    console.log(`  [DRY DISPATCH → ${agent.name}] ${message.slice(0, 200)}${message.length > 200 ? '...' : ''}`);
    return { ok: true, mode: 'dryrun', taskId: `dry-${Date.now()}`, exitCode: 0, output: '' };
  }

  if (DISPATCH_MODE === 'cli') {
    // Shell out to local OpenClaw CLI. Requires `openclaw` in PATH on the
    // host running this daemon — works from Cowork (Windows) where the CLI
    // is installed; not yet deployed for VPS until a Tailscale-funnel for
    // the local gateway is wired or the daemon is moved to the gateway host.
    const { spawn } = await import('node:child_process');
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    return await new Promise((resolve) => {
      // The dispatch message contains apostrophes, parens, etc — Windows
      // cmd.exe quoting is too lossy. Stage the message to a temp file and
      // pass it via shell-redirected stdin to bypass arg-quoting entirely.
      // (openclaw doesn't have a --message-file flag, but it supports
      //  reading the message arg verbatim once we get past Windows shell
      //  parsing — passing through cmd.exe with /c is cleanest.)
      const isWin = process.platform === 'win32';
      const stagingDir = mkdtempSync(join(tmpdir(), 'hlo-dispatch-'));
      const msgFile = join(stagingDir, 'msg.txt');
      writeFileSync(msgFile, message, 'utf8');

      // Build the command line. On Windows we go through cmd /c with
      // windowsVerbatimArguments so Node doesn't re-escape our hand-tuned
      // quoting. The message is passed via env var (Windows %MSG%) or
      // shell subshell (POSIX $(cat <file>)) so it never appears in argv.
      //
      // Why so much ceremony: Node's normal Windows arg-escaping wraps the
      // whole command line in double quotes and escapes inner quotes with
      // backslash, but cmd.exe interprets `\"` as a literal quote-after-
      // backslash, not as an escape. The result was that `--message
      // "%MSG%"` lost its quoting and openclaw saw the message as 69
      // separate args. windowsVerbatimArguments + a manually-correct
      // command line bypasses this entirely.
      const shellCmd = isWin ? 'cmd.exe' : 'bash';
      const cliPath = OPENCLAW_CLI_PATH;
      const cliPathNeedsQuotes = /\s/.test(cliPath);
      const winCli = cliPathNeedsQuotes ? `"${cliPath}"` : cliPath;
      // For windowsVerbatimArguments, we pass ONE arg containing the
      // whole command line that cmd /c will run.
      const shellArgs = isWin
        ? ['/d', '/s', '/c', `${winCli} agent --agent ${agent.name} --message "%MSG%"`]
        : ['-c', `"${cliPath}" agent --agent "${agent.name}" --message "$(cat "${msgFile}")"`];

      // Put message in env for Windows cmd's `%MSG%` expansion (avoids
      // quoting hell — cmd's % expansion handles the message's special
      // chars correctly when the env var is set verbatim).
      const childEnv = { ...process.env, MSG: message };

      const proc = spawn(shellCmd, shellArgs, {
        windowsHide: true,
        env: childEnv,
        // Critical on Windows: bypass Node's auto-escaping. Otherwise our
        // explicit `"%MSG%"` quoting in the cmd line gets backslash-escaped
        // by Node and cmd.exe interprets it differently. See comment above.
        windowsVerbatimArguments: isWin,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        resolve({ ok: false, mode: 'cli', error: `cli timeout after ${timeoutMin} min`, output: stdout });
      }, timeoutMin * 60_000);
      proc.stdout?.on('data', (d) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, mode: 'cli', error: `spawn error: ${e.message}`, output: stdout });
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        try { unlinkSync(msgFile); } catch { /* ignore */ }
        resolve({
          ok: code === 0,
          mode: 'cli',
          taskId: `cli-${Date.now()}`,
          exitCode: code,
          output: stdout,
          stderr: stderr.slice(0, 1000),
        });
      });
    });
  }

  if (DISPATCH_MODE === 'http') {
    if (!GATEWAY_URL) {
      throw new Error('HLO_DISPATCH_MODE=http but OPENCLAW_GATEWAY_URL is not set');
    }
    const url = `${GATEWAY_URL.replace(/\/$/, '')}/agents/${encodeURIComponent(agent.name)}/tasks`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
      },
      body: JSON.stringify({ message, timeout_minutes: timeoutMin }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, mode: 'http', error: `gateway HTTP ${resp.status}: ${txt.slice(0, 240)}` };
    }
    const body = await resp.json();
    return { ok: true, mode: 'http', taskId: body.id || body.task_id || null, exitCode: body.exitCode, output: body.output || '' };
  }

  return { ok: false, error: `unknown dispatch mode "${DISPATCH_MODE}"` };
}

// ─────────────────────────────────────────────────────────────────
// On-chain verification — never trust agent self-report
// ─────────────────────────────────────────────────────────────────
async function verifyAction(action, beforeJobCount) {
  if (action.kind === 'create_job') {
    const after = await readJobCount();
    return {
      success: after > beforeJobCount,
      observed: { jobCount_before: beforeJobCount, jobCount_after: after },
    };
  }
  if (action.kind === 'submit_review') {
    const after = await pub.readContract({ address: REVIEWGATE, abi: RG_ABI, functionName: 'getPendingReviewCount', args: [action.agent.wallet] });
    return {
      success: Number(after) < action.agent.snapshot.pendingReviewCount,
      observed: { pending_before: action.agent.snapshot.pendingReviewCount, pending_after: Number(after) },
    };
  }
  return { success: true, observed: {} };
}

// ─────────────────────────────────────────────────────────────────
// Telemetry — orchestration_events + system_heartbeats
// ─────────────────────────────────────────────────────────────────
async function emitOrchEvent(row) {
  if (DRY_RUN || !STS_KEY) {
    console.log(`  [DRY ORCH] ${JSON.stringify(row).slice(0, 240)}`);
    return;
  }
  try {
    const r = await fetch(`${STS_URL}/rest/v1/orchestration_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      // 4xx schema mismatches were silently swallowed pre-A.8; explicitly log
      // status + body so future field drift is loud.
      const txt = await r.text().catch(() => '');
      console.log(`  [WARN orch upsert] status=${r.status} body=${txt.slice(0, 240)}`);
    }
  } catch (e) {
    console.log(`  [WARN orch upsert] network: ${e.message?.slice(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// Phase B — write a tx_attempts row for every dispatched transaction.
// Indexer reads receipts and updates outcome + revert_reason. Verifier
// reads here for negative scenarios (s13, s14, s15).
//
// initialOutcome: 'pending' (no receipt yet), 'success' (already-confirmed),
//                 'reverted' (already-known revert), 'timeout' (gave up).
// ─────────────────────────────────────────────────────────────────
async function emitTxAttempt({
  txHash,
  intendedAction,
  intendedJobId = null,
  actor,
  outcome = 'pending',
  revertReason = null,
  rawRevertData = null,
  blockNumber = null,
  meta = null,
}) {
  if (DRY_RUN || !STS_KEY || !txHash || !actor) return;
  try {
    const r = await fetch(`${STS_URL}/rest/v1/tx_attempts?on_conflict=project_id,tx_hash`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        project_id: 'awp',
        tx_hash: txHash,
        block_number: blockNumber,
        intended_action: intendedAction,
        intended_job_id: intendedJobId,
        actor: actor.toLowerCase(),
        outcome,
        revert_reason: revertReason,
        raw_revert_data: rawRevertData,
        meta,
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.log(`  [WARN tx_attempts upsert] status=${r.status} body=${txt.slice(0, 240)}`);
    }
  } catch (e) {
    console.log(`  [WARN tx_attempts upsert] network: ${e.message?.slice(0, 200)}`);
  }
}

async function emitHeartbeat(meta) {
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
        project_id: 'awp', component: 'hlo-daemon',
        outcome: meta.outcome, actions_count: meta.actions_count || 0,
        note: meta.note, meta,
      }),
    });
  } catch { /* fire and forget */ }
}

// ─────────────────────────────────────────────────────────────────
// Per-action dispatch (extracted from tick() so Priority C can run
// many of these concurrently via Promise.allSettled). Returns true
// when the dispatch + verify both succeed; false on any failure.
// All errors are caught and surfaced as orchestration_events rows so
// one bad agent doesn't poison the whole tick.
// ─────────────────────────────────────────────────────────────────
async function dispatchOneAction(action, beforeJobCount, cycleId) {
  // ── Phase H: route create_job through direct viem dispatch when an
  // agent's private key is loaded. Skips OpenClaw CLI entirely — much
  // faster (~3-5s instead of ~3min) AND parallel-safe (each agent has
  // its own wallet client + nonce). For create_job actions where the
  // key isn't available, fall through to the legacy CLI/dryrun path
  // below so behavior is unchanged.
  //
  // In dryrun mode, log what direct dispatch WOULD do (7 distinct
  // create_job param sets) without sending tx. Lets us prove the
  // parallel pick worked without spending gas.
  if (
    action.kind === 'create_job' &&
    action.agent?.agent?.wallet &&
    AGENT_ACCOUNTS.has(action.agent.agent.wallet.toLowerCase())
  ) {
    if (DISPATCH_MODE === 'dryrun') {
      const params = configKeyToCreateJobParams(action.configKey, action.agent.agent.wallet);
      console.log(
        `  [DRY DIRECT-CREATE → ${action.agent.agent.name}] cell=${action.configKey}|${action.scenarioId} ` +
        `valMode=${params.validationMode} subMode=${params.submissionMode} ` +
        `subWindow=${params.submissionWindow} approvedW=${params.approvedWorkers.length} ` +
        `approvedV=${params.approvedValidators.length} minWR=${params.minWorkerRating} minVR=${params.minValidatorRating}`,
      );
      return true;
    }
    return await dispatchCreateJobDirectWithTelemetry(action, cycleId);
  }

  const message = generateDispatchMessage(action);
  try {
    assertInsiderInfoClean('hlo-dispatch', message);
  } catch (leak) {
    console.error(`[dispatch] INSIDER LEAK CAUGHT: ${leak.message}`);
    await emitOrchEvent({
      project_id: 'awp',
      cycle_id: cycleId,
      source: 'hlo-daemon',
      event_type: 'error',
      persona: action.agent?.agent?.name || null,
      reasoning: 'insider_leak_blocked',
      meta: {
        priority: action.priority,
        action_kind: action.kind,
        target_agent_wallet: action.agent?.agent?.wallet || null,
        intended_config: action.configKey || null,
        intended_scenario: action.scenarioId || null,
        pick_source: action.pickSource || null,
        dispatch_message_text: message,
        leak_error: String(leak.message),
      },
    });
    return false;
  }

  const dispatchedAt = new Date().toISOString();
  const dispatchBase = {
    project_id: 'awp',
    cycle_id: cycleId,
    source: 'hlo-daemon',
    event_type: 'dispatch',
    persona: action.agent.agent.name,
    directive: message,
    reasoning: action.reason || null,
    meta: {
      lifecycle: 'requested',
      priority: action.priority,
      action_kind: action.kind,
      target_agent_wallet: action.agent.agent.wallet,
      intended_config: action.configKey || null,
      intended_scenario: action.scenarioId || null,
      pick_source: action.pickSource || null,
      dispatched_at: dispatchedAt,
      dispatch_mode: DISPATCH_MODE,
    },
  };
  await emitOrchEvent(dispatchBase);

  const result = await dispatchToAgent(action.agent.agent, message, action.kind === 'create_job' ? 10 : 5);

  if (!result.ok) {
    const failDetail = result.error
      || (result.exitCode != null
            ? `exit=${result.exitCode} stderr="${(result.stderr || '').slice(0, 200)}" stdout="${(result.output || '').slice(0, 200)}"`
            : 'unknown');
    console.log(`[dispatch] FAILED ${action.agent.agent.name}: ${failDetail.slice(0, 160)}`);
    await emitOrchEvent({
      ...dispatchBase,
      event_type: 'error',
      reasoning: 'dispatch_failed',
      meta: {
        ...dispatchBase.meta,
        lifecycle: 'failed',
        error: failDetail,
        exitCode: result.exitCode ?? null,
        stderr: result.stderr || null,
        output: (result.output || '').slice(0, 500),
      },
    });
    return false;
  }

  // Verification policy:
  //   Priority A (single-shot): poll on-chain up to 60s — review-cap action
  //     is observable as pendingReviewCount strictly decreasing.
  //   Priority C (parallel): trust cli exit=0. Polling jobCount in parallel
  //     mode is unreliable for individual attribution (any of the N parallel
  //     posts increments the count). The scanner-v15 cron handles authoritative
  //     attribution within 15 min by reading on-chain events.
  //   dryrun: always success.
  let verify = { success: true, observed: { cli: 'ok' } };
  if (DISPATCH_MODE === 'dryrun') {
    verify = { success: true, observed: { dryrun: true } };
  } else if (action.priority === 'A') {
    verify = { success: false, observed: {} };
    const waitStart = Date.now();
    while (Date.now() - waitStart < 60_000) {
      verify = await verifyAction(action, beforeJobCount);
      if (verify.success) break;
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  await emitOrchEvent({
    ...dispatchBase,
    event_type: verify.success ? 'dispatch' : 'error',
    reasoning: verify.success ? 'dispatch_verified' : 'dispatch_unverified',
    meta: {
      ...dispatchBase.meta,
      lifecycle: verify.success ? 'verified' : 'unverified',
      task_id: result.taskId,
      verify_observed: verify.observed,
    },
  });
  return verify.success;
}

// Wraps dispatchCreateJobDirect with the same orchestration_events telemetry
// that the cli path emits, so dashboards / matrix-audit / scanner all stay
// schema-stable. Returns boolean (mirrors dispatchOneAction's contract).
async function dispatchCreateJobDirectWithTelemetry(action, cycleId) {
  const dispatchedAt = new Date().toISOString();
  const dispatchBase = {
    project_id: 'awp',
    cycle_id: cycleId,
    source: 'hlo-daemon',
    event_type: 'dispatch',
    persona: action.agent.agent.name,
    directive: `direct-create_job target=${action.configKey}|${action.scenarioId}`,
    reasoning: action.reason || null,
    meta: {
      lifecycle: 'requested',
      priority: action.priority,
      action_kind: action.kind,
      target_agent_wallet: action.agent.agent.wallet,
      intended_config: action.configKey || null,
      intended_scenario: action.scenarioId || null,
      pick_source: action.pickSource || null,
      dispatched_at: dispatchedAt,
      dispatch_mode: 'direct-viem',
    },
  };
  await emitOrchEvent(dispatchBase);

  const t0 = Date.now();
  const out = await dispatchCreateJobDirect(action);
  const elapsedMs = Date.now() - t0;

  if (!out.ok) {
    console.log(`[dispatch-direct] FAILED ${action.agent.agent.name}: ${(out.error || '').slice(0, 160)}`);
    await emitOrchEvent({
      ...dispatchBase,
      event_type: 'error',
      reasoning: 'dispatch_failed',
      meta: {
        ...dispatchBase.meta,
        lifecycle: 'failed',
        error: out.error || 'unknown',
        elapsed_ms: elapsedMs,
        tx_hash: out.txHash || null,
      },
    });
    // Phase B — record the failed attempt so the verifier can detect
    // expected-revert scenarios (s13, s15). The indexer will fill outcome
    // + revert_reason from the receipt if a tx hash exists; otherwise
    // mark 'reverted' immediately based on the simulate revert message.
    if (out.txHash || (out.error || '').toLowerCase().includes('simulate revert')) {
      await emitTxAttempt({
        txHash: out.txHash || `simulate-${Date.now()}-${action.agent.agent.wallet.slice(2, 10)}`,
        intendedAction: 'createJob',
        intendedJobId: out.jobId || null,
        actor: action.agent.agent.wallet,
        outcome: out.txHash ? 'pending' : 'reverted',
        revertReason: out.txHash ? null : extractRevertName(out.error || ''),
        rawRevertData: out.error || null,
        meta: {
          intended_config: action.configKey,
          intended_scenario: action.scenarioId,
        },
      });
    }
    return false;
  }

  await emitOrchEvent({
    ...dispatchBase,
    event_type: 'dispatch',
    reasoning: 'dispatch_verified',
    meta: {
      ...dispatchBase.meta,
      lifecycle: 'verified',
      tx_hash: out.txHash,
      job_id: out.jobId,
      block_number: out.blockNumber,
      elapsed_ms: elapsedMs,
      title: out.title,
    },
  });
  // Phase B — successful createJob attempt
  await emitTxAttempt({
    txHash: out.txHash,
    intendedAction: 'createJob',
    intendedJobId: out.jobId,
    actor: action.agent.agent.wallet,
    outcome: 'success',
    blockNumber: out.blockNumber,
    meta: {
      intended_config: action.configKey,
      intended_scenario: action.scenarioId,
    },
  });
  return true;
}

// V15/V4 custom error names that may appear inside a viem revert message.
// Imported lazily to avoid pulling lib/awp at module-init when env is missing.
const _KNOWN_ERR_NAMES = [
  'RatingGateFailed','NotApprovedWorker','NotApprovedValidator','RewardZero','TitleRequired',
  'DescriptionRequired','RequirementsRequired','InvalidValidationMode','InvalidSubmissionMode',
  'ScriptCIDRequired','ScriptCIDNotAllowed','InstructionsRequired','WindowRequiredTimed',
  'WindowMustBeZero','HardOnlyValRating','HardOnlyApprovedVal','InsufficientAllowance',
  'InsufficientBalance','TransferFromFailed','JobNotFound','JobNotOpenForValidators',
  'JobNotOpenForSubmissions','JobNotActive','JobNotCancellable','PosterCannotValidate',
  'PosterCannotSubmit','WorkerCannotValidate','ValidatorCannotSubmit','OnlyPoster',
  'OnlyActiveValidator','OnlyActiveValidatorReject','RejectAllNotAllowed','ResubmissionNotAllowed',
  'AlreadyActiveValidator','AlreadyInWaitlist','AlreadyServed','AlreadyReviewed',
  'NoValidatorNeeded','NoValidatorHardOnly','NoActiveValidator','NoSubmissionsToReject',
  'NoSubmissionsYet','NoScriptSoftOnly','InvalidSubmissionIndex',
];
function extractRevertName(msg) {
  if (!msg) return null;
  for (const name of _KNOWN_ERR_NAMES) {
    if (msg.includes(name)) return name;
  }
  // Fallback: pull the bracketed shortMessage if present
  const m = msg.match(/reverted with the following reason:\s*([^\n]+)/);
  if (m) return m[1].trim().slice(0, 200);
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Tick loop — Phase G: parallel posting per eligible agent
// ─────────────────────────────────────────────────────────────────
//
// Pre-G: ONE dispatch per tick. With 7 agents + ~3-min effective tick
// (state read + cli round-trip + verify poll), throughput capped at ~20
// jobs/hour and rotation kept hitting the same easy cells.
//
// G: each tick reads state once, then for each eligible agent picks a
// DIFFERENT cell (steered if target-gaps.json is fresh, rotation otherwise)
// and dispatches concurrently via Promise.allSettled. Skipped agents (gas
// low, review cap hit, ratings out of range) don't crash the tick — they
// just don't get a job that round. Real-world ceiling is bounded by chain
// nonce serialization + RPC + agent cli latency, not by this code.
async function tick() {
  const t0 = Date.now();
  const cycleId = `hlo-${Date.now()}`;
  try {
    // 1. Read fresh state ONCE (shared across all parallel actions this tick)
    const jobCount = await readJobCount();
    const agentSnapshots = await Promise.all(
      AGENTS.map(async a => ({ agent: a, snapshot: await readAgentSnapshot(a) })),
    );
    const coverage = await readMatrixCoverage();
    const recentlyDispatched = await readRecentlyDispatchedCells(30);
    const gaps = await readTargetGaps();

    // 2. Priority A — review-cap unblock. Single-shot to keep verification
    // semantics intact. If multiple agents are capped, we'll catch the
    // others on the next tick.
    const capped = agentSnapshots.find(a => a.snapshot.pendingReviewCount >= 5);
    if (capped) {
      const action = {
        kind: 'submit_review',
        priority: 'A',
        agent: capped,
        reason: `agent ${capped.agent.name} at review cap (${capped.snapshot.pendingReviewCount}/5)`,
      };
      const ok = await dispatchOneAction(action, jobCount, cycleId);
      console.log(`[tick] A submit_review → ${capped.agent.name} : verify=${ok}`);
      await emitHeartbeat({
        outcome: ok ? 'ok' : 'partial',
        actions_count: ok ? 1 : 0,
        note: `submit_review via ${capped.agent.name}`,
        duration_ms: Date.now() - t0,
      });
      return;
    }

    // 3. Priority C — parallel post one job per eligible agent (up to
    // HLO_PARALLEL_LIMIT). Round-robin which agents win each tick so all 7
    // get airtime over consecutive ticks even when the cap is below 7.
    const allEligible = agentSnapshots.filter(a => {
      const elig = checkAgentEligibility(a.snapshot, null, 'create_job');
      if (!elig.eligible) return false;
      // Need USDC ≥ a small reward (5 USDC = 5_000_000 micros)
      if (a.snapshot.usdcMicros < 5_000_000n) return false;
      return true;
    });
    // Rotate the eligible list by posterRotationIndex so successive ticks
    // start from a different agent — distributes load when cap < 7.
    const rotated = allEligible.slice(posterRotationIndex % Math.max(1, allEligible.length))
      .concat(allEligible.slice(0, posterRotationIndex % Math.max(1, allEligible.length)));
    const eligible = rotated.slice(0, HLO_PARALLEL_LIMIT);
    if (allEligible.length > 0) {
      posterRotationIndex = (posterRotationIndex + eligible.length) % allEligible.length;
    }

    if (eligible.length === 0) {
      console.log(`[tick] IDLE (D): no eligible agents (USDC/ETH/review-cap)`);
      await emitHeartbeat({ outcome: 'idle', note: 'no eligible agents', duration_ms: Date.now() - t0 });
      return;
    }

    // 4. Pick one DISTINCT cell per eligible agent. Phase I: pre-shuffle the
    // top-50 steered list and take the first N — guarantees no repeats within
    // a tick by construction. Falls back to rotation pick (one-by-one with
    // usedCells exclusion) if steering data is stale or runs dry.
    const usedCells = new Set();
    const steeredAvailable = !!(gaps && Array.isArray(gaps.underCoveredCells) && gaps.underCoveredCells.length);
    const actions = [];

    let steeredPicks = [];
    if (steeredAvailable) {
      steeredPicks = pickSteeredCellsForTick(gaps, eligible.length);
      for (const p of steeredPicks) usedCells.add(`${p.configKey}|${p.scenarioId}`);
    }

    for (let i = 0; i < eligible.length; i++) {
      const agent = eligible[i];
      let cell = steeredPicks[i] || null;
      let pickSource = cell ? 'steered' : null;
      if (!cell) {
        cell = pickUntestedCell(coverage, recentlyDispatched, eligible, usedCells);
        if (cell) {
          pickSource = 'rotation';
          usedCells.add(`${cell.configKey}|${cell.scenarioId}`);
        }
      }
      if (!cell) break; // No more cells to assign this tick
      actions.push({
        kind: 'create_job',
        priority: 'C',
        agent,
        configKey: cell.configKey,
        scenarioId: cell.scenarioId,
        params: cell.params,
        pickSource,
        reason: `${pickSource} cell: ${cell.configKey} → ${cell.scenarioId}`,
      });
    }

    if (actions.length === 0) {
      console.log(`[tick] IDLE (D): no untested cells available (${eligible.length} eligible agents)`);
      await emitHeartbeat({ outcome: 'idle', note: 'no cells', duration_ms: Date.now() - t0 });
      return;
    }

    // 5. Fire all dispatches in parallel; one bad agent doesn't kill the rest.
    const results = await Promise.allSettled(
      actions.map(a => dispatchOneAction(a, jobCount, cycleId)),
    );
    const verified = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    const errored = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && r.value === false)).length;

    const agentList = actions.map(a => a.agent.agent.name.replace(/^agent-/, '')).join(',');
    const cellList = actions
      .map(a => `${a.configKey}:${a.scenarioId}`)
      .map(s => s.length > 36 ? s.slice(0, 33) + '...' : s)
      .join(',');
    const pickMix = (() => {
      const steered = actions.filter(a => a.pickSource === 'steered').length;
      const rotation = actions.filter(a => a.pickSource === 'rotation').length;
      return `pick=${steered ? 'steered' : 'rotation'}${steered && rotation ? `(${steered}st/${rotation}rot)` : ''}`;
    })();
    console.log(
      `[tick] dispatched=${verified}/${actions.length} ` +
      `${pickMix} agents=[${agentList}] cells=[${cellList}]`,
    );

    await emitHeartbeat({
      outcome: verified > 0 ? 'ok' : 'partial',
      actions_count: verified,
      note: `parallel C: ${verified}/${actions.length} verified, ${errored} errored, gaps=${gaps?.underCoveredCells?.length ?? 'none'}`,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error(`[tick] ERROR: ${err.message}`);
    await emitOrchEvent({
      project_id: 'awp',
      cycle_id: cycleId,
      source: 'hlo-daemon',
      event_type: 'error',
      reasoning: 'hlo_tick_error',
      meta: { error: err.message, stack: err.stack?.slice(0, 1000) },
    });
    await emitHeartbeat({ outcome: 'error', note: `tick error: ${err.message?.slice(0, 200)}`, duration_ms: Date.now() - t0 });
  }
}

async function main() {
  console.log('=== HLO Daemon (Phase A) ===');
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Dispatch mode:  ${DISPATCH_MODE}${DISPATCH_MODE === 'http' ? ` (${GATEWAY_URL})` : ''}`);
  console.log(`Tick interval:  ${TICK_MS} ms`);
  console.log(`Parallel limit: ${HLO_PARALLEL_LIMIT}`);
  console.log(`JobNFT V15:     ${JOBNFT_V15}`);
  console.log(`ReviewGate V4:  ${REVIEWGATE}`);
  console.log(`Agents:         ${AGENTS.map(a => a.name).join(', ')}`);

  // Phase H — load agent keys for direct create_job dispatch
  loadAgentKeys();

  await tick();

  if (RUN_ONCE) {
    console.log('--once flag set; exiting after first tick.');
    return;
  }

  // Loop forever
  while (true) {
    await new Promise(r => setTimeout(r, TICK_MS));
    await tick();
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

// Export the insider-info check for unit tests
export { assertInsiderInfoClean, findInsiderInfoLeaks };
