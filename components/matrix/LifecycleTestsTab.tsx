'use client';

import { useEffect, useMemo, useState } from 'react';
import { AWP_JOBNFT } from '@/lib/awp-contracts';

// Audit-related interfaces
interface StepAudit {
  step_number: number;
  auditor_model: string;
  audited_at: string;
  chain_verified: boolean;
  chain_state: Record<string, unknown>;
  expected_outcome: string;
  actual_outcome: string;
  match: boolean;
  verdict: 'confirmed' | 'mismatch' | 'inconclusive';
  notes: string;
}

interface CellAudit {
  total_steps: number;
  audited_steps: number;
  confirmed_steps: number;
  mismatch_steps: number;
  inconclusive_steps: number;
  last_audited_at: string;
  auditor_model: string;
  overall_verdict: 'fully_confirmed' | 'has_mismatches' | 'partial' | 'unaudited';
}

interface LifecycleResult {
  id: string;
  run_id: string;
  config_key: string;
  scenario_key: string;
  status: 'running' | 'passed' | 'failed' | 'error' | 'na';
  steps: Array<{
    step: number;
    name: string;
    status: string;
    duration_ms: number;
    details: Record<string, unknown>;
    assertions: Array<{ check: string; passed: boolean }>;
    error?: { message: string; context: string };
  }>;
  wallets: {
    employer: { address: string; name: string };
    workers: Array<{ address: string; name: string }>;
    validators: Array<{ address: string; name: string }>;
    actor_map?: Record<string, unknown>;
  };
  // Scanner writes agent_wallets in flat format: { poster, worker, validator }
  agent_wallets?: {
    poster?: string;
    worker?: string;
    validator?: string;
    actor_map?: Record<string, unknown>;
  };
  job_id?: string;
  onchain_job_id?: number;
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  error_message?: string;
  current_step?: number;
  step_audits?: StepAudit[];
  cell_audit?: CellAudit;
}

interface Config {
  key: string;
  label: string;
  validationMode: number;
  deadline: string;
  submissionMode: number;
  workerAccess: string;
  validatorAccess: string;
  jobParams: Record<string, unknown>;
}

interface Scenario {
  key: string;
  name: string;
  description: string;
  requiredWallets: { employers: number; workers: number; validators: number };
  applicableValidationModes: number[] | string;
  requiresRatingGate: boolean;
  requiresValidators: boolean;
  steps: Array<{
    step: number;
    name: string;
    actor: string;
    action: string;
    expect: string;
    params?: Record<string, unknown>;
    expected_reviews?: unknown[];
  }>;
}

interface NaRule {
  scenario: string;
  condition: string;
  reason: string;
}

interface ConfigData {
  configs: Config[];
  scenarios: Scenario[];
  naRules: NaRule[];
  meta: {
    totalConfigs: number;
    totalScenarios: number;
    totalCells: number;
    naCellCount: number;
  };
}

const STATUS_ICONS: Record<string, string> = {
  untested: '⬜',
  scripted: '📝',
  running: '🔄',
  passed: '✅',
  failed: '❌',
  error: '⚠️',
  na: '🚫',
};

const STATUS_COLORS: Record<string, string> = {
  untested: 'bg-zinc-800 border-zinc-700',
  scripted: 'bg-blue-900/30 border-blue-700',
  running: 'bg-yellow-900/30 border-yellow-600',
  passed: 'bg-emerald-900/30 border-emerald-600',
  failed: 'bg-red-900/30 border-red-600',
  error: 'bg-orange-900/30 border-orange-600',
  na: 'bg-zinc-900/50 border-zinc-800 opacity-30',
};

const STATUS_TEXT: Record<string, string> = {
  untested: 'text-zinc-500',
  scripted: 'text-blue-400',
  running: 'text-yellow-400',
  passed: 'text-emerald-400',
  failed: 'text-red-400',
  error: 'text-orange-400',
  na: 'text-zinc-600',
};

function isCellNA(config: Config, scenario: Scenario, naRules: NaRule[]): boolean {
  for (const rule of naRules) {
    if (rule.scenario === scenario.key) {
      // Evaluate condition
      let condition = rule.condition
        .replace('validationMode === 0', String(config.validationMode === 0))
        .replace('validationMode !== 0', String(config.validationMode !== 0))
        .replace('validationMode !== 2', String(config.validationMode !== 2))
        .replace('workerAccess !== "rating"', String(config.workerAccess !== 'rating'))
        .replace('validatorAccess !== "rating"', String(config.validatorAccess !== 'rating'));
      
      // Check if condition evaluates to true
      if (condition.includes('true') && !condition.includes('false')) {
        return true;
      }
    }
  }
  
  // Check scenario applicability
  if (scenario.applicableValidationModes !== '*') {
    if (Array.isArray(scenario.applicableValidationModes) && 
        !scenario.applicableValidationModes.includes(config.validationMode)) {
      return true;
    }
  }
  
  return false;
}

function formatDuration(ms?: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// Extract full wallet address from wallet assignments map using shortened address
function findFullWalletAddress(shortAddr: string, assignments: Map<string, string>): string | null {
  // shortAddr format: "0xe906...1e3D"
  const match = shortAddr.match(/^(0x[a-fA-F0-9]{4})\.{3}([a-fA-F0-9]{4})$/);
  if (!match) return null;
  const [, prefix, suffix] = match;
  for (const [, wallet] of assignments) {
    if (wallet.toLowerCase().startsWith(prefix.toLowerCase()) && wallet.toLowerCase().endsWith(suffix.toLowerCase())) {
      return wallet;
    }
  }
  return null;
}

// Get wallet assignments from completed steps + top-level wallets fallback
function getWalletAssignments(
  resultSteps: LifecycleResult['steps'] | undefined,
  wallets?: LifecycleResult['wallets'],
  agentWallets?: LifecycleResult['agent_wallets']
): Map<string, string> {
  const assignments = new Map<string, string>();

  // 1. Populate from structured wallets object (test-runner format)
  if (wallets) {
    if (wallets.employer?.address) assignments.set('employer', wallets.employer.address);
    if (wallets.workers?.length) {
      for (const w of wallets.workers) {
        if (w.address && !assignments.has('worker')) assignments.set('worker', w.address);
      }
    }
    if (wallets.validators?.length) {
      for (const v of wallets.validators) {
        if (v.address && !assignments.has('validator')) assignments.set('validator', v.address);
      }
    }
    // Named actor map for multi-worker scenarios (worker1, worker2, etc.)
    if (wallets.actor_map && typeof wallets.actor_map === 'object') {
      for (const [actor, wallet] of Object.entries(wallets.actor_map)) {
        if (typeof wallet === 'string' && !assignments.has(actor)) {
          assignments.set(actor, wallet);
        }
      }
    }
  }

  // 2. Populate from flat agent_wallets (scanner format: { poster, worker, validator, actor_map })
  if (agentWallets) {
    if (agentWallets.poster && !assignments.has('employer')) assignments.set('employer', agentWallets.poster);
    if (agentWallets.worker && !assignments.has('worker')) assignments.set('worker', agentWallets.worker);
    if (agentWallets.validator && !assignments.has('validator')) assignments.set('validator', agentWallets.validator);
    // Named actor map for multi-worker scenarios (worker1, worker2, etc.)
    if (agentWallets.actor_map && typeof agentWallets.actor_map === 'object') {
      for (const [actor, wallet] of Object.entries(agentWallets.actor_map)) {
        if (typeof wallet === 'string' && !assignments.has(actor)) {
          assignments.set(actor, wallet);
        }
      }
    }
  }

  // 3. Extract from step details (most reliable — comes from on-chain events)
  for (const step of resultSteps || []) {
    const details = step.details || {};
    // JobCreated → poster is the employer
    if (step.name === 'JobCreated' && details.poster && typeof details.poster === 'string') {
      assignments.set('employer', details.poster);
    }
    // WorkSubmitted → workers array OR single worker string
    if (step.name === 'WorkSubmitted') {
      if (Array.isArray(details.workers)) {
        for (const w of details.workers) {
          if (typeof w === 'string' && !assignments.has('worker')) assignments.set('worker', w);
        }
      } else if (typeof details.worker === 'string' && !assignments.has('worker')) {
        assignments.set('worker', details.worker);
      }
    }
    // ValidatorClaimed → validator
    if (step.name === 'ValidatorClaimed' && details.validator && typeof details.validator === 'string') {
      assignments.set('validator', details.validator);
    }
    // Generic actor/wallet from step details
    const actor = details.actor as string | undefined;
    const wallet = (details.wallet as { address?: string } | undefined)?.address;
    if (actor && wallet && actor !== 'system' && actor !== 'all') {
      assignments.set(actor, wallet);
    }
  }

  return assignments;
}

// Map scenario action names to on-chain event names written by the audit
// Map scenario action names to on-chain event names.
// Actions with empty arrays are explicitly OFF-CHAIN (no DB event expected).
const ACTION_TO_EVENT: Record<string, string[]> = {
  'create-job': ['CreateJob', 'JobCreated'],
  'submit-work': ['SubmitWork', 'WorkSubmitted'],
  'claim-validator': ['ClaimValidator', 'ValidatorClaimed'],
  'reject-submission': ['RejectSubmission', 'SubmissionRejected', 'AllRejected', 'AllSubmissionsRejected'],
  'script-validation': ['ScriptResultRecorded'],
  'approve-submission': ['ApproveSubmission', 'SubmissionApproved'],
  // check-job-status is a read-only state assertion (e.g. s05 expects job OPEN).
  // It doesn't correspond to an on-chain event — leave empty so the UI treats it as off-chain.
  'check-job-status': [],
  'submit-reviews': ['ReviewSubmitted', 'NewFeedback'],
  'release-key': ['DecryptionKeyReleased'],
  'reward-validator': ['ValidatorRewarded'],
  // Off-chain actions — no corresponding on-chain event
  'get-jobs': [],
  // 'discover-job' removed — step eliminated from config.json
  'check-status': [],
  'wait': [],
  'cancel-job': ['JobCancelled'],
};

// Build ordered mapping from scenario steps to DB result steps.
// Handles duplicate actions (e.g., two SubmitWork events in a rejection loop)
// by consuming DB events in order — first match goes to first scenario step, second to second, etc.
function mapScenarioToResults(
  scenarioSteps: Array<{ step: number; name: string; action: string }>,
  resultSteps: LifecycleResult['steps'] | undefined
): Map<number, LifecycleResult['steps'][0]> {
  const mapping = new Map<number, LifecycleResult['steps'][0]>();
  if (!resultSteps || resultSteps.length === 0) return mapping;

  // Track which DB steps have been claimed
  const claimed = new Set<number>();

  for (const scenarioStep of scenarioSteps) {
    const knownAction = scenarioStep.action in ACTION_TO_EVENT;
    const eventNames = ACTION_TO_EVENT[scenarioStep.action] || [];

    // 1. Try action-to-event mapping FIRST (most reliable — matches by semantic meaning)
    if (eventNames.length > 0) {
      const byAction = resultSteps.find((s, i) => !claimed.has(i) && eventNames.includes(s.name));
      if (byAction) {
        const idx = resultSteps.indexOf(byAction);
        mapping.set(scenarioStep.step, byAction);
        claimed.add(idx);
        continue;
      }
    }

    // If this action is known in ACTION_TO_EVENT (even with empty array = off-chain),
    // do NOT fall through to step-number or fuzzy matching — it would steal wrong events.
    if (knownAction) continue;

    // 2. Fallback for UNKNOWN actions only: exact step number match
    const byNumber = resultSteps.find(s => s.step === scenarioStep.step && !claimed.has(resultSteps.indexOf(s)));
    if (byNumber) {
      const idx = resultSteps.indexOf(byNumber);
      mapping.set(scenarioStep.step, byNumber);
      claimed.add(idx);
      continue;
    }

    // 3. Last resort for unknown actions: fuzzy name match (first unclaimed)
    const normalized = scenarioStep.name.toLowerCase().replace(/[\s\-_]+/g, '');
    const byName = resultSteps.find((s, i) => !claimed.has(i) && s.name.toLowerCase().replace(/[\s\-_]+/g, '') === normalized);
    if (byName) {
      const idx = resultSteps.indexOf(byName);
      mapping.set(scenarioStep.step, byName);
      claimed.add(idx);
    }
  }

  return mapping;
}

// Get step status for display using pre-computed mapping
type StepDisplayStatus = 'passed' | 'failed' | 'running' | 'pending';

// Actions that are off-chain (no on-chain event expected)
const OFF_CHAIN_ACTIONS = new Set(['get-jobs', 'check-status', 'check-job-status', 'wait', 'discover-job']);

function getStepDisplayStatus(
  stepNumber: number,
  resultSteps: LifecycleResult['steps'] | undefined,
  currentStep?: number,
  scenarioStepName?: string,
  overallStatus?: string,
  stepMapping?: Map<number, LifecycleResult['steps'][0]>,
  action?: string
): { status: StepDisplayStatus; resultStep?: LifecycleResult['steps'][0]; unverifiedOnChain?: boolean } {
  // When stepMapping is provided, use it exclusively — no fallback.
  // Off-chain steps will correctly have no resultStep (undefined).
  const resultStep = stepMapping
    ? stepMapping.get(stepNumber)
    : resultSteps?.find(s => s.step === stepNumber);

  const isOffChain = action ? OFF_CHAIN_ACTIONS.has(action) : false;

  if (resultStep) {
    // On-chain steps MUST have a txHash to be considered passed — no free passes
    if (resultStep.status === 'passed') {
      const hasTxHash = typeof resultStep.details?.txHash === 'string' && resultStep.details.txHash.length > 0;
      if (!isOffChain && !hasTxHash) {
        // On-chain step claims passed but has no TX proof — mark as unverified
        return { status: 'passed', resultStep, unverifiedOnChain: true };
      }
      return { status: 'passed', resultStep };
    }
    if (resultStep.status === 'failed') return { status: 'failed', resultStep };
    if (resultStep.status === 'running') return { status: 'running', resultStep };
  }

  // Off-chain steps can inherit "passed" from overall status (they have no TX to prove)
  if (isOffChain && overallStatus === 'passed') {
    return { status: 'passed', resultStep };
  }

  // On-chain steps WITHOUT a matching result step stay pending — even if overall is "passed".
  // A passed job with missing on-chain evidence means the scanner didn't capture the event.
  if (!resultStep && overallStatus === 'passed' && !isOffChain) {
    return { status: 'pending', resultStep, unverifiedOnChain: true };
  }

  if (currentStep === stepNumber) {
    return { status: 'running', resultStep };
  }

  return { status: 'pending', resultStep };
}

// Calculate progress stats
function calculateProgress(
  scenarioSteps: Scenario['steps'],
  resultSteps: LifecycleResult['steps'] | undefined,
  currentStep?: number,
  overallStatus?: string
): {
  completed: number;
  failed: number;
  total: number;
  percentComplete: number;
  estimatedRemainingMs: number;
} {
  const total = scenarioSteps.length;

  // NOTE: Do NOT auto-return 100% for "passed" status.
  // Let actual step matching determine progress so the UI
  // accurately reflects which steps have on-chain evidence.

  let completed = 0;
  let failed = 0;
  let totalDuration = 0;
  let durationCount = 0;

  for (const step of resultSteps || []) {
    if (step.status === 'passed') {
      completed++;
      if (step.duration_ms > 0) {
        totalDuration += step.duration_ms;
        durationCount++;
      }
    } else if (step.status === 'failed') {
      failed++;
      if (step.duration_ms > 0) {
        totalDuration += step.duration_ms;
        durationCount++;
      }
    }
  }

  const avgDuration = durationCount > 0 ? totalDuration / durationCount : 5000;
  const remainingSteps = total - completed - failed - (currentStep ? 1 : 0);
  const estimatedRemainingMs = Math.max(0, remainingSteps * avgDuration);
  const percentComplete = total > 0 ? ((completed + failed) / total) * 100 : 0;

  return { completed, failed, total, percentComplete, estimatedRemainingMs };
}

// Get ALL results for a given config×scenario cell, sorted: passed first, then by job ID desc
function getCellResults(
  results: LifecycleResult[],
  configKey: string,
  scenarioKey: string
): LifecycleResult[] {
  return results
    .filter(r => r.config_key === configKey && r.scenario_key === scenarioKey)
    .sort((a, b) => {
      // Passed jobs first
      if (a.status === 'passed' && b.status !== 'passed') return -1;
      if (b.status === 'passed' && a.status !== 'passed') return 1;
      // Then by onchain_job_id descending (newest first)
      return (b.onchain_job_id || 0) - (a.onchain_job_id || 0);
    });
}

// Validate a single result — does it have real on-chain evidence for its scenario?
function validateResult(
  result: LifecycleResult,
  scenario: Scenario
): boolean {
  const steps = result.steps || [];
  const onChainEvents = ['JobCreated','WorkSubmitted','ValidatorClaimed','SubmissionRejected','SubmissionApproved','ValidatorRewarded','DecryptionKeyReleased','ReviewSubmitted','NewFeedback','ScriptResultRecorded'];
  const hasOnChainEvidence = steps.some(s => onChainEvents.includes(s.name) || s.details?.txHash);

  if (!hasOnChainEvidence && steps.length === 0) return false;

  // Require reviews for completed scenarios
  if (hasOnChainEvidence) {
    const reviewStep = scenario.steps?.find((st: { action: string }) => st.action === 'submit-reviews');
    if (reviewStep?.params?.reviews) {
      const expectedReviewCount = (reviewStep.params.reviews as Array<unknown>).length;
      const actualReviewCount = steps.filter(
        (s: { name: string }) => s.name === 'ReviewSubmitted' || s.name === 'NewFeedback'
      ).length;
      if (actualReviewCount < expectedReviewCount) return false;
    }
  }

  return true;
}

export default function LifecycleTestsTab() {
  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [results, setResults] = useState<LifecycleResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ config: Config; scenario: Scenario; results: LifecycleResult[]; currentIndex: number } | null>(null);
  const [selectedConfig, setSelectedConfig] = useState<Config | null>(null);
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [validationFilter, setValidationFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [displayNameMap, setDisplayNameMap] = useState<Map<string, string>>(new Map());

  // R1: Config Row IDs - Map config.key -> C01, C02, etc.
  const configIdMap = useMemo(() => {
    if (!configData) return new Map<string, string>();
    const map = new Map<string, string>();
    // Order: HARD_ONLY (0), SOFT_ONLY (1), HARD_THEN_SOFT (2)
    const orderedConfigs = [
      ...configData.configs.filter(c => c.validationMode === 0),
      ...configData.configs.filter(c => c.validationMode === 1),
      ...configData.configs.filter(c => c.validationMode === 2),
    ];
    orderedConfigs.forEach((config, index) => {
      map.set(config.key, `C${String(index + 1).padStart(2, '0')}`);
    });
    return map;
  }, [configData]);

  // R2: Scenario Column IDs - Map scenario.key -> S01, S02, etc.
  const scenarioIdMap = useMemo(() => {
    if (!configData) return new Map<string, string>();
    const map = new Map<string, string>();
    configData.scenarios.forEach((scenario, index) => {
      map.set(scenario.key, `S${String(index + 1).padStart(2, '0')}`);
    });
    return map;
  }, [configData]);

  useEffect(() => {
    async function loadData() {
      try {
        // Load config
        const configRes = await fetch('/tests/lifecycle/config.json');
        if (!configRes.ok) throw new Error('Failed to load config');
        const configJson: ConfigData = await configRes.json();
        setConfigData(configJson);

        // Load results
        const resultsRes = await fetch('/api/test-results/lifecycle?limit=10000');
        if (!resultsRes.ok) throw new Error('Failed to load results');
        const resultsJson = await resultsRes.json();
        setResults(resultsJson.results || []);

        // Display-name resolution (/api/users) lives on the AWP frontend only.
        // Keep the map empty here — the UI falls back to short wallet addresses.
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);

  const getCellStatus = (config: Config, scenario: Scenario): string => {
    if (isCellNA(config, scenario, configData?.naRules || [])) {
      return 'na';
    }
    const cellResults = getCellResults(results, config.key, scenario.key);
    if (cellResults.length === 0) return 'untested';
    // passed if ANY job NFT passed with full validation
    if (cellResults.some(r => r.status === 'passed' && validateResult(r, scenario))) return 'passed';
    // running if any job is still going
    if (cellResults.some(r => r.status === 'running')) return 'running';
    if (cellResults.some(r => r.status === 'failed')) return 'failed';
    if (cellResults.some(r => r.status === 'error')) return 'error';
    return 'running';
  };

  const stats = useMemo(() => {
    if (!configData) return null;

    const total = configData.configs.length * configData.scenarios.length;

    // Count N/A cells and compute validated statuses using getCellStatus logic
    let naCount = 0;
    let passedCount = 0;
    let failedCount = 0;
    let runningCount = 0;
    let errorCount = 0;

    for (const config of configData.configs) {
      for (const scenario of configData.scenarios) {
        if (isCellNA(config, scenario, configData.naRules)) {
          naCount++;
          continue;
        }
        const status = getCellStatus(config, scenario);
        if (status === 'passed') passedCount++;
        else if (status === 'failed') failedCount++;
        else if (status === 'running') runningCount++;
        else if (status === 'error') errorCount++;
      }
    }

    const testable = total - naCount;

    return {
      total,
      passed: passedCount,
      failed: failedCount,
      running: runningCount,
      error: errorCount,
      untested: testable - (passedCount + failedCount + runningCount + errorCount),
      na: naCount,
      coverage: testable > 0 ? ((passedCount / testable) * 100).toFixed(1) : '0',
    };
  }, [configData, results]);

  const groupedConfigs = useMemo(() => {
    if (!configData) return {};

    const groups: Record<string, Config[]> = {
      'HARD_ONLY (0)': [],
      'SOFT_ONLY (1)': [],
      'HARD_THEN_SOFT (2)': [],
    };

    for (const cfg of configData.configs) {
      if (cfg.validationMode === 0) groups['HARD_ONLY (0)'].push(cfg);
      else if (cfg.validationMode === 1) groups['SOFT_ONLY (1)'].push(cfg);
      else if (cfg.validationMode === 2) groups['HARD_THEN_SOFT (2)'].push(cfg);
    }

    // Apply validation filter
    if (validationFilter !== 'all') {
      const filtered: Record<string, Config[]> = {};
      for (const [key, configs] of Object.entries(groups)) {
        if (key.toLowerCase().includes(validationFilter.toLowerCase())) {
          filtered[key] = configs;
        }
      }
      return filtered;
    }

    return groups;
  }, [configData, validationFilter]);

  const handleCellClick = (config: Config, scenario: Scenario) => {
    const status = getCellStatus(config, scenario);
    if (status === 'na') return;

    const cellResults = getCellResults(results, config.key, scenario.key);
    setSelectedCell({ config, scenario, results: cellResults, currentIndex: 0 });
    setSelectedConfig(null);
    setSelectedScenario(null);
  };

  const handleConfigClick = (config: Config) => {
    setSelectedConfig(config);
    setSelectedCell(null);
    setSelectedScenario(null);
  };

  const handleScenarioClick = (scenario: Scenario) => {
    setSelectedScenario(scenario);
    setSelectedCell(null);
    setSelectedConfig(null);
  };

  const closeAllModals = () => {
    setSelectedCell(null);
    setSelectedConfig(null);
    setSelectedScenario(null);
  };

  const getValidationModeName = (mode: number): string => {
    if (mode === 0) return 'HARD_ONLY';
    if (mode === 1) return 'SOFT_ONLY';
    if (mode === 2) return 'HARD_THEN_SOFT';
    return String(mode);
  };

  const getConfigCellSummary = (config: Config) => {
    if (!configData) return { passed: 0, failed: 0, untested: 0, na: 0 };
    
    let passed = 0, failed = 0, untested = 0, na = 0;
    for (const scenario of configData.scenarios) {
      const status = getCellStatus(config, scenario);
      if (status === 'passed') passed++;
      else if (status === 'failed') failed++;
      else if (status === 'na') na++;
      else untested++;
    }
    return { passed, failed, untested, na };
  };

  const getScenarioCellSummary = (scenario: Scenario) => {
    if (!configData) return { passed: 0, failed: 0, untested: 0, na: 0 };
    
    let passed = 0, failed = 0, untested = 0, na = 0;
    for (const config of configData.configs) {
      const status = getCellStatus(config, scenario);
      if (status === 'passed') passed++;
      else if (status === 'failed') failed++;
      else if (status === 'na') na++;
      else untested++;
    }
    return { passed, failed, untested, na };
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-zinc-500">Loading lifecycle tests...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-red-400">Error: {error}</div>
      </div>
    );
  }

  if (!configData || !stats) return null;

  return (
    <div className="space-y-6">
      {/* Summary Bar */}
      <div className="grid grid-cols-7 gap-4">
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Total Cells</div>
          <div className="text-2xl font-bold text-zinc-200">{stats.total}</div>
        </div>
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Passed</div>
          <div className="text-2xl font-bold text-emerald-400">{stats.passed}</div>
        </div>
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Failed</div>
          <div className="text-2xl font-bold text-red-400">{stats.failed}</div>
        </div>
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Running</div>
          <div className="text-2xl font-bold text-yellow-400">{stats.running}</div>
        </div>
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Untested</div>
          <div className="text-2xl font-bold text-zinc-400">{stats.untested}</div>
        </div>
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">N/A</div>
          <div className="text-2xl font-bold text-zinc-600">{stats.na}</div>
        </div>
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-zinc-500 mb-1">Coverage</div>
          <div className="text-2xl font-bold text-blue-400">{stats.coverage}%</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <select
          value={validationFilter}
          onChange={(e) => setValidationFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200"
        >
          <option value="all">All Validation Modes</option>
          <option value="soft">SOFT_ONLY</option>
          <option value="hard">HARD_ONLY</option>
          <option value="hardsift">HARD_THEN_SOFT</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200"
        >
          <option value="all">All Statuses</option>
          <option value="untested">Untested</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
        </select>
      </div>

      {/* Matrix Grid */}
      <div className="space-y-8">
        {Object.entries(groupedConfigs).map(([groupName, configs]) => (
          <div key={groupName} className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
            <div className="px-4 py-3 bg-zinc-800/50 border-b border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-200">{groupName}</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800">
                    <th className="text-left px-3 py-2 font-medium text-zinc-400 sticky left-0 bg-zinc-900 z-10 min-w-[200px]">
                      Config
                    </th>
                    {configData.scenarios.map((scenario) => (
                      <th
                        key={scenario.key}
                        onClick={() => handleScenarioClick(scenario)}
                        className="text-center px-1 py-2 font-medium text-zinc-400 min-w-[40px] cursor-pointer hover:text-zinc-200 hover:bg-zinc-800/50 transition-colors"
                        title={`${scenarioIdMap.get(scenario.key)}: ${scenario.name} — ${scenario.description}`}
                      >
                        {scenarioIdMap.get(scenario.key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {configs.map((config) => (
                    <tr key={config.key}>
                      <td className="px-3 py-2 text-zinc-300 sticky left-0 bg-zinc-900 z-10 border-r border-zinc-800">
                        <button
                          onClick={() => handleConfigClick(config)}
                          className="truncate max-w-[200px] text-left cursor-pointer hover:text-zinc-100 hover:underline transition-colors"
                          title={`${configIdMap.get(config.key)}: ${config.label}`}
                        >
                          <span className="text-zinc-500 mr-2">{configIdMap.get(config.key)}</span>
                          {config.label}
                        </button>
                      </td>
                      {configData.scenarios.map((scenario) => {
                        const status = getCellStatus(config, scenario);
                        const key = `${config.key}:${scenario.key}`;
                        const configId = configIdMap.get(config.key) || 'C??';
                        const scenarioId = scenarioIdMap.get(scenario.key) || 'S??';
                        const cellId = `${configId}-${scenarioId}`;
                        const cellResults = getCellResults(results, config.key, scenario.key);
                        const result = cellResults[0]; // latest/best for tooltip

                        if (statusFilter !== 'all' && status !== statusFilter) {
                          return <td key={key} className="px-1 py-1" />;
                        }

                        // R5: Build tooltip content
                        let tooltip = `${cellId}\nStatus: ${status}`;
                        if (result?.current_step && result?.steps) {
                          tooltip += `\nStep ${result.current_step} of ${result.steps.length}`;
                        }
                        if ((status === 'failed' || status === 'error') && result?.error_message) {
                          tooltip += `\n${result.error_message.slice(0, 100)}${result.error_message.length > 100 ? '...' : ''}`;
                        }

                        return (
                          <td key={key} className="px-1 py-1">
                            <button
                              onClick={() => handleCellClick(config, scenario)}
                              disabled={status === 'na'}
                              className={`
                                w-8 h-8 rounded flex items-center justify-center text-sm relative
                                border ${STATUS_COLORS[status]}
                                ${status !== 'na' ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'}
                                transition-opacity
                              `}
                              title={tooltip}
                            >
                              {STATUS_ICONS[status]}
                              {(() => {
                                const cellResults = getCellResults(results, config.key, scenario.key);
                                if (cellResults.length > 1) {
                                  return (
                                    <span className="absolute -top-1.5 -right-1.5 bg-zinc-600 text-zinc-200 text-[9px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center">
                                      {cellResults.length}
                                    </span>
                                  );
                                }
                                return null;
                              })()}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
        <span className="flex items-center gap-1"><span className="text-lg">⬜</span> Untested</span>
        <span className="flex items-center gap-1"><span className="text-lg">✅</span> Passed</span>
        <span className="flex items-center gap-1"><span className="text-lg">❌</span> Failed</span>
        <span className="flex items-center gap-1"><span className="text-lg">🔄</span> Running</span>
        <span className="flex items-center gap-1"><span className="text-lg">⚠️</span> Error</span>
        <span className="flex items-center gap-1"><span className="text-lg">🚫</span> N/A</span>
      </div>

      {/* Cell Detail Modal */}
      {selectedCell && (() => {
  const currentResult = selectedCell.results[selectedCell.currentIndex];
  const totalJobs = selectedCell.results.length;
  const hasMultipleJobs = totalJobs > 1;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={closeAllModals}>
      <div className="bg-zinc-900 rounded-xl border border-zinc-700 max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-lg font-semibold text-zinc-100">
                {selectedCell.config.label} × {selectedCell.scenario.name}
              </h2>
              <span className="text-sm font-mono text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
                {configIdMap.get(selectedCell.config.key)}-{scenarioIdMap.get(selectedCell.scenario.key)}
              </span>
            </div>
            {/* Job Navigator */}
            {hasMultipleJobs && (
              <div className="flex items-center gap-3 mt-2">
                <button
                  onClick={() => setSelectedCell(prev => prev ? { ...prev, currentIndex: Math.max(0, prev.currentIndex - 1) } : null)}
                  disabled={selectedCell.currentIndex === 0}
                  className="px-2 py-0.5 bg-zinc-800 rounded text-zinc-300 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-default text-sm font-bold transition-colors"
                >
                  ◀
                </button>
                <span className="text-sm text-zinc-400">
                  Job {selectedCell.currentIndex + 1} of {totalJobs}
                </span>
                <button
                  onClick={() => setSelectedCell(prev => prev ? { ...prev, currentIndex: Math.min(prev.results.length - 1, prev.currentIndex + 1) } : null)}
                  disabled={selectedCell.currentIndex === totalJobs - 1}
                  className="px-2 py-0.5 bg-zinc-800 rounded text-zinc-300 hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-default text-sm font-bold transition-colors"
                >
                  ▶
                </button>
              </div>
            )}
            {/* Current job info */}
            {currentResult && (
              <p className="text-sm text-zinc-500 mt-1">
                {currentResult.onchain_job_id && (
                  <>
                    <span className="font-semibold text-zinc-300">Job NFT #{currentResult.onchain_job_id}</span>
                    {' | '}
                  </>
                )}
                <span className={`${STATUS_TEXT[currentResult.status]}`}>
                  {STATUS_ICONS[currentResult.status]} {currentResult.status}
                </span>
                {(currentResult.job_id || currentResult.onchain_job_id) && (
                  <>
                    {' | '}
                    <a
                      href={`https://sepolia.basescan.org/token/${AWP_JOBNFT}?a=${currentResult.onchain_job_id || currentResult.job_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer transition-colors inline-flex items-center gap-1"
                    >
                      View Job ↗
                    </a>
                  </>
                )}
                {currentResult.onchain_job_id && (
                  <>
                    {' | '}
                    <a
                      href={`https://sepolia.basescan.org/address/0x92e6e1a014cf80fc297048286f89d6110ea8777e`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 hover:underline transition-colors inline-flex items-center gap-1"
                    >
                      Contract ↗
                    </a>
                  </>
                )}
                {' | '}
                Started: {new Date(currentResult.started_at).toLocaleString()}
                {' | '}Duration: {formatDuration(currentResult.duration_ms)}
              </p>
            )}
            {!currentResult && (
              <p className="text-sm text-zinc-500 mt-1">No results recorded for this cell</p>
            )}
          </div>
          <button
            onClick={closeAllModals}
            className="text-zinc-400 hover:text-zinc-200 text-xl ml-4"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto">
              {/* R4: Error Banner for failed/error statuses */}
              {currentResult && (currentResult.status === 'failed' || currentResult.status === 'error') && (
                <div className="mb-6 bg-red-900/20 border border-red-700 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{currentResult.status === 'failed' ? '❌' : '⚠️'}</span>
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold text-red-400 mb-1">
                        {currentResult.status === 'failed' ? 'Lifecycle Failed' : 'Lifecycle Error'}
                      </h3>
                      {currentResult.error_message && (
                        <p className="text-sm text-red-300 mb-2">{currentResult.error_message}</p>
                      )}
                      <p className="text-xs text-zinc-500 font-mono">Run ID: {currentResult.run_id}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Audit Summary Banner */}
              {currentResult && (
                (() => {
                  const cellAudit = currentResult.cell_audit;
                  if (!cellAudit) {
                    return (
                      <div className="mb-6 bg-zinc-800/50 border border-zinc-600 rounded-lg p-4">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">⏳</span>
                          <span className="text-sm text-zinc-400">Audit: Unaudited — No sign-off yet</span>
                        </div>
                      </div>
                    );
                  }

                  const formatAuditDate = (dateStr: string) => {
                    const date = new Date(dateStr);
                    return date.toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    });
                  };

                  if (cellAudit.overall_verdict === 'fully_confirmed') {
                    return (
                      <div className="mb-6 bg-emerald-900/20 border border-emerald-700 rounded-lg p-4">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">🔏</span>
                          <span className="text-sm text-emerald-400">
                            Audit: {cellAudit.confirmed_steps}/{cellAudit.total_steps} steps verified
                            {' | '}Last: {formatAuditDate(cellAudit.last_audited_at)}
                            {' | '}✅ Fully Confirmed
                          </span>
                        </div>
                      </div>
                    );
                  }

                  if (cellAudit.overall_verdict === 'has_mismatches') {
                    return (
                      <div className="mb-6 bg-red-900/20 border border-red-700 rounded-lg p-4">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">🚨</span>
                          <span className="text-sm text-red-400">
                            Audit: {cellAudit.audited_steps}/{cellAudit.total_steps} verified
                            {' | '}{cellAudit.mismatch_steps} mismatch{cellAudit.mismatch_steps !== 1 ? 'es' : ''}
                            {' | '}Last: {formatAuditDate(cellAudit.last_audited_at)}
                            {' | '}❌ Has Mismatches
                          </span>
                        </div>
                      </div>
                    );
                  }

                  // partial verdict
                  return (
                    <div className="mb-6 bg-zinc-800/50 border border-zinc-600 rounded-lg p-4">
                      <div className="flex items-center gap-3">
                        <span className="text-xl">🔏</span>
                        <span className="text-sm text-zinc-400">
                          Audit: {cellAudit.audited_steps}/{cellAudit.total_steps} verified
                          {' | '}Last: {formatAuditDate(cellAudit.last_audited_at)}
                          {' | '}⏳ Partial
                        </span>
                      </div>
                    </div>
                  );
                })()
              )}

              {/* Job Configuration */}
              <div className="mb-6">
                <h3 className="text-sm font-medium text-zinc-300 mb-3">Job Configuration</h3>
                <div className="bg-zinc-800 rounded-lg p-3 grid grid-cols-2 gap-2 text-xs">
                  {Object.entries(selectedCell.config.jobParams).map(([key, value]) => {
                    // Display ratings as human-readable (e.g., 400 → "4.0 ★")
                    const isRating = key === 'minWorkerRating' || key === 'minValidatorRating';
                    const displayValue = isRating && typeof value === 'number' && value > 0
                      ? `${(value / 100).toFixed(1)} ★`
                      : JSON.stringify(value);
                    return (
                      <div key={key}>
                        <span className="text-zinc-500">{key}:</span>{' '}
                        <span className="text-zinc-200">{displayValue}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Participants */}
              {selectedCell.scenario?.steps && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-zinc-300 mb-3">Participants</h3>
                  <div className="grid grid-cols-3 gap-4">
                    {(() => {
                      const walletAssignments = getWalletAssignments(currentResult?.steps, currentResult?.wallets, currentResult?.agent_wallets);
                      const uniqueActors = new Map<string, string | null>();

                      // Collect all unique actors from scenario steps
                      for (const step of selectedCell.scenario.steps) {
                        if (step.actor !== 'system' && step.actor !== 'all' && !uniqueActors.has(step.actor)) {
                          const assigned = walletAssignments.get(step.actor);
                          uniqueActors.set(step.actor, assigned || null);
                        }
                      }

                      // Render participant cards
                      const cards: React.ReactNode[] = [];
                      for (const [actor, wallet] of uniqueActors) {
                        const actorEmoji = actor === 'employer' ? 'E' : actor === 'worker' ? 'W' : actor === 'validator' ? 'V' : '?';
                        const actorLabel = actor.charAt(0).toUpperCase() + actor.slice(1);
                        const displayName = wallet ? displayNameMap.get(wallet.toLowerCase()) : null;
                        cards.push(
                          <div key={actor} className="bg-zinc-800 rounded-lg p-3">
                            <div className="text-xs text-zinc-500 mb-1">{actorEmoji} {actorLabel}</div>
                            <div className="text-xs text-zinc-300">
                              {displayName ? (
                                wallet ? (
                                  <a
                                    href={`https://sepolia.basescan.org/address/${wallet}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer transition-colors"
                                  >
                                    {displayName}
                                  </a>
                                ) : (
                                  <span>{displayName}</span>
                                )
                              ) : wallet ? (
                                <span className="flex items-center gap-2">
                                  <a
                                    href={`https://sepolia.basescan.org/address/${wallet}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer transition-colors font-mono"
                                  >
                                    {shortenAddress(wallet)}
                                  </a>
                                  <a
                                    href={`https://sepolia.basescan.org/address/${wallet}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-400 hover:text-blue-300 transition-colors"
                                    title="View on BaseScan"
                                  >
                                    ↗
                                  </a>
                                </span>
                              ) : (
                                <span className="text-zinc-600 italic">Pending</span>
                              )}
                            </div>
                          </div>
                        );
                      }
                      return cards.length > 0 ? cards : <div className="text-zinc-500 text-sm">No wallet assignments</div>;
                    })()}
                  </div>
                </div>
              )}

              {/* Steps Timeline — single source of truth, reviews shown within lifecycle steps */}
              {selectedCell.scenario?.steps && selectedCell.scenario.steps.length > 0 && (() => {
                // Pre-compute step mapping once for the entire modal
                const stepMapping = mapScenarioToResults(
                  selectedCell.scenario.steps,
                  currentResult?.steps
                );
                return (
                <div>
                  <h3 className="text-sm font-medium text-zinc-300 mb-3">Lifecycle Steps</h3>

                  {/* Progress Indicator */}
                  {(() => {
                    const progress = calculateProgress(
                      selectedCell.scenario.steps,
                      currentResult?.steps,
                      currentResult?.current_step,
                      currentResult?.status
                    );
                    return (
                      <div className="mb-4 bg-zinc-800/50 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-zinc-300">
                            Step {Math.min(progress.completed + progress.failed + (currentResult?.current_step ? 1 : 0), progress.total)} of {progress.total}
                          </span>
                          <span className="text-xs text-zinc-500">
                            {progress.estimatedRemainingMs > 0 && `~${formatDuration(progress.estimatedRemainingMs)} remaining`}
                          </span>
                        </div>
                        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden flex">
                          {selectedCell.scenario.steps.map((step) => {
                            const { status, unverifiedOnChain } = getStepDisplayStatus(
                              step.step,
                              currentResult?.steps,
                              currentResult?.current_step,
                              step.name,
                              currentResult?.status,
                              stepMapping,
                              step.action
                            );
                            return (
                              <div
                                key={step.step}
                                className={`flex-1 ${
                                  unverifiedOnChain
                                    ? 'bg-amber-500'
                                    : status === 'passed'
                                    ? 'bg-emerald-500'
                                    : status === 'failed'
                                    ? 'bg-red-500'
                                    : status === 'running'
                                    ? 'bg-blue-500'
                                    : 'bg-zinc-700'
                                } ${step.step > 1 ? 'ml-0.5' : ''}`}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Step List */}
                  {(() => {
                    // Pre-compute: detect duplicate TX hashes across different steps
                    const txHashCounts = new Map<string, number>();
                    for (const step of selectedCell.scenario.steps) {
                      const rs = stepMapping.get(step.step);
                      const tx = rs?.details?.txHash;
                      if (typeof tx === 'string' && tx.length > 0) {
                        txHashCounts.set(tx, (txHashCounts.get(tx) || 0) + 1);
                      }
                    }
                    const duplicateTxHashes = new Set<string>();
                    for (const [tx, count] of txHashCounts) {
                      if (count > 1) duplicateTxHashes.add(tx);
                    }

                    return (<div className="space-y-2">
                    {selectedCell.scenario.steps.map((scenarioStep) => {
                      const { status, resultStep, unverifiedOnChain } = getStepDisplayStatus(
                        scenarioStep.step,
                        currentResult?.steps,
                        currentResult?.current_step,
                        scenarioStep.name,
                        currentResult?.status,
                        stepMapping,
                        scenarioStep.action
                      );

                      const walletAssignments = getWalletAssignments(currentResult?.steps, currentResult?.wallets, currentResult?.agent_wallets);

                      const assignedWallet = scenarioStep.actor !== 'system' && scenarioStep.actor !== 'all'
                        ? walletAssignments.get(scenarioStep.actor)
                        : undefined;

                      const stepWallet = (resultStep?.details?.wallet as { address?: string } | undefined)?.address;
                      const displayWallet = stepWallet || assignedWallet;
                      const displayName = displayWallet ? displayNameMap.get(displayWallet.toLowerCase()) : null;

                      return (
                        <div
                          key={scenarioStep.step}
                          className={`flex items-start gap-3 p-3 rounded-lg border-l-4 ${
                            unverifiedOnChain
                              ? 'bg-amber-900/10 border-amber-500 border-y border-r border-amber-900/30'
                              : status === 'passed'
                              ? 'bg-emerald-900/10 border-emerald-500 border-y border-r border-emerald-900/30'
                              : status === 'failed'
                              ? 'bg-red-900/10 border-red-500 border-y border-r border-red-900/30'
                              : status === 'running'
                              ? 'bg-blue-900/10 border-blue-500 border-y border-r border-blue-900/30 animate-pulse'
                              : 'bg-zinc-800/50 border-zinc-600 border-dashed border-y border-r border-zinc-700'
                          }`}
                        >
                          <div className="mt-0.5 text-lg">
                            {unverifiedOnChain && <span className="w-5 h-5 inline-flex items-center justify-center rounded-full bg-amber-500/20 text-amber-400 font-bold text-sm" title="Missing on-chain TX proof">!</span>}
                            {!unverifiedOnChain && status === 'passed' && <span className="w-5 h-5 inline-flex items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 font-bold text-sm">&#10003;</span>}
                            {!unverifiedOnChain && status === 'failed' && <span className="w-5 h-5 inline-flex items-center justify-center rounded-full bg-red-500/20 text-red-400 font-bold text-sm">&#10007;</span>}
                            {!unverifiedOnChain && status === 'running' && <span className="w-5 h-5 inline-flex items-center justify-center rounded-full bg-blue-500/20 border border-blue-500/50 animate-pulse"><span className="w-2 h-2 rounded-full bg-blue-400" /></span>}
                            {!unverifiedOnChain && status === 'pending' && <span className="w-5 h-5 inline-flex items-center justify-center rounded border border-zinc-700 border-dashed text-zinc-600">&middot;</span>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-zinc-200">
                                {scenarioStep.step}. {scenarioStep.name}
                              </span>
                              {resultStep && (
                                <span className="text-xs text-zinc-500">({formatDuration(resultStep.duration_ms)})</span>
                              )}
                            </div>

                            {/* Actor & Action */}
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              <span className="text-xs px-2 py-0.5 bg-zinc-800 rounded text-zinc-400">
                                {scenarioStep.actor}
                              </span>
                              <span className="text-xs text-zinc-500">→</span>
                              <span className="text-xs text-zinc-400">{scenarioStep.action}</span>
                            </div>

                            {/* Expected Outcome */}
                            <div className="text-xs text-zinc-500 mt-1">
                              Expect: <span className="text-zinc-400">{scenarioStep.expect}</span>
                            </div>

                            {/* Wallet Assignment */}
                            {displayWallet ? (
                              <div className="text-xs text-zinc-300 mt-1">
                                {displayName ? (
                                  <a
                                    href={`https://sepolia.basescan.org/address/${displayWallet}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer transition-colors"
                                  >
                                    {displayName}
                                  </a>
                                ) : (
                                  <a
                                    href={`https://sepolia.basescan.org/address/${displayWallet}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer transition-colors font-mono"
                                  >
                                    {shortenAddress(displayWallet)}
                                  </a>
                                )}
                              </div>
                            ) : status === 'pending' && scenarioStep.actor !== 'system' && scenarioStep.actor !== 'all' ? (
                              <div className="text-xs text-zinc-600 mt-1 italic">
                                Actor: {scenarioStep.actor}
                              </div>
                            ) : null}

                            {/* Warning for unverified on-chain steps */}
                            {unverifiedOnChain && (
                              <div className="text-xs text-amber-400 mt-1 font-medium">
                                ⚠ Missing on-chain TX — scanner did not capture this event
                              </div>
                            )}

                            {/* TX Hash for completed steps */}
                            {resultStep && typeof resultStep.details?.txHash === 'string' && resultStep.details.txHash && (
                              <div className="text-xs text-zinc-500 mt-1 font-mono">
                                TX:{' '}
                                <a
                                  href={`https://sepolia.basescan.org/tx/${resultStep.details.txHash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-400 hover:text-blue-300 hover:underline transition-colors inline-flex items-center gap-1"
                                >
                                  {shortenAddress(resultStep.details.txHash)}
                                  <span>↗</span>
                                </a>
                                {duplicateTxHashes.has(resultStep.details.txHash) && (
                                  <span className="ml-2 text-amber-400 font-sans" title="Same TX hash used by another step — possible event misclassification">⚠ duplicate TX</span>
                                )}
                              </div>
                            )}

                            {/* ERC-8004 Feedback TX (separate from AWP TX) */}
                            {resultStep && typeof resultStep.details?.erc8004TxHash === 'string' && resultStep.details.erc8004TxHash && (
                              <div className="text-xs text-purple-400 mt-1 font-mono">
                                8004:{' '}
                                <a
                                  href={`https://sepolia.basescan.org/tx/${resultStep.details.erc8004TxHash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-purple-400 hover:text-purple-300 hover:underline transition-colors inline-flex items-center gap-1"
                                >
                                  {resultStep.details.erc8004TxHash.slice(0, 6)}...{resultStep.details.erc8004TxHash.slice(-4)}
                                  <span>↗</span>
                                </a>
                                <span className="ml-1 text-zinc-500">(ERC-8004)</span>
                              </div>
                            )}

                            {/* Script Validation Result — shown for ScriptResultRecorded events and WorkSubmitted steps on script-validated jobs */}
                            {resultStep?.name === 'ScriptResultRecorded' && (
                              <div className={`text-xs mt-2 p-2 rounded border ${
                                resultStep.details?.scriptPassed
                                  ? 'bg-emerald-900/20 border-emerald-700/50'
                                  : 'bg-red-900/20 border-red-700/50'
                              }`}>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className={`font-bold ${resultStep.details?.scriptPassed ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {resultStep.details?.scriptPassed ? '✓ Script PASSED' : '✗ Script FAILED'}
                                  </span>
                                  {!!resultStep.details?.scorePct && (
                                    <span className="text-zinc-400">Score: {String(resultStep.details.scorePct)}</span>
                                  )}
                                  {typeof resultStep.details?.submissionIndex === 'number' && (
                                    <span className="text-zinc-500">Submission #{Number(resultStep.details.submissionIndex)}</span>
                                  )}
                                </div>
                                <div className="text-zinc-500">
                                  Validation script executed on-chain by automation service
                                </div>
                              </div>
                            )}

                            {/* Script validation inline for WorkSubmitted steps on hard/hardsift jobs */}
                            {scenarioStep.action === 'submit-work' && (() => {
                              // Find matching ScriptResultRecorded in the result steps
                              const scriptResults = (currentResult?.steps || []).filter(
                                (s: { name: string }) => s.name === 'ScriptResultRecorded'
                              );
                              if (scriptResults.length === 0) return null;
                              // Match by submission index if available, otherwise show all
                              const workerIndex = resultStep?.details?.workerIndex as number | undefined;
                              const matchingScript = scriptResults.find(
                                (sr: { details?: { submissionIndex?: number } }) => sr.details?.submissionIndex === workerIndex
                              ) || (scriptResults.length === 1 ? scriptResults[0] : null);
                              if (!matchingScript) return null;
                              const sr = matchingScript as { details?: { scriptPassed?: boolean; scorePct?: string; txHash?: string } };
                              return (
                                <div className={`text-xs mt-2 p-2 rounded border ${
                                  sr.details?.scriptPassed
                                    ? 'bg-emerald-900/20 border-emerald-700/50'
                                    : 'bg-red-900/20 border-red-700/50'
                                }`}>
                                  <div className="flex items-center gap-2">
                                    <span className={`font-bold ${sr.details?.scriptPassed ? 'text-emerald-400' : 'text-red-400'}`}>
                                      {sr.details?.scriptPassed ? '✓ Script PASSED' : '✗ Script FAILED'}
                                    </span>
                                    {sr.details?.scorePct && (
                                      <span className="text-zinc-400">Score: {String(sr.details.scorePct)}</span>
                                    )}
                                    {sr.details?.txHash && (
                                      <a
                                        href={`https://sepolia.basescan.org/tx/${sr.details.txHash}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-cyan-400 hover:text-cyan-300 hover:underline transition-colors inline-flex items-center gap-1 font-mono"
                                      >
                                        {String(sr.details.txHash).slice(0, 10)}...{String(sr.details.txHash).slice(-4)} ↗
                                      </a>
                                    )}
                                  </div>
                                </div>
                              );
                            })()}

                            {/* For submit-reviews step, show recent review TXs (capped at expected count) */}
                            {scenarioStep.action === 'submit-reviews' && (() => {
                              const allReviewSteps = (currentResult?.steps || []).filter(
                                (s: { name: string }) => s.name === 'ReviewSubmitted' || s.name === 'NewFeedback'
                              );
                              if (allReviewSteps.length <= 1) return null; // Already shown above as single TX
                              // Show only the most recent reviews (last N), matching expected review count from config
                              const expectedCount = scenarioStep.expected_reviews?.length || 5;
                              const recentReviews = allReviewSteps.slice(-expectedCount);
                              const hiddenCount = allReviewSteps.length - recentReviews.length;
                              return (
                                <div className="text-xs text-zinc-500 mt-1 space-y-0.5">
                                  <div className="text-zinc-400 font-medium">
                                    {recentReviews.length} review TXs{hiddenCount > 0 ? ` (latest of ${allReviewSteps.length} total)` : ':'}
                                  </div>
                                  {recentReviews.map((rev: { details?: { txHash?: string; reviewer?: string; reviewee?: string } }, idx: number) => (
                                    rev.details?.txHash && (
                                      <div key={idx} className="font-mono flex items-center gap-1">
                                        <a
                                          href={`https://sepolia.basescan.org/tx/${rev.details.txHash}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-blue-400 hover:text-blue-300 hover:underline transition-colors inline-flex items-center gap-1"
                                        >
                                          {rev.details.txHash.slice(0, 10)}...{rev.details.txHash.slice(-4)} ↗
                                        </a>
                                        {rev.details.reviewer && rev.details.reviewee && (
                                          <span className="text-zinc-600">
                                            ({rev.details.reviewer.slice(0, 6)}→{rev.details.reviewee.slice(0, 6)})
                                          </span>
                                        )}
                                      </div>
                                    )
                                  ))}
                                </div>
                              );
                            })()}

                            {/* R4: Error for failed steps */}
                            {resultStep?.error && (
                              <div className="mt-2 p-2 bg-red-900/20 rounded border border-red-800">
                                <div className="text-xs text-red-400 font-medium">
                                  Error: {String(resultStep.error.message)}
                                </div>
                                {resultStep.error.context && (
                                  <details className="mt-2">
                                    <summary className="text-xs text-red-500 cursor-pointer hover:text-red-400">
                                      Show details
                                    </summary>
                                    <pre className="mt-2 text-xs text-red-300 bg-red-950/50 p-2 rounded overflow-x-auto">
                                      {resultStep.error.context}
                                    </pre>
                                  </details>
                                )}
                              </div>
                            )}

                            {/* Assertions for completed steps */}
                            {resultStep?.assertions && resultStep.assertions.length > 0 && (
                              <div className="mt-2 space-y-1">
                                {resultStep.assertions.map((assertion, i) => (
                                  <div key={i} className="text-xs flex items-center gap-1">
                                    <span className={assertion.passed ? 'text-emerald-400' : 'text-red-400'}>
                                      {assertion.passed ? '✓' : '✗'}
                                    </span>
                                    <span className="text-zinc-400">{assertion.check}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>);
                  })()}
                </div>
                ); })()}

              {/* Actions */}
              <div className="flex gap-3 mt-6 pt-4 border-t border-zinc-800">
                <button
                  onClick={() => { /* TODO: Trigger re-run */ }}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Re-run Test
                </button>
                {currentResult?.job_id && (
                  <a
                    href={`https://sepolia.basescan.org/token/${AWP_JOBNFT}?a=${currentResult.onchain_job_id || currentResult.job_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm font-medium rounded-lg transition-colors"
                  >
                    View Job ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      );
  })()}

      {/* Config Detail Modal */}
      {selectedConfig && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={closeAllModals}>
          <div className="bg-zinc-900 rounded-xl border border-zinc-700 max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">{selectedConfig.label}</h2>
                <p className="text-sm text-zinc-500">{configIdMap.get(selectedConfig.key)} — {selectedConfig.key}</p>
              </div>
              <button
                onClick={closeAllModals}
                className="text-zinc-400 hover:text-zinc-200 text-xl"
              >
                ×
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto space-y-6">
              {/* Job Parameters */}
              <div>
                <h3 className="text-sm font-medium text-zinc-300 mb-3">Job Parameters</h3>
                <div className="bg-zinc-800 rounded-lg p-3 space-y-2 text-sm">
                  {Object.entries(selectedConfig.jobParams).map(([key, value]) => {
                    const isRating = key === 'minWorkerRating' || key === 'minValidatorRating';
                    const displayValue = isRating && typeof value === 'number' && value > 0
                      ? `${(value / 100).toFixed(1)} ★`
                      : typeof value === 'boolean' ? (value ? 'true' : 'false')
                      : typeof value === 'string' ? value
                      : JSON.stringify(value);
                    return (
                      <div key={key} className="flex justify-between">
                        <span className="text-zinc-500">{key}</span>
                        <span className="text-zinc-200">{displayValue}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Config Settings */}
              <div>
                <h3 className="text-sm font-medium text-zinc-300 mb-3">Configuration</h3>
                <div className="bg-zinc-800 rounded-lg p-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Validation Mode</span>
                    <span className="text-zinc-200">{getValidationModeName(selectedConfig.validationMode)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Deadline</span>
                    <span className="text-zinc-200">{selectedConfig.deadline}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Submission Mode</span>
                    <span className="text-zinc-200">{selectedConfig.submissionMode}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Worker Access</span>
                    <span className="text-zinc-200">{selectedConfig.workerAccess}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Validator Access</span>
                    <span className="text-zinc-200">{selectedConfig.validatorAccess}</span>
                  </div>
                </div>
              </div>

              {/* Summary */}
              {(() => {
                const summary = getConfigCellSummary(selectedConfig);
                return (
                  <div>
                    <h3 className="text-sm font-medium text-zinc-300 mb-3">Test Summary (18 scenarios)</h3>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-emerald-900/20 border border-emerald-800 rounded-lg p-2 text-center">
                        <div className="text-lg font-bold text-emerald-400">{summary.passed}</div>
                        <div className="text-xs text-emerald-600">Passed</div>
                      </div>
                      <div className="bg-red-900/20 border border-red-800 rounded-lg p-2 text-center">
                        <div className="text-lg font-bold text-red-400">{summary.failed}</div>
                        <div className="text-xs text-red-600">Failed</div>
                      </div>
                      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-center">
                        <div className="text-lg font-bold text-zinc-400">{summary.untested}</div>
                        <div className="text-xs text-zinc-600">Untested</div>
                      </div>
                      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-2 text-center">
                        <div className="text-lg font-bold text-zinc-600">{summary.na}</div>
                        <div className="text-xs text-zinc-700">N/A</div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Scenario Detail Modal */}
      {selectedScenario && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={closeAllModals}>
          <div className="bg-zinc-900 rounded-xl border border-zinc-700 max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">{selectedScenario.name}</h2>
                <p className="text-sm text-zinc-500">{scenarioIdMap.get(selectedScenario.key)} — {selectedScenario.key}</p>
              </div>
              <button
                onClick={closeAllModals}
                className="text-zinc-400 hover:text-zinc-200 text-xl"
              >
                ×
              </button>
            </div>

            {/* Content */}
            <div className="p-6 overflow-y-auto space-y-6">
              {/* Description */}
              <div>
                <h3 className="text-sm font-medium text-zinc-300 mb-2">Description</h3>
                <p className="text-sm text-zinc-400">{selectedScenario.description}</p>
              </div>

              {/* Required Wallets */}
              <div>
                <h3 className="text-sm font-medium text-zinc-300 mb-3">Required Wallets</h3>
                <div className="bg-zinc-800 rounded-lg p-3 grid grid-cols-3 gap-4 text-sm">
                  <div className="text-center">
                    <div className="text-lg font-bold text-zinc-200">{selectedScenario.requiredWallets.employers}</div>
                    <div className="text-xs text-zinc-500">Employer{selectedScenario.requiredWallets.employers !== 1 ? 's' : ''}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-bold text-zinc-200">{selectedScenario.requiredWallets.workers}</div>
                    <div className="text-xs text-zinc-500">Worker{selectedScenario.requiredWallets.workers !== 1 ? 's' : ''}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-lg font-bold text-zinc-200">{selectedScenario.requiredWallets.validators}</div>
                    <div className="text-xs text-zinc-500">Validator{selectedScenario.requiredWallets.validators !== 1 ? 's' : ''}</div>
                  </div>
                </div>
              </div>

              {/* Applicable Validation Modes */}
              <div>
                <h3 className="text-sm font-medium text-zinc-300 mb-3">Applicable Validation Modes</h3>
                <div className="bg-zinc-800 rounded-lg p-3 text-sm">
                  {selectedScenario.applicableValidationModes === '*' ? (
                    <span className="text-zinc-200">All modes (HARD_ONLY, SOFT_ONLY, HARD_THEN_SOFT)</span>
                  ) : Array.isArray(selectedScenario.applicableValidationModes) ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedScenario.applicableValidationModes.map((mode) => (
                        <span key={mode} className="px-2 py-1 bg-zinc-700 rounded text-zinc-200">
                          {getValidationModeName(mode)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-zinc-200">{String(selectedScenario.applicableValidationModes)}</span>
                  )}
                </div>
              </div>

              {/* Requirements */}
              <div>
                <h3 className="text-sm font-medium text-zinc-300 mb-3">Requirements</h3>
                <div className="bg-zinc-800 rounded-lg p-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Rating Gate Required</span>
                    <span className={selectedScenario.requiresRatingGate ? 'text-yellow-400' : 'text-zinc-400'}>
                      {selectedScenario.requiresRatingGate ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Validators Required</span>
                    <span className={selectedScenario.requiresValidators ? 'text-yellow-400' : 'text-zinc-400'}>
                      {selectedScenario.requiresValidators ? 'Yes' : 'No'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Summary */}
              {(() => {
                const summary = getScenarioCellSummary(selectedScenario);
                return (
                  <div>
                    <h3 className="text-sm font-medium text-zinc-300 mb-3">Test Summary (84 configs)</h3>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="bg-emerald-900/20 border border-emerald-800 rounded-lg p-2 text-center">
                        <div className="text-lg font-bold text-emerald-400">{summary.passed}</div>
                        <div className="text-xs text-emerald-600">Passed</div>
                      </div>
                      <div className="bg-red-900/20 border border-red-800 rounded-lg p-2 text-center">
                        <div className="text-lg font-bold text-red-400">{summary.failed}</div>
                        <div className="text-xs text-red-600">Failed</div>
                      </div>
                      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-2 text-center">
                        <div className="text-lg font-bold text-zinc-400">{summary.untested}</div>
                        <div className="text-xs text-zinc-600">Untested</div>
                      </div>
                      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-2 text-center">
                        <div className="text-lg font-bold text-zinc-600">{summary.na}</div>
                        <div className="text-xs text-zinc-700">N/A</div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
