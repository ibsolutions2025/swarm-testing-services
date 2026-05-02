// framework/indexer.mjs — Phase B indexer.
//
// Pure event/receipt indexing. No classification, no DB writes for verdicts.
// Indexer produces normalized records that the verifier and aggregator consume.
//
// Outputs (per tick):
//   - eventsByJob:     Map<jobId, RawLog[]>  (logs from JobNFT_V15 + ReviewGate_V4)
//   - jobStateById:    Map<jobId, JobView>   (current on-chain state)
//   - submissionsById: Map<jobId, SubmissionView[]>
//   - txAttemptsByJob: Map<jobId, TxAttemptSummary[]>  (loaded from Supabase)
//   - failedRanges:    [{from, to}]                   (block ranges that errored)
//
// Design notes:
//   - Reuses prefetchLogs / readJob / readAllSubmissions from the legacy
//     scanner. Same Alchemy patterns.
//   - tx_attempts loaded for jobs touched this tick only — keeps payload small.
//   - getTxReceipt fills outcome + revert_reason for any tx_attempts rows in
//     'pending' state. This is what closes the loop for negative scenarios.

import { createPublicClient, http, parseAbi, decodeErrorResult } from 'viem';
import { baseSepolia } from 'viem/chains';

import { JOB_NFT_ABI } from '../lib/awp/contracts.js';
import { V15_ERROR_NAMES, V4_ERROR_NAMES } from '../lib/awp/rules.js';

// ─────────────────────────────────────────────────────────────────
// ABI for the read methods
// ─────────────────────────────────────────────────────────────────
const READ_ABI = parseAbi([
  'function jobCount() view returns (uint256)',
  'function getSubmissionCount(uint256) view returns (uint256)',
  'function getJobV15(uint256 jobId) view returns (address poster,uint256 reward,uint8 status,address activeValidator,address[] validatorWaitlist,uint256 validatorTimeout,bool openValidation,string title,string description,string requirementsJson,uint256 claimWindowHours,uint8 validationMode,uint8 submissionMode,uint256 submissionWindow,string validationScriptCID,bool requireSecurityAudit,string securityAuditTemplate,uint256 submissionDeadline,bool allowResubmission,bool allowRejectAll,address[] approvedWorkers,string validationInstructions,uint256 minWorkerRating,uint256 minValidatorRating)',
  'function getSubmissionV11(uint256,uint256) view returns (address worker,string deliverableUrl,bytes32 encryptedDeliverableHash,uint256 timestamp,uint8 status,bytes decryptionKey,bytes32 scriptResultHash,uint256 scriptScore,bool scriptPassed,string securityAuditCID)'
]);

const PREFETCH_CHUNK = 10000n;

export class Indexer {
  constructor({ alchemyRpc, jobNFT, reviewGate, deployBlock, stsUrl, stsKey }) {
    this.rpcUrl = alchemyRpc;
    this.jobNFT = jobNFT;
    this.reviewGate = reviewGate;
    this.deployBlock = BigInt(deployBlock);
    this.stsUrl = stsUrl;
    this.stsKey = stsKey;
    this.pub = createPublicClient({ chain: baseSepolia, transport: http(alchemyRpc) });
  }

  async rpc(method, params) {
    const r = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    if (!r.ok) throw new Error(`Alchemy ${method} HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`Alchemy ${method}: ${j.error.message}`);
    return j.result;
  }

  toHex(n) { return '0x' + BigInt(n).toString(16); }

  async getLatestBlock() {
    return BigInt(await this.rpc('eth_blockNumber', []));
  }

  async getJobCount() {
    return Number(await this.pub.readContract({
      address: this.jobNFT, abi: READ_ABI, functionName: 'jobCount',
    }));
  }

  // Returns { byJob: Map<jobId, log[]>, failedRanges: [{from, to}] }
  async prefetchLogs(address, fromBlock, toBlock, label) {
    const byJob = new Map();
    const failedRanges = [];
    let totalLogs = 0;
    for (let f = fromBlock; f <= toBlock; f += PREFETCH_CHUNK) {
      const t = (f + PREFETCH_CHUNK - 1n) > toBlock ? toBlock : (f + PREFETCH_CHUNK - 1n);
      let logs = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          logs = await this.rpc('eth_getLogs', [{
            address, fromBlock: this.toHex(f), toBlock: this.toHex(t), topics: []
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

  async readJob(jobId) {
    const r = await this.pub.readContract({
      address: this.jobNFT, abi: READ_ABI, functionName: 'getJobV15', args: [BigInt(jobId)],
    });
    return {
      id: jobId,
      poster: r[0],
      reward: r[1],
      status: Number(r[2]),
      activeValidator: r[3],
      validatorWaitlist: r[4],
      validatorTimeout: Number(r[5]),
      openValidation: r[6],
      title: r[7],
      description: r[8],
      requirementsJson: r[9],
      claimWindowHours: Number(r[10]),
      validationMode: Number(r[11]),
      submissionMode: Number(r[12]),
      submissionWindow: Number(r[13]),
      validationScriptCID: r[14],
      requireSecurityAudit: r[15],
      securityAuditTemplate: r[16],
      submissionDeadline: Number(r[17]),
      allowResubmission: r[18],
      allowRejectAll: r[19],
      approvedWorkers: r[20],
      validationInstructions: r[21],
      minWorkerRating: Number(r[22]),
      minValidatorRating: Number(r[23]),
    };
  }

  async readAllSubmissions(jobId) {
    const count = Number(await this.pub.readContract({
      address: this.jobNFT, abi: READ_ABI, functionName: 'getSubmissionCount', args: [BigInt(jobId)],
    }));
    const subs = [];
    for (let i = 0; i < count; i++) {
      const r = await this.pub.readContract({
        address: this.jobNFT, abi: READ_ABI, functionName: 'getSubmissionV11', args: [BigInt(jobId), BigInt(i)],
      });
      subs.push({
        worker: r[0],
        deliverableUrl: r[1],
        timestamp: Number(r[3]),
        status: Number(r[4]),
        scriptResultHash: r[6],
        scriptScore: Number(r[7]),
        scriptPassed: r[8],
      });
    }
    return subs;
  }

  // ─────────────────────────────────────────────────────────────────
  // tx_attempts loader — pulls all rows for a project, optionally filtered
  // by job id. Verifier groups by intended_job_id.
  // ─────────────────────────────────────────────────────────────────
  async loadTxAttempts({ projectId = 'awp', jobIds = null } = {}) {
    if (!this.stsKey) return new Map();
    const headers = { apikey: this.stsKey, Authorization: `Bearer ${this.stsKey}` };
    let url = `${this.stsUrl}/rest/v1/tx_attempts?project_id=eq.${projectId}&select=*&limit=10000`;
    if (jobIds && jobIds.length > 0 && jobIds.length < 100) {
      const list = jobIds.join(',');
      url += `&intended_job_id=in.(${list})`;
    }
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) return new Map();
      const rows = await r.json();
      const byJob = new Map();
      for (const row of rows) {
        const jid = row.intended_job_id;
        if (jid == null) continue;
        if (!byJob.has(jid)) byJob.set(jid, []);
        byJob.get(jid).push(row);
      }
      return byJob;
    } catch {
      return new Map();
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // For 'pending' tx_attempts, fetch receipts and update outcome +
  // revert_reason. This is what closes the loop for negative scenarios.
  // Returns the list of rows whose outcome flipped.
  // ─────────────────────────────────────────────────────────────────
  async fillPendingReceipts({ projectId = 'awp' } = {}) {
    if (!this.stsKey) return { updated: 0 };
    const headers = { apikey: this.stsKey, Authorization: `Bearer ${this.stsKey}` };
    const url = `${this.stsUrl}/rest/v1/tx_attempts?project_id=eq.${projectId}&outcome=eq.pending&select=id,tx_hash,intended_action,actor&limit=200`;
    let pending;
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) return { updated: 0 };
      pending = await r.json();
    } catch {
      return { updated: 0 };
    }
    let updated = 0;
    for (const row of pending) {
      try {
        const rcpt = await this.rpc('eth_getTransactionReceipt', [row.tx_hash]);
        if (!rcpt) continue;
        let outcome = 'success';
        let revertReason = null;
        let rawRevertData = null;
        if (rcpt.status === '0x0') {
          outcome = 'reverted';
          // Try to fetch revert data via eth_call with the original tx params.
          try {
            const tx = await this.rpc('eth_getTransactionByHash', [row.tx_hash]);
            if (tx) {
              try {
                await this.rpc('eth_call', [{ to: tx.to, from: tx.from, data: tx.input, value: tx.value }, tx.blockNumber]);
              } catch (callErr) {
                const msg = String(callErr.message || '');
                rawRevertData = msg;
                revertReason = decodeRevertName(msg);
              }
            }
          } catch { /* best effort */ }
        }
        const patch = {
          outcome,
          revert_reason: revertReason,
          raw_revert_data: rawRevertData,
          block_number: rcpt.blockNumber ? Number(BigInt(rcpt.blockNumber)) : null,
        };
        await fetch(`${this.stsUrl}/rest/v1/tx_attempts?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(patch),
        });
        updated++;
      } catch { /* skip; try again next tick */ }
    }
    return { updated };
  }
}

// ─────────────────────────────────────────────────────────────────
// Decode V15/V4 custom error names from a viem-style revert message
// ─────────────────────────────────────────────────────────────────
function decodeRevertName(msg) {
  if (!msg) return null;
  // Look for any known V15 / V4 error name as a substring of the message.
  for (const name of V15_ERROR_NAMES) {
    if (msg.includes(name)) return name;
  }
  for (const name of V4_ERROR_NAMES) {
    if (msg.includes(name)) return name;
  }
  // Common viem prefixes for revert strings
  const m = msg.match(/reverted with reason string\s*"([^"]+)"/);
  if (m) return m[1].slice(0, 200);
  const m2 = msg.match(/reverted with the following reason:\s*([^\n]+)/);
  if (m2) return m2[1].trim().slice(0, 200);
  return null;
}
