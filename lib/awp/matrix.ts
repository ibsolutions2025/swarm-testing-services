// lib/awp/matrix.ts
//
// 5-axis config space for AWP V15 + V4. 84 valid configs total. Each config
// key maps to the params V15.createJob() expects, plus a derived metadata
// object the dashboard / auditor / scanner consume.
//
// Axes:
//   valMode          { soft, hard, hardsift }  → uint8 validationMode
//   deadline         { open, timed }           → submissionMode + submissionWindow
//   subMode          { single, multi }         → uint8 submissionMode (FCFS/TIMED-style)
//   workerAccess     { open, approved, rating }
//   validatorAccess  { open, approved, rating, na }    "na" only valid when valMode==hard
//
// Constraints (V15 C4):
//   valMode == 'hard' ⇒ validatorAccess == 'na' (no validators on HARD_ONLY,
//     and minValidatorRating must be 0 + approvedValidators must be empty).
//
// Total: (soft+hardsift) × deadline × subMode × workerAccess × validatorAccess
//      = 2 × 2 × 2 × 3 × 3 = 72
//      + hard × 2 × 2 × 3 × 1 = 12
//      = 84
//
// Source of truth: clients/awp/matrix/configs.json (axisRules + generated_keys).
// This file is the TS port — `ALL_CONFIGS` matches that JSON's generated_keys
// 1:1 (verified by isConfigValid + count).

export type ValMode = "soft" | "hard" | "hardsift";
export type Deadline = "open" | "timed";
export type SubMode = "single" | "multi";
export type WorkerAccess = "open" | "approved" | "rating";
export type ValidatorAccess = "open" | "approved" | "rating" | "na";

export interface ConfigParams {
  valMode: ValMode;
  deadline: Deadline;
  subMode: SubMode;
  workerAccess: WorkerAccess;
  validatorAccess: ValidatorAccess;

  // Derived V15.createJob args (the 14 non-rate args; the 6 string/array args
  // — title, description, requirementsJson, approvedWorkers, approvedValidators,
  // validationInstructions — are filled by HLO at dispatch time)
  validationMode: 0 | 1 | 2;          // 0=HARD_ONLY 1=SOFT_ONLY 2=HARD_THEN_SOFT
  submissionMode: 0 | 1;              // 0=FCFS  1=TIMED
  submissionWindow: number;           // seconds; 0 for FCFS
  validationScriptCID: string;        // 'QmTest...' for hard/hardsift, '' for soft
  allowResubmission: boolean;
  allowRejectAll: boolean;
  openValidation: boolean;
  minWorkerRating: number;            // basis points, 0 disables
  minValidatorRating: number;         // basis points, 0 disables

  // Hint flags for HLO eligibility selection (not on-chain args)
  needsApprovedWorkers: boolean;
  needsApprovedValidators: boolean;
}

export interface ConfigInfo {
  key: string;
  params: ConfigParams;
  validatorAccessApplicable: boolean; // false when valMode==hard (validator axis is N/A)
}

// ============================================================================
// Config key parsing + generation
// ============================================================================

const VAL_MODE_TO_INT: Record<ValMode, 0 | 1 | 2> = { hard: 0, soft: 1, hardsift: 2 };
const SUB_MODE_TO_INT: Record<SubMode, 0 | 1> = { single: 0, multi: 1 };

const DEFAULT_TIMED_WINDOW_SECONDS = 7200; // 2 hours
const DEFAULT_RATING_BPS = 400;            // 4.00 stars
const DEFAULT_VALIDATION_SCRIPT_CID = "QmTestValidationScript_AWP_v1";

/**
 * Parse a config key like "soft-open-multi-rating-approved" into structured
 * axes + a full V15.createJob params bundle. Throws if the key is malformed
 * or violates V15 C4 (hard + non-na validator).
 */
export function parseConfigKey(key: string): ConfigParams {
  const parts = key.split("-");
  if (parts.length !== 5) {
    throw new Error(`[matrix.parseConfigKey] expected 5 parts, got ${parts.length} from "${key}"`);
  }
  const [vm, dl, sm, wa, va] = parts as [ValMode, Deadline, SubMode, WorkerAccess, ValidatorAccess];

  if (!(vm === "soft" || vm === "hard" || vm === "hardsift")) throw new Error(`[matrix] bad valMode "${vm}" in "${key}"`);
  if (!(dl === "open" || dl === "timed")) throw new Error(`[matrix] bad deadline "${dl}" in "${key}"`);
  if (!(sm === "single" || sm === "multi")) throw new Error(`[matrix] bad subMode "${sm}" in "${key}"`);
  if (!(wa === "open" || wa === "approved" || wa === "rating")) throw new Error(`[matrix] bad workerAccess "${wa}" in "${key}"`);
  if (!(va === "open" || va === "approved" || va === "rating" || va === "na")) throw new Error(`[matrix] bad validatorAccess "${va}" in "${key}"`);

  // V15 C4 enforcement
  if (vm === "hard" && va !== "na") {
    throw new Error(`[matrix] V15 C4: valMode=hard requires validatorAccess=na, got "${va}" in "${key}"`);
  }
  if (vm !== "hard" && va === "na") {
    throw new Error(`[matrix] validatorAccess=na is only valid when valMode=hard, got "${vm}" in "${key}"`);
  }

  const validationMode = VAL_MODE_TO_INT[vm];
  const submissionMode = SUB_MODE_TO_INT[sm];

  return {
    valMode: vm,
    deadline: dl,
    subMode: sm,
    workerAccess: wa,
    validatorAccess: va,

    validationMode,
    submissionMode,
    submissionWindow: submissionMode === 1 ? DEFAULT_TIMED_WINDOW_SECONDS : 0,
    validationScriptCID: vm === "soft" ? "" : DEFAULT_VALIDATION_SCRIPT_CID,
    allowResubmission: sm === "multi",
    allowRejectAll: vm === "soft" && sm === "multi",
    openValidation: va !== "approved" || vm === "hard",
    minWorkerRating: wa === "rating" ? DEFAULT_RATING_BPS : 0,
    minValidatorRating: va === "rating" && vm !== "hard" ? DEFAULT_RATING_BPS : 0,

    needsApprovedWorkers: wa === "approved",
    needsApprovedValidators: va === "approved" && vm !== "hard",
  };
}

/**
 * Generate the canonical 84-config catalog. Keys are produced in a stable
 * lexicographic order matching clients/awp/matrix/configs.json.generated_keys.
 */
function generateAllConfigs(): string[] {
  const valModes: ValMode[] = ["soft", "hard", "hardsift"];
  const deadlines: Deadline[] = ["open", "timed"];
  const subModes: SubMode[] = ["single", "multi"];
  const workerAccesses: WorkerAccess[] = ["open", "approved", "rating"];
  const validatorAccessesNonHard: ValidatorAccess[] = ["open", "approved", "rating"];

  const out: string[] = [];
  for (const vm of valModes) {
    for (const dl of deadlines) {
      for (const sm of subModes) {
        for (const wa of workerAccesses) {
          if (vm === "hard") {
            out.push(`${vm}-${dl}-${sm}-${wa}-na`);
          } else {
            for (const va of validatorAccessesNonHard) {
              out.push(`${vm}-${dl}-${sm}-${wa}-${va}`);
            }
          }
        }
      }
    }
  }
  return out;
}

export const ALL_CONFIGS: string[] = generateAllConfigs();

/**
 * Returns true if `key` is one of the 84 valid configs (i.e. does not violate
 * V15 C4). Cheaper than parseConfigKey() if you just need a yes/no.
 */
export function isConfigValid(key: string): boolean {
  if (typeof key !== "string") return false;
  const parts = key.split("-");
  if (parts.length !== 5) return false;
  const [vm, dl, sm, wa, va] = parts;
  if (!["soft", "hard", "hardsift"].includes(vm)) return false;
  if (!["open", "timed"].includes(dl)) return false;
  if (!["single", "multi"].includes(sm)) return false;
  if (!["open", "approved", "rating"].includes(wa)) return false;
  if (vm === "hard") {
    if (va !== "na") return false;
  } else {
    if (!["open", "approved", "rating"].includes(va)) return false;
  }
  return true;
}

/**
 * Produce the on-chain createJob args (the structured params bundle) for a
 * given config key, plus a hint set the HLO uses to fill the human-language
 * fields and pick approvedWorkers/approvedValidators wallets.
 *
 * Caller is responsible for: title, description, requirementsJson,
 * validationInstructions, approvedWorkers (if needsApprovedWorkers),
 * approvedValidators (if needsApprovedValidators).
 */
export function configToParams(key: string): ConfigParams {
  if (!isConfigValid(key)) {
    throw new Error(`[matrix.configToParams] invalid key "${key}"`);
  }
  return parseConfigKey(key);
}

/**
 * Reverse mapping: classify an on-chain Job into its config key. Used by
 * the scanner when a job didn't carry a tag in the title.
 *
 * Returns `null` when the job state is internally inconsistent (e.g.
 * minValidatorRating > 0 on a HARD_ONLY job — should be impossible per C4).
 */
export function jobStateToConfigKey(job: {
  validationMode: number;
  submissionMode: number;
  submissionWindow: number;
  submissionDeadline: number;
  approvedWorkers: { length: number } | unknown[];
  approvedValidators?: { length: number } | unknown[]; // not in getJobV15 return — caller may not have it
  openValidation: boolean;
  minWorkerRating: number;
  minValidatorRating: number;
  title?: string;
}): string | null {
  // Try title-tag first (swarm-create / HLO embed the key in the title)
  const m = job.title?.match(/\(([a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+)\)$/);
  if (m && isConfigValid(m[1])) return m[1];

  const valModes: Record<number, ValMode> = { 0: "hard", 1: "soft", 2: "hardsift" };
  const vm = valModes[job.validationMode];
  if (!vm) return null;

  const dl: Deadline =
    job.submissionMode === 1 || job.submissionWindow > 0 || job.submissionDeadline > 0 ? "timed" : "open";
  const sm: SubMode = job.submissionMode === 1 ? "multi" : "single";

  let wa: WorkerAccess = "open";
  if ((job.approvedWorkers as unknown[]).length > 0) wa = "approved";
  else if (job.minWorkerRating > 0) wa = "rating";

  let va: ValidatorAccess = "open";
  if (vm === "hard") va = "na";
  else if (!job.openValidation) va = "approved";
  else if (job.minValidatorRating > 0) va = "rating";

  // V15 C4 guard
  if (vm === "hard" && (job.minValidatorRating > 0 || (job.approvedValidators && (job.approvedValidators as unknown[]).length > 0))) {
    return null; // would-be-impossible state
  }

  const key = `${vm}-${dl}-${sm}-${wa}-${va}`;
  return isConfigValid(key) ? key : null;
}

// ============================================================================
// Convenience exports
// ============================================================================
export const CONFIG_COUNT = ALL_CONFIGS.length;

/**
 * Returns the configs that match a partial axis filter. Used by the
 * dashboard to render axis legends and by HLO to find untested cells.
 */
export function configsByAxis(filter: Partial<{
  valMode: ValMode; deadline: Deadline; subMode: SubMode;
  workerAccess: WorkerAccess; validatorAccess: ValidatorAccess;
}>): string[] {
  return ALL_CONFIGS.filter((k) => {
    const p = parseConfigKey(k);
    if (filter.valMode && p.valMode !== filter.valMode) return false;
    if (filter.deadline && p.deadline !== filter.deadline) return false;
    if (filter.subMode && p.subMode !== filter.subMode) return false;
    if (filter.workerAccess && p.workerAccess !== filter.workerAccess) return false;
    if (filter.validatorAccess && p.validatorAccess !== filter.validatorAccess) return false;
    return true;
  });
}

export const AXES = {
  valMode: ["soft", "hard", "hardsift"] as const,
  deadline: ["open", "timed"] as const,
  subMode: ["single", "multi"] as const,
  workerAccess: ["open", "approved", "rating"] as const,
  validatorAccess: ["open", "approved", "rating", "na"] as const,
} as const;

export const AXIS_RULE_NOTES = {
  v15_C4: "valMode=hard ⇒ validatorAccess=na (HARD_ONLY rejects validator-axis config; minValidatorRating must be 0; approvedValidators must be empty)",
  v15_window: "submissionMode=TIMED ⇒ submissionWindow > 0 (default 7200s); submissionMode=FCFS ⇒ submissionWindow == 0",
  v15_script: "valMode in {hard,hardsift} ⇒ validationScriptCID required; valMode=soft ⇒ scriptCID forbidden",
  v15_resub:  "subMode=multi ⇒ allowResubmission=true; subMode=single ⇒ allowResubmission=false",
  v15_rejAll: "allowRejectAll only sensible when valMode=soft AND subMode=multi (validator can sweep + restart)",
  v15_rating: "workerAccess=rating ⇒ minWorkerRating=400 (4.0 stars); validatorAccess=rating ⇒ minValidatorRating=400; both require ≥3 reviews per V15 C5",
};
