// framework/verifier.mjs — Phase B per-job verifier.
//
// Given (jobId, indexed events, tx_attempts, on-chain state, intent), produce
// a verdict. The verdict carries:
//
//   - canonical config_key + scenario_key (derived from OBSERVED state at terminal)
//   - status: passed | partial | failed | running | config_mismatch
//   - per-step verdicts (each: passed | failed | missing | unexpected)
//   - intent_matched (true | false | null)
//   - verification_failures (empty when passed)
//
// Cell membership = observed scenario at terminal (s00-in-flight if not yet
// terminal). Pre-terminal rows display under HLO's intended cell only for
// visualization.
//
// See clients/.shared/PHASE-B-VERIFIER-SPEC.md.

import { SIG_TO_NAME } from '../lib/awp/events.js';
import { classifyAllMatches, computeCounts, ZERO_ADDRESS } from '../lib/awp/cell-defs.js';
import { parseConfigKey, jobStateToConfigKey } from '../lib/awp/matrix.js';
import { generateLifecycle } from '../lib/awp/generate-lifecycle.js';
import { isCellApplicable } from '../lib/awp/cell-defs.js';

// ─────────────────────────────────────────────────────────────────
// Decode a raw log into a normalized event the verifier consumes.
// ─────────────────────────────────────────────────────────────────
function decodeLog(log) {
  const sig = log.topics?.[0]?.toLowerCase();
  const name = SIG_TO_NAME[sig];
  if (!name) return null;
  const out = {
    name,
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex || '0x0')),
    txHash: log.transactionHash,
    actor: null,           // best-effort actor extraction
    args: {},              // full decoded args (best effort)
    rawTopics: log.topics,
    rawData: log.data,
  };

  // Pull indexed actor where applicable (matches lib/awp/events.ts decoder).
  const t2 = log.topics?.[2];
  const t3 = log.topics?.[3];
  const addrFromTopic = (topic) => {
    if (!topic || typeof topic !== 'string') return null;
    const hex = topic.toLowerCase().replace(/^0x/, '');
    if (hex.length !== 64) return null;
    return '0x' + hex.slice(24);
  };

  switch (name) {
    case 'JobCreated':
    case 'JobCancelled':
      out.actor = addrFromTopic(t2);
      out.args.poster = out.actor;
      break;
    case 'ValidatorClaimed':
    case 'ValidatorRewarded':
    case 'AllSubmissionsRejected':
      out.actor = addrFromTopic(t2);
      out.args.validator = out.actor;
      break;
    case 'WorkSubmitted':
      out.actor = addrFromTopic(t2);
      out.args.worker = out.actor;
      break;
    case 'SubmissionApproved':
      // V15 SubmissionApproved indexes (jobId, submissionIndex, worker). The
      // approver itself is NOT indexed — it's implicit, either the
      // job.activeValidator (SOFT_ONLY/HARDSIFT) or address(0)/contract self
      // (HARD_ONLY auto-approve). We don't extract an actor from the event;
      // verifyEventStep falls back to jobView.activeValidator when checking
      // actor_role === 'validator', and treats actor_role === 'contract' as
      // satisfied for HARD_ONLY auto-approve.
      out.actor = null;
      out.args.worker = addrFromTopic(t3);
      break;
    case 'SubmissionRejected':
      // Indexed: jobId, submissionIndex, validator
      out.actor = addrFromTopic(t3);
      out.args.validator = out.actor;
      break;
    case 'ValidatorRotated':
      // Indexed: jobId, oldValidator, newValidator
      out.actor = addrFromTopic(t3);
      out.args.oldValidator = addrFromTopic(t2);
      out.args.newValidator = out.actor;
      break;
    case 'ScriptResultRecorded': {
      // ScriptResultRecorded(uint256 indexed jobId, uint256 submissionIndex, bool scriptPassed, uint256 scriptScore)
      // Args 2..3 are non-indexed. Decode from data.
      const data = (log.data || '0x').replace(/^0x/, '');
      // 3 uint-sized words: submissionIndex, scriptPassed (uint8), scriptScore
      if (data.length >= 192) {
        try {
          out.args.submissionIndex = Number(BigInt('0x' + data.slice(0, 64)));
          const passedHex = data.slice(64, 128);
          out.args.scriptPassed = BigInt('0x' + passedHex) !== 0n;
          out.args.passed = out.args.scriptPassed; // alias
          out.args.scriptScore = Number(BigInt('0x' + data.slice(128, 192)));
        } catch { /* decode failure — leave args empty */ }
      }
      break;
    }
    case 'TimedJobFinalized':
      // TimedJobFinalized(jobId indexed, winnerIndex, winner)
      try {
        const data = (log.data || '0x').replace(/^0x/, '');
        if (data.length >= 64) {
          out.args.winnerIndex = '0x' + data.slice(0, 64);
        }
      } catch { /* skip */ }
      break;
    case 'ReviewSubmitted':
      out.actor = addrFromTopic(t2); // reviewer
      out.args.reviewer = addrFromTopic(t2);
      out.args.reviewee = addrFromTopic(t3);
      break;
    default:
      // Unknown actor for this event name — leave actor null
      break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Verify a single step against the indexed event log.
// Returns { status: 'passed'|'failed'|'missing'|'unexpected', step_index, reason?, expected?, observed?, tx_hash?, block? }
// ─────────────────────────────────────────────────────────────────
function verifyEventStep(stepDef, decodedEvents, jobView, personaMap = {}) {
  const matching = decodedEvents.filter(e => {
    if (e.name !== stepDef.event) return false;
    if (typeof stepDef.args_predicate === 'function') {
      try {
        if (!stepDef.args_predicate(e.args || {})) return false;
      } catch { return false; }
    }
    return true;
  });

  const cardMin = stepDef.cardinality_min ?? 1;
  const cardMax = stepDef.cardinality_max;

  // Cardinality 0 = NEGATIVE step ("must NOT have happened")
  if (cardMax === 0) {
    if (matching.length > 0) {
      return {
        status: 'unexpected',
        step_index: stepDef.index,
        reason: 'forbidden_event_emitted',
        expected: { event: stepDef.event, cardinality_max: 0 },
        observed: { count: matching.length, tx_hash: matching[0]?.txHash },
      };
    }
    return { status: 'passed', step_index: stepDef.index };
  }

  if (matching.length < cardMin) {
    return {
      status: 'missing',
      step_index: stepDef.index,
      reason: 'event_not_emitted_or_predicate_failed',
      expected: { event: stepDef.event, cardinality_min: cardMin },
      observed: { count: matching.length },
    };
  }

  if (cardMax != null && matching.length > cardMax) {
    return {
      status: 'failed',
      step_index: stepDef.index,
      reason: 'cardinality_exceeded',
      expected: { event: stepDef.event, cardinality_max: cardMax },
      observed: { count: matching.length },
    };
  }

  // Actor verification — only when actor_role is set on the step.
  if (stepDef.actor_role && stepDef.actor_role !== 'any') {
    const expectedActors = resolveActorPool(stepDef.actor_role, jobView, personaMap);
    // 'contract' role is always satisfied — V15 HARD_ONLY auto-approve has no
    // emitting party (event.actor is null) and the worker shows up in topic[3].
    // We accept any cardinality-OK event for actor_role='contract'.
    if (stepDef.actor_role === 'contract') {
      // pass-through
    } else if (expectedActors !== null && expectedActors.length > 0) {
      const matchedWithRightActor = matching.find(e => {
        // For events where the actor isn't in the topic set (e.g. SubmissionApproved),
        // event.actor is null. In that case we accept it — the implicit actor is
        // job.activeValidator which IS in expectedActors when actor_role='validator'.
        if (!e.actor) return true;
        const actorLower = e.actor.toLowerCase();
        return expectedActors.includes(actorLower);
      });
      if (!matchedWithRightActor) {
        return {
          status: 'failed',
          step_index: stepDef.index,
          reason: 'wrong_actor',
          expected: { actor_role: stepDef.actor_role, pool: expectedActors.slice(0, 3) },
          observed: { actor: matching[0].actor, tx_hash: matching[0].txHash },
        };
      }
    }
  }

  return {
    status: 'passed',
    step_index: stepDef.index,
    tx_hash: matching[0].txHash,
    block: matching[0].blockNumber,
  };
}

// ─────────────────────────────────────────────────────────────────
// Resolve actor_role to a list of allowed lowercased addresses.
// Falls back to null when persona_map can't supply (e.g. for "any").
// ─────────────────────────────────────────────────────────────────
function resolveActorPool(role, jobView, personaMap) {
  switch (role) {
    case 'poster':
      return jobView?.poster ? [jobView.poster.toLowerCase()] : null;
    case 'validator':
    case 'validator2':
      // Accept active validator + waitlist + persona-mapped validator(s)
      const out = [];
      if (jobView?.activeValidator && jobView.activeValidator.toLowerCase() !== ZERO_ADDRESS) {
        out.push(jobView.activeValidator.toLowerCase());
      }
      for (const w of jobView?.validatorWaitlist || []) out.push(w.toLowerCase());
      if (personaMap.validator) out.push(personaMap.validator.toLowerCase());
      if (personaMap.validator2) out.push(personaMap.validator2.toLowerCase());
      return out.length > 0 ? out : null;
    case 'worker':
    case 'worker1':
    case 'worker2':
      // Workers come from submissions (verifier passes via personaMap when known)
      if (personaMap.worker) return [personaMap.worker.toLowerCase()];
      if (personaMap.workers) return personaMap.workers.map(w => w.toLowerCase());
      // Allow approvedWorkers when the job is gated
      if (jobView?.approvedWorkers?.length > 0) {
        return jobView.approvedWorkers.map(w => w.toLowerCase());
      }
      return null;
    case 'reviewer':
      return null; // any reviewer (V4 routes randomly)
    case 'contract':
      return [ZERO_ADDRESS];
    case 'any':
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Verify a revert (negative) step against tx_attempts.
// ─────────────────────────────────────────────────────────────────
function verifyRevertStep(stepDef, txAttempts) {
  const matching = (txAttempts || []).filter(t => t.intended_action === stepDef.action);
  if (matching.length === 0) {
    return {
      status: 'missing',
      step_index: stepDef.index,
      reason: 'no_attempt_indexed',
      expected: { action: stepDef.action, expected_error: stepDef.expected_error },
    };
  }
  // Prefer reverted attempts
  const reverted = matching.find(t => t.outcome === 'reverted');
  if (!reverted) {
    return {
      status: 'failed',
      step_index: stepDef.index,
      reason: 'expected_revert_but_succeeded',
      expected: { action: stepDef.action, expected_error: stepDef.expected_error },
      observed: { outcomes: matching.map(t => t.outcome) },
    };
  }
  if (stepDef.expected_error && reverted.revert_reason &&
      !reverted.revert_reason.includes(stepDef.expected_error)) {
    return {
      status: 'failed',
      step_index: stepDef.index,
      reason: 'wrong_revert_error',
      expected: { error: stepDef.expected_error },
      observed: { revert_reason: reverted.revert_reason, tx_hash: reverted.tx_hash },
    };
  }
  return { status: 'passed', step_index: stepDef.index, tx_hash: reverted.tx_hash };
}

// ─────────────────────────────────────────────────────────────────
// Apply step-level ORDER predicates referenced by order_predicate_id.
// Returns a list of step results (overrides) keyed by step_index.
// ─────────────────────────────────────────────────────────────────
function applyOrderPredicates(steps, decodedEvents) {
  const overrides = new Map();
  for (const step of steps) {
    if (!step.order_predicate_id) continue;
    switch (step.order_predicate_id) {
      case 'validator-claim-before-first-work': {
        const vc = decodedEvents.find(e => e.name === 'ValidatorClaimed');
        const ws = decodedEvents.find(e => e.name === 'WorkSubmitted');
        if (vc && ws && vc.blockNumber > ws.blockNumber) {
          overrides.set(step.index, {
            status: 'failed',
            step_index: step.index,
            reason: 'order_violation',
            expected: 'ValidatorClaimed before first WorkSubmitted',
            observed: { vc_block: vc.blockNumber, ws_block: ws.blockNumber },
          });
        }
        break;
      }
      case 'distinct-worker-from-prev-step': {
        const subs = decodedEvents.filter(e => e.name === 'WorkSubmitted');
        const distinct = new Set(subs.map(s => (s.actor || '').toLowerCase()).filter(Boolean));
        if (distinct.size < 2) {
          overrides.set(step.index, {
            status: 'failed',
            step_index: step.index,
            reason: 'workers_not_distinct',
            expected: 'distinctWorkers >= 2',
            observed: { distinct: distinct.size },
          });
        }
        break;
      }
      case 'distinct-validators': {
        const vcs = decodedEvents.filter(e => e.name === 'ValidatorClaimed');
        const distinct = new Set(vcs.map(s => (s.actor || '').toLowerCase()).filter(Boolean));
        if (distinct.size < 2) {
          overrides.set(step.index, {
            status: 'failed',
            step_index: step.index,
            reason: 'validators_not_distinct',
            expected: 'distinct ValidatorClaimed >= 2',
            observed: { distinct: distinct.size },
          });
        }
        break;
      }
      case 'before-final-approve': {
        const rejected = decodedEvents.filter(e => e.name === 'SubmissionRejected');
        const approved = decodedEvents.find(e => e.name === 'SubmissionApproved');
        if (approved && rejected.length > 0) {
          const lastRejBlock = Math.max(...rejected.map(r => r.blockNumber));
          if (lastRejBlock > approved.blockNumber) {
            overrides.set(step.index, {
              status: 'failed',
              step_index: step.index,
              reason: 'order_violation',
              expected: 'rejection before final approval',
              observed: { last_rej_block: lastRejBlock, approve_block: approved.blockNumber },
            });
          }
        }
        break;
      }
      case 'cancel-after-rejectAll': {
        const ar = decodedEvents.find(e => e.name === 'AllSubmissionsRejected');
        const jc = decodedEvents.find(e => e.name === 'JobCancelled');
        if (ar && jc && ar.blockNumber > jc.blockNumber) {
          overrides.set(step.index, {
            status: 'failed',
            step_index: step.index,
            reason: 'order_violation',
            expected: 'AllSubmissionsRejected before JobCancelled',
            observed: { ar_block: ar.blockNumber, jc_block: jc.blockNumber },
          });
        }
        break;
      }
      case 'before-validator-claim': {
        const srr = decodedEvents.find(e => e.name === 'ScriptResultRecorded');
        const vc = decodedEvents.find(e => e.name === 'ValidatorClaimed');
        if (srr && vc && srr.blockNumber > vc.blockNumber) {
          overrides.set(step.index, {
            status: 'failed',
            step_index: step.index,
            reason: 'order_violation',
            expected: 'ScriptResultRecorded before ValidatorClaimed',
            observed: { srr_block: srr.blockNumber, vc_block: vc.blockNumber },
          });
        }
        break;
      }
      case 'second-validator-after-rotation': {
        const vcs = decodedEvents.filter(e => e.name === 'ValidatorClaimed');
        const vr = decodedEvents.find(e => e.name === 'ValidatorRotated');
        if (vcs.length >= 2 && vr) {
          const second = vcs[1];
          if (second.blockNumber < vr.blockNumber) {
            overrides.set(step.index, {
              status: 'failed',
              step_index: step.index,
              reason: 'order_violation',
              expected: 'second ValidatorClaimed after ValidatorRotated',
              observed: { second_vc_block: second.blockNumber, vr_block: vr.blockNumber },
            });
          }
        }
        break;
      }
      case 'same-worker-resubmission': {
        const subs = decodedEvents.filter(e => e.name === 'WorkSubmitted');
        const distinctWorkers = new Set(subs.map(s => (s.actor || '').toLowerCase()).filter(Boolean));
        if (distinctWorkers.size > 1) {
          overrides.set(step.index, {
            status: 'failed',
            step_index: step.index,
            reason: 'workers_not_same',
            expected: 'all WorkSubmitted from same worker',
            observed: { distinct: distinctWorkers.size },
          });
        }
        break;
      }
      default:
        // unrecognized — no override
        break;
    }
  }
  return overrides;
}

// ─────────────────────────────────────────────────────────────────
// Top-level verify entrypoint.
// ─────────────────────────────────────────────────────────────────
export function verifyJob({ jobId, jobView, submissions, rawLogs, txAttempts, intent, personaMap = {} }) {
  // Decode logs once.
  const decoded = (rawLogs || []).map(decodeLog).filter(Boolean);
  decoded.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  // Group decoded events by name (for predicate evaluation).
  const eventsByName = {};
  for (const e of decoded) {
    if (!eventsByName[e.name]) eventsByName[e.name] = [];
    eventsByName[e.name].push(e);
  }

  // Compute observed config (from on-chain state + title fallback)
  const observedConfig = jobStateToConfigKey(jobView) || (intent?.intended_config || 'soft-open-single-open-open');
  const configParams = parseConfigKey(observedConfig);

  // Determine terminal-ness
  const isTerminal = jobView.status === 2 || jobView.status === 3;

  // Compute counts (used by classifier predicates)
  const counts = computeCounts(submissions || []);
  const distinctValidators = new Set((eventsByName.ValidatorClaimed || [])
    .map(e => (e.actor || '').toLowerCase()).filter(Boolean));
  counts.distinctValidators = distinctValidators.size;

  // Build the classification context
  const txAttemptSummaries = (txAttempts || []).map(t => ({
    intended_action: t.intended_action,
    actor: t.actor,
    outcome: t.outcome,
    revert_reason: t.revert_reason,
  }));
  const ctx = { job: jobView, submissions: submissions || [], events: eventsByName,
                counts, configParams, txAttempts: txAttemptSummaries };

  // Determine OBSERVED scenario
  let observedScenario = 's00-in-flight';
  let disjointnessViolation = null;
  if (isTerminal) {
    const matches = classifyAllMatches(ctx);
    if (matches.length === 0) {
      observedScenario = 'unclassified';
    } else if (matches.length > 1) {
      // Disjointness violation — pick the FIRST priority match but flag.
      observedScenario = matches[0];
      disjointnessViolation = matches;
    } else {
      observedScenario = matches[0];
    }
  }

  // Verify cell config validation (on-chain config matches what the cell expects).
  // For Phase B, "config_validated" = the on-chain config we derived equals
  // a valid config_key (i.e., the contract accepted createJob with parameters
  // matching one of the 84 known shapes). Always true unless jobStateToConfigKey
  // returned null (which would be a contract-state bug per V15 C4).
  const configValidated = observedConfig != null;

  // Generate the cell's expected lifecycle for OBSERVED (config, scenario)
  let cellLifecycle;
  try {
    cellLifecycle = generateLifecycle(observedScenario, observedConfig);
  } catch (e) {
    cellLifecycle = { config_key: observedConfig, scenario_id: observedScenario, applicable: false, steps: [],
                      notes: `lifecycle generation failed: ${e.message}` };
  }

  // Verify each step.
  const stepVerdicts = [];
  for (const step of cellLifecycle.steps) {
    if (step.kind === 'revert') {
      stepVerdicts.push(verifyRevertStep(step, txAttemptSummaries));
    } else {
      stepVerdicts.push(verifyEventStep(step, decoded, jobView, personaMap));
    }
  }
  // Apply order predicates (overrides any step that violated ordering).
  const orderOverrides = applyOrderPredicates(cellLifecycle.steps, decoded);
  for (let i = 0; i < stepVerdicts.length; i++) {
    const idx = stepVerdicts[i].step_index;
    if (orderOverrides.has(idx) && stepVerdicts[i].status === 'passed') {
      stepVerdicts[i] = orderOverrides.get(idx);
    }
  }

  // Fold stepVerdicts into a row-level status.
  const allStepsPass = stepVerdicts.length > 0 && stepVerdicts.every(v => v.status === 'passed');
  const expectedReviews = configParams.validationMode === 0 ? 2 : 5;
  const observedReviews = (eventsByName.ReviewSubmitted || []).length;

  let rowStatus;
  if (!isTerminal) {
    rowStatus = 'running';
  } else if (!configValidated) {
    rowStatus = 'config_mismatch';
  } else if (jobView.status === 3 && !cellTerminatesOnCancel(observedScenario)) {
    rowStatus = 'failed';
  } else if (cellLifecycle.applicable && allStepsPass) {
    rowStatus = 'passed';
  } else if (cellLifecycle.applicable) {
    rowStatus = 'partial';
  } else {
    // Terminal but cell isn't applicable for the observed (config, scenario) tuple.
    // This is a true bug in classification or lifecycle generation — flag as partial.
    rowStatus = 'partial';
  }

  const verificationFailures = stepVerdicts
    .filter(v => v.status !== 'passed')
    .map(v => ({
      step: v.step_index,
      reason: v.reason || 'unknown',
      expected: v.expected ?? null,
      observed: v.observed ?? null,
    }));

  if (disjointnessViolation) {
    verificationFailures.push({
      step: 0,
      reason: 'predicate_set_not_disjoint',
      expected: 'exactly one scenario matches',
      observed: { matches: disjointnessViolation },
    });
  }

  const intentMatched = isTerminal && intent
    ? (observedScenario === intent.intended_scenario && observedConfig === intent.intended_config)
    : null;

  return {
    onchain_job_id: jobId,
    config_key: observedConfig,
    scenario_key: observedScenario,
    status: rowStatus,
    steps: stepVerdicts,
    intent_matched: intentMatched,
    config_validated: configValidated,
    intended_config: intent?.intended_config || null,
    intended_scenario: intent?.intended_scenario || null,
    verification_failures: verificationFailures,
    expected_reviews: expectedReviews,
    observed_reviews: observedReviews,
    is_terminal: isTerminal,
    observed_scenario_key: observedScenario,
    observed_config_key: observedConfig,
    distinct_validators: distinctValidators.size,
    decoded_event_count: decoded.length,
  };
}

// ─────────────────────────────────────────────────────────────────
// Cancellation is part of the expected lifecycle for these scenarios.
// status==3 (Cancelled) is "passed" if the scenario is one of:
// ─────────────────────────────────────────────────────────────────
function cellTerminatesOnCancel(scenarioId) {
  return ['s08-worker-no-show', 's09-validator-no-show', 's10-reject-all-cancel', 's11-deadline-expiry']
    .includes(scenarioId);
}
