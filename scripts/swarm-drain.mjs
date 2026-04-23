#!/usr/bin/env node
/**
 * swarm-drain.mjs — Mechanical lifecycle progression for AWP jobs.
 *
 * Replaces auto-cycle.mjs per-agent LLM loop. No LLM calls. Runs every 5 min
 * via cron. Walks the last 80 Open/Active jobs on-chain, and for each:
 *   - If no validator + not poster → claim (first eligible agent)
 *   - If no submissions + validator set + agent not poster → submit
 *   - If pending submission + agent is validator → approve or reject per
 *     intended-scenarios.json annotation (default: approve)
 *   - If completed + agent is participant with pending reviews → review
 *
 * Reads /root/test-swarm/intended-scenarios.json for per-job scenario
 * targeting. If a job is annotated with s05-total-rejection, validator
 * rejects. If s10, rejects then cancels. If s02, validator claims BEFORE
 * submitting (enforced via skip-submit-if-no-validator). Etc.
 *
 * Safe design:
 *   - simulateContract before every write; skip on revert
 *   - hardcoded per-action gas limits (no guessing)
 *   - respects approvedWorkers[] / approvedValidators[] from job params
 *   - caps actions per run at MAX_ACTIONS_PER_RUN (25 default)
 *
 * Logs every attempt + outcome to stdout (which cron pipes to
 * /var/log/awp-drain.log).
 */

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { runAgent } from './swarm-agent-runner.mjs';

const STARTED_AT = Date.now();
let errorCount = 0;

const STS_SUPABASE_URL =
  process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
const STS_SUPABASE_KEY = process.env.STS_SUPABASE_KEY;

async function emitHeartbeat(component, actions_count, note, extraMeta = {}) {
  if (!STS_SUPABASE_KEY) {
    console.log(`[heartbeat] skipped (${component}): STS_SUPABASE_KEY not set`);
    return;
  }
  try {
    const body = {
      project_id: 'awp',
      component,
      outcome: actions_count > 0 ? 'ok' : 'idle',
      actions_count,
      note,
      meta: { errors: errorCount, duration_ms: Date.now() - STARTED_AT, ...extraMeta },
    };
    const resp = await fetch(`${STS_SUPABASE_URL}/rest/v1/system_heartbeats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: STS_SUPABASE_KEY,
        Authorization: `Bearer ${STS_SUPABASE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.log(`[heartbeat] POST failed ${resp.status}: ${t.slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`[heartbeat] error: ${e.message?.slice(0, 200)}`);
  }
}

// ============================================================
// Config
// ============================================================
const RPC       = process.env.AWP_RPC_URL || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';
const JOB_NFT   = '0x267e831e6ac1e7c9e69bd99aec7f41e03a421198'; // V14
const RG        = '0xbf704b315a95cb21c64ac390f6b5788b5d72b397'; // V3
const ZERO_B32  = '0x0000000000000000000000000000000000000000000000000000000000000000';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const SCAN_WINDOW      = 80;      // scan last N jobs each run
const MAX_ACTIONS      = 25;      // cap writes per run (gas budget)
const SCENARIOS_FILE   = '/root/test-swarm/intended-scenarios.json';
const RUN_ID           = new Date().toISOString();

const STATUS_STR = ['Open','Active','Completed','Cancelled','Disputed'];

// ============================================================
// Load 7 agent wallets
// ============================================================
const NAMES = { 1:'Spark', 2:'Grind', 3:'Judge', 4:'Chaos', 5:'Scout', 6:'Flash', 7:'Bridge' };
const AGENTS = [];
for (let i = 1; i <= 7; i++) {
  const raw = readFileSync(`/root/test-swarm/agent-${i}/IDENTITY.md`, 'utf8');
  const m = raw.match(/Private Key:\s*(0x[a-fA-F0-9]{64})/);
  if (!m) throw new Error(`agent-${i}: no private key found in IDENTITY.md`);
  const account = privateKeyToAccount(m[1]);
  AGENTS.push({ id: i, name: NAMES[i], account, address: account.address });
}
console.log(`[${RUN_ID}] Loaded ${AGENTS.length} agents`);

// ============================================================
// Clients
// ============================================================
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const walletFor = (agent) =>
  createWalletClient({ account: agent.account, chain: baseSepolia, transport: http(RPC) });

// ============================================================
// Intended scenarios map
// ============================================================
let intendedScenarios = {};
try {
  if (existsSync(SCENARIOS_FILE)) {
    intendedScenarios = JSON.parse(readFileSync(SCENARIOS_FILE, 'utf8'));
  }
} catch (e) {
  console.log(`[${RUN_ID}] intended-scenarios.json unreadable: ${e.message} — defaulting to s01 for all jobs`);
  intendedScenarios = {};
}

const intendedFor = (jobId) => intendedScenarios[String(jobId)] || 's01-happy-path';

// ============================================================
// ABIs
// ============================================================
const JOB_ABI = parseAbi([
  'function jobCount() view returns (uint256)',
  'function getSubmissionCount(uint256 jobId) view returns (uint256)',
  'function getJobV12(uint256 jobId) view returns (address poster, uint256 reward, uint8 status, address activeValidator, address[] validatorWaitlist, uint256 validatorTimeout, bool openValidation, string title, string description, string requirementsJson, uint256 claimWindowHours, uint8 validationMode, uint8 submissionMode, uint256 submissionWindow, string validationScriptCID, bool requireSecurityAudit, string securityAuditTemplate, uint256 submissionDeadline, bool allowResubmission, bool allowRejectAll, address[] approvedWorkers, string validationInstructions)',
  'function getSubmissionV11(uint256 jobId, uint256 index) view returns (address worker, string deliverableUrl, bytes32 encryptedDeliverableHash, uint256 timestamp, uint8 status, bytes decryptionKey, bytes32 scriptResultHash, uint256 scriptScore, bool scriptPassed, string securityAuditCID)',
  'function isApprovedWorker(uint256 jobId, address worker) view returns (bool)',
  'function submitWork(uint256 jobId, string deliverableUrl, bytes32 encryptedDeliverableHash) returns (uint256)',
  'function claimJobAsValidator(uint256 jobId)',
  'function approveSubmission(uint256 jobId, uint256 submissionIndex, bytes decryptionKey, string feedback)',
  'function rejectSubmission(uint256 jobId, uint256 submissionIndex)',
  'function rejectAllSubmissions(uint256 jobId)',
  'function cancelJob(uint256 jobId)',
  'function finalizeTimedJob(uint256 jobId)',
]);

const RG_ABI = parseAbi([
  'function isReviewRequired(uint256 jobId, address reviewer, address reviewee) view returns (bool)',
  'function submitReview(uint256 jobId, address reviewee, uint8 score, string commentCID)',
  'function getPendingReviewCount(address wallet) view returns (uint256)',
  'function isBlocked(address wallet) view returns (bool)',
]);

// ============================================================
// Helpers
// ============================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Agent-driven submission content. The URL + note are produced by the
// persona's voice via the OpenRouter runner; the caller writes the tx.
async function agentSubmit(jobId, agent, job) {
  const out = await runAgent({
    persona: agent.name,
    taskType: 'submit',
    context: {
      job: {
        jobId,
        title: job?.title ?? '',
        description: job?.description ?? '',
        rewardUSDC: job?.reward ? (Number(job.reward) / 1_000_000).toString() : '5',
        posterShort: job?.poster
          ? `${job.poster.slice(0, 6)}…${job.poster.slice(-4)}`
          : 'unknown',
      },
    },
  });
  return out;
}

async function getJob(jobId) {
  try {
    const r = await pub.readContract({
      address: JOB_NFT, abi: JOB_ABI, functionName: 'getJobV12', args: [BigInt(jobId)],
    });
    return {
      id: jobId,
      poster: r[0],
      reward: r[1],
      status: Number(r[2]),
      statusStr: STATUS_STR[Number(r[2])],
      activeValidator: r[3],
      waitlist: r[4],
      openValidation: Boolean(r[6]),
      title: r[7],
      description: r[8],
      validationMode: Number(r[11]),   // 0=HARD_ONLY, 1=SOFT_ONLY, 2=HARD_THEN_SOFT
      submissionMode: Number(r[12]),   // 0=FCFS, 1=MULTI
      submissionWindow: Number(r[13]),
      submissionDeadline: Number(r[17]),
      allowResubmission: Boolean(r[18]),
      allowRejectAll: Boolean(r[19]),
      approvedWorkers: r[20],
    };
  } catch (e) {
    return null;
  }
}

async function getSubCount(jobId) {
  try {
    const c = await pub.readContract({
      address: JOB_NFT, abi: JOB_ABI, functionName: 'getSubmissionCount', args: [BigInt(jobId)],
    });
    return Number(c);
  } catch { return 0; }
}

async function getSub(jobId, idx) {
  try {
    const r = await pub.readContract({
      address: JOB_NFT, abi: JOB_ABI, functionName: 'getSubmissionV11',
      args: [BigInt(jobId), BigInt(idx)],
    });
    return {
      worker: r[0],
      deliverableUrl: r[1],
      subStatus: Number(r[4]),   // 0=pending 1=approved 2=rejected
    };
  } catch { return null; }
}

async function simulate(agent, functionName, args) {
  try {
    await pub.simulateContract({
      address: JOB_NFT, abi: JOB_ABI, functionName, args,
      account: agent.account,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.shortMessage || e.message?.slice(0,200) };
  }
}

async function writeTx(agent, functionName, args, gas) {
  const wal = walletFor(agent);
  const hash = await wal.writeContract({
    address: JOB_NFT, abi: JOB_ABI, functionName, args, gas,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { hash, status: rcpt.status, block: rcpt.blockNumber };
}

async function writeRG(agent, functionName, args, gas) {
  const wal = walletFor(agent);
  const hash = await wal.writeContract({
    address: RG, abi: RG_ABI, functionName, args, gas,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { hash, status: rcpt.status };
}

// ============================================================
// Eligibility rules
// ============================================================
function canClaimValidator(job, agent) {
  if (job.status !== 0 && job.status !== 1) return false;
  if (job.poster.toLowerCase() === agent.address.toLowerCase()) return false;
  if (job.activeValidator !== ZERO_ADDR) return false;
  if (job.validationMode === 0) return false; // HARD_ONLY doesn't need validators
  return true;
}

function canSubmitWork(job, agent) {
  if (job.status !== 0 && job.status !== 1) return false;
  if (job.poster.toLowerCase() === agent.address.toLowerCase()) return false;
  // For non-HARD: need validator set before submit (unless we intentionally want s09 validator-no-show)
  // For HARD_ONLY: no validator concept, can submit anytime
  if (job.validationMode !== 0 && job.activeValidator === ZERO_ADDR) {
    // Exception: intended s09-validator-no-show SHOULD submit without a validator
    return intendedFor(job.id) === 's09-validator-no-show';
  }
  // Check approvedWorkers if not empty
  if (job.approvedWorkers && job.approvedWorkers.length > 0) {
    const ok = job.approvedWorkers.map(a => a.toLowerCase()).includes(agent.address.toLowerCase());
    if (!ok) return false;
  }
  return true;
}

function isValidator(job, agent) {
  return job.activeValidator.toLowerCase() === agent.address.toLowerCase();
}

// ============================================================
// Round-robin agent picker — deterministic, load-distributing
// ============================================================
function pickAgent(jobId, role) {
  const offset = { claim: 0, submit: 2, validate: 4 }[role] ?? 0;
  const order = Array.from({length: 7}, (_, k) => (jobId + offset + k) % 7);
  return order.map(i => AGENTS[i]);
}

// ============================================================
// Scenario-driven validator bias removed (Phase 5).
// Outcome scenarios (s01/s03/s04/s05/s12/s16) are no longer steered —
// the validator persona decides via runAgent in the approve/reject
// branch. Event-order scenarios (s10 cancel follow-up) are still
// consulted at their specific sites.
// ============================================================

// ============================================================
// Per-job progression
// ============================================================
let actionsTaken = 0;

async function progressJob(jobId) {
  if (actionsTaken >= MAX_ACTIONS) return null;
  const job = await getJob(jobId);
  if (!job) return null;
  const subCount = await getSubCount(jobId);
  const scenario = intendedFor(jobId);
  const summary = `#${jobId} status=${job.statusStr} subs=${subCount} valMode=${job.validationMode} subMode=${job.submissionMode} activeV=${job.activeValidator.slice(0,10)} intended=${scenario}`;

  // === STATE: Completed / Cancelled → reviews only ===
  if (job.status >= 2) {
    // Post completion — skip review logic here (runs in separate pass below)
    return null;
  }

  // === STATE: Open, no validator, mode != HARD_ONLY → claim ===
  if (job.activeValidator === ZERO_ADDR && job.validationMode !== 0 && scenario !== 's06-validator-waitlist') {
    // Special: s02 wants validator-first, so claim before any submissions
    // (which is naturally what this branch does)
    for (const agent of pickAgent(jobId, 'claim')) {
      if (!canClaimValidator(job, agent)) continue;
      const sim = await simulate(agent, 'claimJobAsValidator', [BigInt(jobId)]);
      if (!sim.ok) { console.log(`  ${summary} | CLAIM skip ${agent.name}: ${sim.reason}`); continue; }
      try {
        const r = await writeTx(agent, 'claimJobAsValidator', [BigInt(jobId)], 400_000n);
        console.log(`  ${summary} | CLAIM by ${agent.name} tx=${r.hash} status=${r.status}`);
        actionsTaken++;
        return 'claim';
      } catch (e) {
        console.log(`  ${summary} | CLAIM fail ${agent.name}: ${e.shortMessage || e.message?.slice(0,120)}`);
      }
    }
  }

  // === STATE: Open/Active, no submissions yet, validator set (or s09 wants none) → submit ===
  if (subCount === 0) {
    // s08-worker-no-show: intentionally don't submit; let it time out via finalize.
    if (scenario === 's08-worker-no-show') {
      console.log(`  ${summary} | SKIP-SUBMIT (s08 intent)`);
      return null;
    }
    for (const agent of pickAgent(jobId, 'submit')) {
      if (!canSubmitWork(job, agent)) continue;
      const out = await agentSubmit(jobId, agent, job);
      const url = out.deliverableUrl;
      const sim = await simulate(agent, 'submitWork', [BigInt(jobId), url, ZERO_B32]);
      if (!sim.ok) { console.log(`  ${summary} | SUBMIT skip ${agent.name}: ${sim.reason}`); continue; }
      try {
        const r = await writeTx(agent, 'submitWork', [BigInt(jobId), url, ZERO_B32], 1_500_000n);
        console.log(`  ${summary} | SUBMIT by ${agent.name} tx=${r.hash} status=${r.status}${out.fell_back ? ' [runner-fallback]' : ''}`);
        actionsTaken++;
        return 'submit';
      } catch (e) {
        errorCount++;
        console.log(`  ${summary} | SUBMIT fail ${agent.name}: ${e.shortMessage || e.message?.slice(0,120)}`);
      }
    }
  }

  // === STATE: multi-submission mode with an open slot → dispatch a second submitter ===
  // Natural behavior; scenario annotation is NOT consulted here (competitive-workers
  // is an outcome scenario, fills in organically when multi jobs get multiple subs).
  if (job.submissionMode === 1 && job.allowResubmission && subCount < 2) {
    for (const agent of pickAgent(jobId, 'submit')) {
      if (!canSubmitWork(job, agent)) continue;
      // Check agent hasn't already submitted
      let already = false;
      for (let i = 0; i < subCount; i++) {
        const s = await getSub(jobId, i);
        if (s && s.worker.toLowerCase() === agent.address.toLowerCase()) { already = true; break; }
      }
      if (already) continue;
      const out = await agentSubmit(jobId, agent, job);
      const url = out.deliverableUrl;
      const sim = await simulate(agent, 'submitWork', [BigInt(jobId), url, ZERO_B32]);
      if (!sim.ok) continue;
      try {
        const r = await writeTx(agent, 'submitWork', [BigInt(jobId), url, ZERO_B32], 1_500_000n);
        console.log(`  ${summary} | SECOND-SUBMIT by ${agent.name} tx=${r.hash}${out.fell_back ? ' [runner-fallback]' : ''}`);
        actionsTaken++;
        return 'second-submit';
      } catch (e) {
        errorCount++;
        console.log(`  ${summary} | SECOND-SUBMIT fail ${agent.name}: ${e.shortMessage || e.message?.slice(0,120)}`);
      }
    }
  }

  // === STATE: pending submission + agent is validator → approve or reject ===
  if (subCount > 0 && job.activeValidator !== ZERO_ADDR && job.validationMode !== 0) {
    // Only validator can act
    const validator = AGENTS.find(a => a.address.toLowerCase() === job.activeValidator.toLowerCase());
    if (!validator) {
      console.log(`  ${summary} | validator not in swarm, skipping`);
      return null;
    }
    // Find first pending sub
    let pendingIdx = -1;
    for (let i = 0; i < subCount; i++) {
      const s = await getSub(jobId, i);
      if (s && s.subStatus === 0) { pendingIdx = i; break; }
    }
    if (pendingIdx < 0) return null; // nothing pending

    // Fetch the pending submission's details so the validator persona can
    // actually react to them.
    const pendingSub = await getSub(jobId, pendingIdx);
    const out = await runAgent({
      persona: validator.name,
      taskType: 'review',
      context: {
        job: {
          jobId,
          title: job?.title ?? '',
          description: job?.description ?? '',
        },
        submission: {
          workerShort: pendingSub?.worker
            ? `${pendingSub.worker.slice(0, 6)}…${pendingSub.worker.slice(-4)}`
            : 'someone',
          deliverableUrl: pendingSub?.deliverableUrl ?? '',
          note: '',
        },
      },
    });
    const decision = out.decision;
    if (decision === 'reject') {
      const sim = await simulate(validator, 'rejectSubmission', [BigInt(jobId), BigInt(pendingIdx)]);
      if (!sim.ok) { console.log(`  ${summary} | REJECT skip: ${sim.reason}`); return null; }
      try {
        const r = await writeTx(validator, 'rejectSubmission', [BigInt(jobId), BigInt(pendingIdx)], 800_000n);
        console.log(`  ${summary} | REJECT by ${validator.name} sub=${pendingIdx} score=${out.score} tx=${r.hash}${out.fell_back ? ' [runner-fallback]' : ''}`);
        actionsTaken++;
        return 'reject';
      } catch (e) {
        errorCount++;
        console.log(`  ${summary} | REJECT fail: ${e.shortMessage || e.message?.slice(0,120)}`);
      }
    } else {
      // approve — pass the agent's own comment as on-chain feedback
      const feedback = (out.comment || '').slice(0, 400)
        || `Reviewed for job #${jobId}.`;
      const sim = await simulate(validator, 'approveSubmission', [BigInt(jobId), BigInt(pendingIdx), '0x', feedback]);
      if (!sim.ok) { console.log(`  ${summary} | APPROVE skip: ${sim.reason}`); return null; }
      try {
        const r = await writeTx(validator, 'approveSubmission', [BigInt(jobId), BigInt(pendingIdx), '0x', feedback], 1_500_000n);
        console.log(`  ${summary} | APPROVE by ${validator.name} sub=${pendingIdx} score=${out.score} tx=${r.hash}${out.fell_back ? ' [runner-fallback]' : ''}`);
        actionsTaken++;
        return 'approve';
      } catch (e) {
        errorCount++;
        console.log(`  ${summary} | APPROVE fail: ${e.shortMessage || e.message?.slice(0,120)}`);
      }
    }
  }

  // === STATE: all subs rejected → rejectAll cleanup (natural; no scenario gate) ===
  // Inner s10 branch still triggers cancelJob as an event-order steer.
  if (subCount > 0 && job.allowRejectAll && job.status < 2) {
    const validator = AGENTS.find(a => a.address.toLowerCase() === job.activeValidator.toLowerCase());
    if (validator) {
      // Check all subs are rejected (status 2)
      let allRejected = true;
      for (let i = 0; i < subCount; i++) {
        const s = await getSub(jobId, i);
        if (s && s.subStatus !== 2) { allRejected = false; break; }
      }
      if (allRejected) {
        const sim = await simulate(validator, 'rejectAllSubmissions', [BigInt(jobId)]);
        if (sim.ok) {
          try {
            const r = await writeTx(validator, 'rejectAllSubmissions', [BigInt(jobId)], 1_000_000n);
            console.log(`  ${summary} | REJECT-ALL by ${validator.name} tx=${r.hash}`);
            actionsTaken++;
            // s10 follow-up: cancel
            if (scenario === 's10-reject-all-cancel' && actionsTaken < MAX_ACTIONS) {
              const poster = AGENTS.find(a => a.address.toLowerCase() === job.poster.toLowerCase());
              if (poster) {
                const simC = await simulate(poster, 'cancelJob', [BigInt(jobId)]);
                if (simC.ok) {
                  try {
                    const rc = await writeTx(poster, 'cancelJob', [BigInt(jobId)], 1_000_000n);
                    console.log(`  ${summary} | CANCEL by ${poster.name} tx=${rc.hash}`);
                    actionsTaken++;
                  } catch (e) {
                    console.log(`  ${summary} | CANCEL fail: ${e.shortMessage || e.message?.slice(0,120)}`);
                  }
                }
              }
            }
            return 'reject-all';
          } catch (e) {
            console.log(`  ${summary} | REJECT-ALL fail: ${e.shortMessage || e.message?.slice(0,120)}`);
          }
        }
      }
    }
  }

  // === STATE: timed + deadline passed → finalize ===
  if (job.submissionMode === 1 && job.submissionDeadline > 0 &&
      Math.floor(Date.now()/1000) > job.submissionDeadline && job.status < 2) {
    const poster = AGENTS.find(a => a.address.toLowerCase() === job.poster.toLowerCase());
    if (poster) {
      const sim = await simulate(poster, 'finalizeTimedJob', [BigInt(jobId)]);
      if (sim.ok) {
        try {
          const r = await writeTx(poster, 'finalizeTimedJob', [BigInt(jobId)], 1_500_000n);
          console.log(`  ${summary} | FINALIZE by ${poster.name} tx=${r.hash}`);
          actionsTaken++;
          return 'finalize';
        } catch (e) {
          console.log(`  ${summary} | FINALIZE fail: ${e.shortMessage || e.message?.slice(0,120)}`);
        }
      }
    }
  }

  return null;
}

// ============================================================
// Review sweep — per agent, find completed jobs where review needed
// ============================================================
async function reviewSweep(lowJobId, highJobId) {
  for (const agent of AGENTS) {
    if (actionsTaken >= MAX_ACTIONS) break;
    let blocked;
    try {
      blocked = await pub.readContract({ address: RG, abi: RG_ABI, functionName: 'isBlocked', args: [agent.address] });
    } catch { blocked = false; }
    const pendCount = await pub.readContract({ address: RG, abi: RG_ABI, functionName: 'getPendingReviewCount', args: [agent.address] });
    if (Number(pendCount) === 0) continue;
    console.log(`[reviews] ${agent.name} has ${pendCount} pending, blocked=${blocked}`);
    // Scan recent jobs for reviews this agent needs to submit
    for (let jid = highJobId; jid >= lowJobId && actionsTaken < MAX_ACTIONS; jid--) {
      const job = await getJob(jid);
      if (!job || job.status < 2) continue;
      // Identify review counterparties — poster, validator, workers
      const sc = await getSubCount(jid);
      const candidates = new Set();
      candidates.add(job.poster);
      if (job.activeValidator !== ZERO_ADDR) candidates.add(job.activeValidator);
      for (let i = 0; i < sc; i++) {
        const s = await getSub(jid, i);
        if (s) candidates.add(s.worker);
      }
      candidates.delete(agent.address);
      for (const reviewee of candidates) {
        if (actionsTaken >= MAX_ACTIONS) break;
        let required;
        try {
          required = await pub.readContract({
            address: RG, abi: RG_ABI, functionName: 'isReviewRequired',
            args: [BigInt(jid), agent.address, reviewee],
          });
        } catch { required = false; }
        if (!required) continue;
        try {
          const r = await writeRG(agent, 'submitReview', [BigInt(jid), reviewee, 5, `solid-work,job${jid}`], 1_500_000n);
          console.log(`  [review] ${agent.name} → ${reviewee.slice(0,10)} on job#${jid} tx=${r.hash}`);
          actionsTaken++;
        } catch (e) {
          console.log(`  [review] ${agent.name} → ${reviewee.slice(0,10)} FAIL: ${e.shortMessage || e.message?.slice(0,120)}`);
        }
      }
      // Stop scanning if pending count cleared
      const p2 = await pub.readContract({ address: RG, abi: RG_ABI, functionName: 'getPendingReviewCount', args: [agent.address] });
      if (Number(p2) === 0) break;
    }
  }
}

// ============================================================
// Main
// ============================================================
const totalJobs = Number(await pub.readContract({ address: JOB_NFT, abi: JOB_ABI, functionName: 'jobCount', args: [] }));
const highJob = totalJobs; // jobCount returns NEXT id; most recent is jobCount - 1. But we iterate down from jobCount.
const lowJob = Math.max(1, highJob - SCAN_WINDOW);

console.log(`[${RUN_ID}] Scanning jobs ${lowJob}..${highJob - 1} (total on-chain: ${totalJobs})`);

for (let jid = highJob - 1; jid >= lowJob; jid--) {
  if (actionsTaken >= MAX_ACTIONS) break;
  try {
    await progressJob(jid);
  } catch (e) {
    console.log(`[${RUN_ID}] job#${jid} ERROR: ${e.shortMessage || e.message?.slice(0,200)}`);
  }
}

console.log(`[${RUN_ID}] Progression pass done — ${actionsTaken} write actions taken`);

// Review sweep
if (actionsTaken < MAX_ACTIONS) {
  console.log(`[${RUN_ID}] Starting review sweep...`);
  try {
    await reviewSweep(lowJob, highJob - 1);
  } catch (e) {
    console.log(`[${RUN_ID}] review sweep error: ${e.message?.slice(0,200)}`);
  }
}

console.log(`[${RUN_ID}] DONE — total actions: ${actionsTaken}`);

await emitHeartbeat(
  'swarm-drain',
  actionsTaken,
  `drained ${actionsTaken} actions across ${highJob - lowJob} jobs`
);

process.exit(0);
