#!/usr/bin/env node
/**
 * framework/auditor.mjs — STS Phase A General Auditor (Layer 4)
 *
 * Cowork scheduled task. Runs every 30-60 min via Cowork's cron, reads
 * recent orchestration_events + lifecycle_results + on-chain state, and
 * categorizes outcomes. Writes findings to the `audit_findings` table.
 *
 * Per SWARM-V2-DESIGN.md Section 2 Layer 4 — three concerns per run:
 *   A) PASS audit:    questionable_pass detector for terminal-classified jobs
 *   B) FAIL triage:   categorize HLO-flagged failures into buckets
 *   C) SYSTEM audit:  cross-consistency: orphan jobs, scanner lag, daemon silence
 *
 * Failure category schema:
 *   agent_too_dumb   — LLM hallucinated, malformed args, gave up
 *   mcp_product_gap  — MCP tool missing or broken
 *   docs_product_gap — docs unclear, agent stumbled at specific page
 *   correct_enforcement — contract correctly blocked (GOOD signal, not a bug)
 *     sub: pending_review_cap | rating_gate_validator | rating_gate_worker |
 *          not_in_approved_workers | not_in_approved_validators |
 *          hard_only_validator_config | submission_window_closed |
 *          has_pending_or_approved | resubmission_not_allowed | etc.
 *   contract_flaw    — REAL contract bug
 *   infra_issue      — gas, RPC, balance, network
 *
 * Source-of-truth: lib/awp/* (compiled) for rules + revert decoding.
 *
 * Usage: node framework/auditor.mjs [--dry-run] [--lookback-min 60]
 *
 * Required env:
 *   STS_SUPABASE_URL, STS_SUPABASE_KEY (service-role)
 *   ALCHEMY_RPC, AWP_JOBNFT, AWP_RG (or fallback to lib/awp defaults)
 *
 * Categorization is rule-based via lib/awp's decodeRevertReason — no LLM
 * call here. If a future revision needs LLM-assisted categorization, route
 * through framework/onboarding/lib/llm.mjs (Chutes Kimi) or import
 * scripts/swarm-agent-runner.mjs's runAgent. Anthropic is intentionally
 * not used in agent runtime.
 */
import { createPublicClient, http, parseAbi, decodeErrorResult } from 'viem';
import { baseSepolia } from 'viem/chains';

import {
  CONTRACT_ADDRESSES,
  decodeRevertReason,
  V15_ERROR_NAMES,
  V4_ERROR_NAMES,
  parseConfigKey,
} from '../lib/awp/index.js';

// ─────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────
const ALCHEMY_RPC = process.env.ALCHEMY_RPC
  || 'https://base-sepolia.g.alchemy.com/v2/xlgHg3R-suQ_fJKc3vN39';
const JOBNFT_V15 = process.env.AWP_JOBNFT  || CONTRACT_ADDRESSES.JobNFT;
const REVIEWGATE = process.env.AWP_RG      || CONTRACT_ADDRESSES.ReviewGate;
const STS_URL = process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
const STS_KEY = process.env.STS_SUPABASE_KEY;

const ARGV = process.argv;
const DRY_RUN = ARGV.includes('--dry-run');
const LOOKBACK_MIN = parseInt(argVal('--lookback-min', '60'));

function argVal(flag, def) {
  const i = ARGV.indexOf(flag);
  return (i >= 0 && i + 1 < ARGV.length) ? ARGV[i + 1] : def;
}

const pub = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_RPC) });

// ─────────────────────────────────────────────────────────────────
// Supabase helpers
// ─────────────────────────────────────────────────────────────────
async function pgGet(pathAndQuery) {
  const r = await fetch(`${STS_URL}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Supabase GET ${pathAndQuery} -> ${r.status}: ${txt.slice(0, 240)}`);
  }
  return r.json();
}

async function pgPost(table, row) {
  if (DRY_RUN) {
    console.log(`  [DRY POST ${table}] ${JSON.stringify(row).slice(0, 240)}`);
    return;
  }
  const r = await fetch(`${STS_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.log(`  [WARN ${table} insert] ${r.status}: ${txt.slice(0, 240)}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// A) PASS audit — find questionable passes among terminal lifecycle rows
// ─────────────────────────────────────────────────────────────────
async function auditPasses(lookbackMin) {
  const since = new Date(Date.now() - lookbackMin * 60_000).toISOString();
  let rows = [];
  try {
    rows = await pgGet(
      `lifecycle_results?project_id=eq.awp&status=eq.passed&completed_at=gte.${since}&limit=200`
    );
  } catch (e) {
    return { findings: [], error: e.message };
  }

  const findings = [];
  for (const row of rows) {
    // Heuristics for questionable_pass:
    //   - steps[] is empty but status=passed (scanner shortcut)
    //   - scenario claims approved=1 but no SubmissionApproved step in events
    //   - terminal scenario doesn't match the recorded predicate's preconditions
    const steps = row.steps || [];
    const hasApproveStep = steps.some(s => s.name === 'SubmissionApproved' || s.name === 'AllSubmissionsRejected');
    if (steps.length === 0) {
      findings.push({
        project_id: 'awp',
        category: 'questionable_pass',
        sub_category: 'no_steps_recorded',
        severity: 'medium',
        evidence_links: [{ type: 'lifecycle_row', value: row.id }, { type: 'job_id', value: row.onchain_job_id }],
        related_lifecycle_row_id: row.id,
        related_job_id: row.onchain_job_id,
        description: `Job ${row.onchain_job_id} classified as ${row.scenario_key} but lifecycle row has empty steps[]. Scanner may have classified from on-chain state without verifying event sequence.`,
        suggested_action: 'Re-run scanner on this job range; if still empty, predicate may be too lax.',
      });
      continue;
    }
    const wantsApproval = ['s01-happy-path', 's02-validator-first', 's03-competitive-workers',
                          's04-rejection-loop', 's12-rating-gate-pass', 's16-multiple-submissions'].includes(row.scenario_key);
    if (wantsApproval && !hasApproveStep) {
      findings.push({
        project_id: 'awp',
        category: 'questionable_pass',
        sub_category: 'missing_approve_step',
        severity: 'medium',
        evidence_links: [{ type: 'lifecycle_row', value: row.id }, { type: 'job_id', value: row.onchain_job_id }],
        related_lifecycle_row_id: row.id,
        related_job_id: row.onchain_job_id,
        description: `Job ${row.onchain_job_id} classified as ${row.scenario_key} (expects SubmissionApproved) but no approve step in steps[].`,
        suggested_action: 'Verify on-chain via getJobV15 + event log; predicate may be miscounting.',
      });
    }
  }
  return { findings, count: rows.length };
}

// ─────────────────────────────────────────────────────────────────
// B) FAIL triage — categorize recent failures
// ─────────────────────────────────────────────────────────────────
async function triageFails(lookbackMin) {
  const since = new Date(Date.now() - lookbackMin * 60_000).toISOString();
  let events = [];
  try {
    // Pull HLO error events + dispatch_unverified events
    events = await pgGet(
      `orchestration_events?project_id=eq.awp&ran_at=gte.${since}&` +
      `event_type=in.(hlo_error,dispatch_failed,dispatch_unverified,error,skip)&limit=200`
    );
  } catch (e) {
    return { findings: [], error: e.message };
  }

  const findings = [];
  for (const ev of events) {
    const meta = ev.meta || {};
    const errorMsg = meta.error || meta.leak_error || meta.dispatch_error || '';
    const matchedRules = decodeRevertReason(errorMsg);
    const cat = matchedRules.length > 0 ? matchedRules[0].failureCategory : 'agent_too_dumb';
    const sub = matchedRules.length > 0 ? matchedRules[0].failureSubcategory : null;

    findings.push({
      project_id: 'awp',
      category: cat,
      sub_category: sub,
      severity: cat === 'contract_flaw' ? 'high' : cat === 'correct_enforcement' ? 'info' : 'medium',
      evidence_links: [
        { type: 'orchestration_event', value: ev.id },
        ...(ev.tx_hash ? [{ type: 'tx_hash', value: ev.tx_hash }] : []),
        ...(meta.intended_config ? [{ type: 'intended_config', value: meta.intended_config }] : []),
        ...(meta.intended_scenario ? [{ type: 'intended_scenario', value: meta.intended_scenario }] : []),
      ],
      related_dispatch_id: ev.id,
      related_job_id: ev.job_id || null,
      description: `${ev.event_type} on ${ev.persona || 'unknown'}: ${errorMsg.slice(0, 240) || 'no error message'}`,
      suggested_action:
        cat === 'correct_enforcement' ? 'No action — contract enforced as designed.' :
        cat === 'contract_flaw' ? 'URGENT: review contract behavior against spec.' :
        cat === 'mcp_product_gap' ? 'File MCP server gap; check awp-protocol-mcp coverage.' :
        cat === 'docs_product_gap' ? 'Check /agent-docs section the agent stumbled on.' :
        cat === 'infra_issue' ? 'Check gas/USDC/RPC; may auto-resolve next tick.' :
        'Examine agent session log for tool-use errors.',
    });
  }
  return { findings, count: events.length };
}

// ─────────────────────────────────────────────────────────────────
// C) SYSTEM audit — orphans, lag, silence
// ─────────────────────────────────────────────────────────────────
async function systemAudit(lookbackMin) {
  const findings = [];
  const since = new Date(Date.now() - lookbackMin * 60_000).toISOString();

  // Heartbeat freshness check
  let beats = [];
  try {
    beats = await pgGet(`system_heartbeats?project_id=eq.awp&ran_at=gte.${since}&select=component,outcome,ran_at&limit=200`);
  } catch (e) {
    findings.push({
      project_id: 'awp',
      category: 'infra_issue',
      sub_category: 'heartbeats_unreachable',
      severity: 'high',
      evidence_links: [{ type: 'error', value: e.message }],
      description: `Auditor could not reach system_heartbeats (${e.message.slice(0, 200)}).`,
      suggested_action: 'Check Supabase reachability + service-role key.',
    });
  }
  const components = ['hlo-daemon', 'sts-scanner-v15', 'auditor'];
  const now = Date.now();
  const seenByComponent = new Map();
  for (const b of beats) {
    if (!seenByComponent.has(b.component) || new Date(b.ran_at) > new Date(seenByComponent.get(b.component).ran_at)) {
      seenByComponent.set(b.component, b);
    }
  }
  for (const c of components) {
    const last = seenByComponent.get(c);
    if (!last) {
      findings.push({
        project_id: 'awp',
        category: 'infra_issue',
        sub_category: 'heartbeat_silent',
        severity: 'high',
        evidence_links: [{ type: 'component', value: c }, { type: 'lookback_min', value: lookbackMin }],
        description: `Component "${c}" emitted no heartbeat in the last ${lookbackMin} min.`,
        suggested_action: c === 'hlo-daemon' ? 'Check `pm2 logs hlo-daemon` on VPS.' :
                          c === 'sts-scanner-v15' ? 'Check `pm2 logs scanner-v15` on VPS.' :
                          'Check Cowork scheduled task status for auditor.',
      });
      continue;
    }
    const ageMs = now - new Date(last.ran_at).getTime();
    if (ageMs > 30 * 60_000) { // 30 min
      findings.push({
        project_id: 'awp',
        category: 'infra_issue',
        sub_category: 'heartbeat_stale',
        severity: 'medium',
        evidence_links: [{ type: 'component', value: c }, { type: 'last_ran_at', value: last.ran_at }, { type: 'age_min', value: Math.round(ageMs / 60_000) }],
        description: `Component "${c}" last heartbeat was ${Math.round(ageMs / 60_000)} min ago.`,
        suggested_action: 'Restart the component if pm2 shows it stopped.',
      });
    }
  }

  // Scanner lag — compare on-chain jobCount to recently-classified rows
  try {
    const ABI = parseAbi(['function jobCount() view returns (uint256)']);
    const onChainJobCount = Number(await pub.readContract({ address: JOBNFT_V15, abi: ABI, functionName: 'jobCount' }));
    const recentLifecycle = await pgGet(`lifecycle_results?project_id=eq.awp&select=onchain_job_id&order=onchain_job_id.desc&limit=1`);
    const lastClassified = recentLifecycle[0]?.onchain_job_id ?? 0;
    const lag = onChainJobCount - lastClassified;
    if (lag > 10) {
      findings.push({
        project_id: 'awp',
        category: 'infra_issue',
        sub_category: 'scanner_lag',
        severity: lag > 30 ? 'high' : 'medium',
        evidence_links: [
          { type: 'on_chain_job_count', value: onChainJobCount },
          { type: 'last_classified_job_id', value: lastClassified },
          { type: 'lag', value: lag },
        ],
        description: `Scanner is ${lag} jobs behind on-chain (chain=${onChainJobCount}, last classified=${lastClassified}).`,
        suggested_action: 'Check scanner pm2 status + cron schedule; may be hitting RPC chunk failures.',
      });
    }
  } catch (e) {
    findings.push({
      project_id: 'awp',
      category: 'infra_issue',
      sub_category: 'scanner_lag_check_failed',
      severity: 'low',
      evidence_links: [{ type: 'error', value: e.message }],
      description: `Auditor couldn't check scanner lag: ${e.message.slice(0, 200)}.`,
      suggested_action: 'Verify ALCHEMY_RPC + AWP_JOBNFT env in Cowork scheduled task.',
    });
  }

  return { findings };
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== STS Auditor (Phase A) ===');
  console.log(`Lookback:  ${LOOKBACK_MIN} min`);
  console.log(`Mode:      ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  const t0 = Date.now();

  if (!STS_KEY) {
    console.error('STS_SUPABASE_KEY required (service-role) — falling back to dry run.');
  }

  const passResults  = await auditPasses(LOOKBACK_MIN).catch(e => ({ findings: [], error: e.message }));
  const failResults  = await triageFails(LOOKBACK_MIN).catch(e => ({ findings: [], error: e.message }));
  const sysResults   = await systemAudit(LOOKBACK_MIN).catch(e => ({ findings: [], error: e.message }));

  const allFindings = [
    ...(passResults.findings || []),
    ...(failResults.findings || []),
    ...(sysResults.findings  || []),
  ];

  console.log(`Findings:  pass=${passResults.findings?.length || 0} fail=${failResults.findings?.length || 0} system=${sysResults.findings?.length || 0}`);

  for (const f of allFindings) {
    await pgPost('audit_findings', f);
  }

  // Heartbeat
  if (!DRY_RUN && STS_KEY) {
    await pgPost('system_heartbeats', {
      project_id: 'awp',
      component: 'auditor',
      outcome: 'ok',
      actions_count: allFindings.length,
      note: `wrote ${allFindings.length} findings`,
      meta: {
        pass_count: passResults.findings?.length || 0,
        fail_count: failResults.findings?.length || 0,
        sys_count: sysResults.findings?.length || 0,
        duration_ms: Date.now() - t0,
        lookback_min: LOOKBACK_MIN,
      },
    });
  }

  console.log(`DONE — ${allFindings.length} findings (${(Date.now() - t0) / 1000}s)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
