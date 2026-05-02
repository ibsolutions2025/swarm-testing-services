// lib/awp/index.ts
//
// Barrel re-export for the AWP knowledge module. Consumers import like:
//
//   import { ALL_CONFIGS, classify, EVENT_SIGS } from "@/lib/awp";
//
// Or namespaced:
//
//   import * as awp from "@/lib/awp";
//   awp.matrix.ALL_CONFIGS
//
// Both forms work because we re-export each module's exports flat AND under
// a namespace. Phase B's Onboarding Engine output mirrors this shape — see
// SWARM-V2-DESIGN.md section 3.3.

export * as contracts from "./contracts.js";
export * as rules from "./rules.js";
export * as matrix from "./matrix.js";
export * as scenarios from "./scenarios.js";
export * as events from "./events.js";
export * as cellDefs from "./cell-defs.js";
export * as stateMachine from "./state-machine.js";
export * as lifecycleGen from "./generate-lifecycle.js";

// Flat re-exports — the most commonly used identifiers.
// Avoid name collisions by being explicit about what's re-exported.
export {
  CONTRACT_ADDRESSES,
  JOB_NFT_ABI,
  REVIEW_GATE_ABI,
  MOCK_USDC_ABI,
  RECEIPT_NFT_ABI,
  AWP_TOKEN_ABI,
  AWP_EMISSIONS_ABI,
  ERC8004_REGISTRY_ABI,
  ERC8004_REPUTATION_ABI,
  AGENT_IDENTITY_ABI,
  REPUTATION_ABI,
  MOCK_USDC_DECIMALS,
  AWP_DECIMALS,
} from "./contracts.js";

export {
  ALL_CONFIGS,
  CONFIG_COUNT,
  parseConfigKey,
  configToParams,
  isConfigValid,
  jobStateToConfigKey,
  configsByAxis,
  AXES,
  AXIS_RULE_NOTES,
} from "./matrix.js";
export type { ConfigParams, ConfigInfo, ValMode, Deadline, SubMode, WorkerAccess, ValidatorAccess } from "./matrix.js";

export {
  ALL_SCENARIOS,
  SCENARIO_COUNT,
  CLASSIFIABLE_SCENARIO_IDS,
  ASPIRATIONAL_SCENARIO_IDS,
  V16_DEFERRED_SCENARIO_IDS,
  getScenarioById,
  isScenarioClassifiable,
} from "./scenarios.js";
export type { Scenario, ScenarioStatus } from "./scenarios.js";

export {
  EVENT_SIGS,
  SIG_TO_NAME,
  EVENT_SIGNATURES,
  ALL_EVENT_NAMES,
  decodeEvent,
  groupEvents,
  computeTopic0,
  firstTxHashForEvent,
} from "./events.js";
export type { EventName, RawLog, DecodedEvent } from "./events.js";

export {
  RULES,
  RULE_IDS,
  RULE_COUNT,
  V15_ERROR_NAMES,
  V4_ERROR_NAMES,
  getRulesForFunction,
  checkAgentEligibility,
  decodeRevertReason,
} from "./rules.js";
export type { Rule, RuleKind, AuditFailureCategory, AgentSnapshot, JobSnapshot, AgentAction, EligibilityResult } from "./rules.js";

export {
  PREDICATES,
  PRIORITY,
  classify,
  classifyAllMatches,
  computeCounts,
  isCellApplicable,
  applicableScenarios,
  ZERO_ADDRESS,
} from "./cell-defs.js";
export type { JobView, SubmissionView, ClassificationCounts, ClassificationContext, ScenarioPredicate, CellKey, TxAttemptSummary } from "./cell-defs.js";

export {
  generateLifecycle,
} from "./generate-lifecycle.js";
export type { CellLifecycle, StepDef, ActorRole, StepKind, ContractAction } from "./generate-lifecycle.js";

export {
  nextRequiredAction,
  isJobStuck,
} from "./state-machine.js";
export type { JobStateForDecision, SubmissionStateForDecision, AgentEligibilityForDecision, DecisionInput, DecisionResult } from "./state-machine.js";
