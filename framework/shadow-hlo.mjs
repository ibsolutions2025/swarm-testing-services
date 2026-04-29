#!/usr/bin/env node
/**
 * shadow-hlo.mjs <libPath>
 *
 * Phase D.2 — read-only HLO simulation. For every config in the given lib's
 * cross-product, generate the full V15.createJob params, validate against
 * the V15 ABI, detect "twin" cells that collapse to identical on-chain state,
 * and pick a scenario+predicate per config. No viem call, no on-chain tx.
 *
 * Then sample 3 cells across the val-mode axis and dispatch each through the
 * agent-rotation logic, printing the agent assignment.
 *
 * Usage:
 *   node framework/shadow-hlo.mjs lib/awp                       # baseline
 *   node framework/shadow-hlo.mjs lib/agentwork-protocol-23becc # engine
 *
 * Exits non-zero on hard failures:
 *   - any config produces V15-invalid params
 *   - any axis source_param missing from V15.createJob ABI
 *   - any predicate isn't callable
 */
import { resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const libArg = process.argv[2];
if (!libArg) {
  console.error("usage: node framework/shadow-hlo.mjs <libPath>");
  process.exit(2);
}
const libPath = isAbsolute(libArg) ? libArg : resolve(process.cwd(), libArg);
const indexPath = resolve(libPath, "index.js");
if (!existsSync(indexPath)) {
  console.error(`${indexPath} missing — run \`npm run build:lib\` first`);
  process.exit(2);
}

const lib = await import(pathToFileURL(indexPath).href);
const matrix = lib.matrix || lib;
const scenarios = lib.scenarios || lib;
const cellDefs = lib.cellDefs || lib;
const contracts = lib.contracts || lib;

// ────────────────────────────────────────────────────────────────────────
// Locate the JobNFT createJob ABI
// ────────────────────────────────────────────────────────────────────────
let jobNftAbi = null;
for (const k of ["JOB_NFT_ABI", "JOBNFT_ABI"]) {
  if (Array.isArray(contracts[k])) { jobNftAbi = contracts[k]; break; }
}
if (!jobNftAbi) {
  for (const v of Object.values(contracts)) {
    if (Array.isArray(v) && v.some((e) => e?.type === "function" && e?.name === "createJob")) { jobNftAbi = v; break; }
  }
}
if (!jobNftAbi) { console.error("could not locate JobNFT ABI"); process.exit(2); }
const createJobFn = jobNftAbi.find((e) => e?.type === "function" && e?.name === "createJob");
if (!createJobFn) { console.error("createJob not in JobNFT ABI"); process.exit(2); }
const createJobInputs = createJobFn.inputs;
const abiParamSet = new Set(createJobInputs.map((i) => i.name));

// ────────────────────────────────────────────────────────────────────────
// Adapter — both AXES shapes (fixture object, engine array)
// ────────────────────────────────────────────────────────────────────────
function describeLib() {
  const AXES = matrix.AXES;
  const ALL_CONFIGS = matrix.ALL_CONFIGS;
  if (Array.isArray(AXES)) {
    // Engine: array of { name, source_param, values, maps_to }
    return {
      style: "engine",
      axes: AXES,
      axisNames: AXES.map((a) => a.name),
      configs: ALL_CONFIGS,
      configToParams: (key) => engineConfigToParams(AXES, key),
    };
  }
  // Fixture: object keyed by axis name. configToParams is a function on the matrix module.
  if (typeof matrix.configToParams === "function") {
    return {
      style: "fixture",
      axes: Object.keys(AXES).map((n) => ({ name: n, values: [...AXES[n]] })),
      axisNames: Object.keys(AXES),
      configs: ALL_CONFIGS,
      configToParams: matrix.configToParams,
    };
  }
  throw new Error("lib has neither array AXES nor configToParams function");
}

function engineConfigToParams(axes, key) {
  // Config keys are axis values joined by "-". Some values themselves contain
  // hyphens ("approved-list", "rating-gate") so we have to walk axis-by-axis,
  // checking which value matches the prefix of remaining.
  let remaining = key;
  const params = {};
  for (let ai = 0; ai < axes.length; ai++) {
    const axis = axes[ai];
    let matched = null;
    // Sort values longest-first so "approved-list" wins over "approved" if both existed.
    const sortedValues = [...axis.values].sort((a, b) => b.length - a.length);
    for (const v of sortedValues) {
      if (remaining === v || remaining.startsWith(v + "-")) { matched = v; break; }
    }
    if (matched === null) throw new Error(`parse failed for "${key}" at axis ${axis.name}; remaining="${remaining}"`);
    Object.assign(params, axis.maps_to?.[matched] || {});
    remaining = remaining === matched ? "" : remaining.slice(matched.length + 1);
  }
  if (remaining !== "") throw new Error(`config key "${key}" had trailing "${remaining}"`);
  return params;
}

// ────────────────────────────────────────────────────────────────────────
// V15 ABI param validation
//
// Two libs use different naming conventions:
//   - engine: validationMode_ (matches ABI's trailing underscore exactly)
//   - fixture: validationMode (cleaner; HLO maps these to ABI on dispatch)
// The validator normalizes by trying both name and name_/no-name_ variants.
//
// Lib metadata (axis names like "valMode", "deadline" in the fixture) don't
// map to V15 inputs — the HLO picks the ABI-matching subset at dispatch.
// We don't flag those as errors; only validate matched-pair shapes.
// ────────────────────────────────────────────────────────────────────────
function lookupParam(params, abiName) {
  if (abiName in params) return params[abiName];
  // ABI uses trailing _; lib might omit it (e.g. fixture validationMode → ABI validationMode_)
  if (abiName.endsWith("_")) {
    const stripped = abiName.slice(0, -1);
    if (stripped in params) return params[stripped];
  }
  // Lib uses trailing _; ABI strips it (rare; here for safety)
  if (!abiName.endsWith("_") && (abiName + "_") in params) return params[abiName + "_"];
  return undefined;
}

function validateAbi(params) {
  const errors = [];
  for (const inp of createJobInputs) {
    const v = lookupParam(params, inp.name);
    if (v === undefined) continue; // HLO fills it (title, description, ...) — skip
    if (inp.type === "uint8") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255)
        errors.push(`${inp.name} (uint8) invalid: ${JSON.stringify(v)}`);
    } else if (inp.type === "uint256") {
      if (typeof v !== "number" && typeof v !== "bigint" && typeof v !== "string")
        errors.push(`${inp.name} (uint256) wrong type: ${typeof v}`);
      else if (typeof v === "number" && (!Number.isInteger(v) || v < 0))
        errors.push(`${inp.name} (uint256) invalid number: ${v}`);
    } else if (inp.type === "bool") {
      if (typeof v !== "boolean") errors.push(`${inp.name} (bool) wrong type: ${typeof v}`);
    } else if (inp.type === "string") {
      if (typeof v !== "string") errors.push(`${inp.name} (string) wrong type: ${typeof v}`);
    } else if (inp.type === "address[]") {
      if (!Array.isArray(v)) errors.push(`${inp.name} (address[]) not array`);
    }
  }
  return errors;
}

// ────────────────────────────────────────────────────────────────────────
// V15 C4 constraint check: validationMode_=0 (HARD_ONLY) ⇒
//   minValidatorRating_=0 AND approvedValidators=[] AND openValidation=true
// (matches fixture's AXIS_RULE_NOTES.v15_C4)
// ────────────────────────────────────────────────────────────────────────
function checkC4(params) {
  const errors = [];
  const valMode = lookupParam(params, "validationMode_");
  if (valMode === 0) {
    const minVR = lookupParam(params, "minValidatorRating_") ?? 0;
    if (minVR !== 0) errors.push(`C4: HARD_ONLY but minValidatorRating=${minVR}`);
    const approvedV = lookupParam(params, "approvedValidators") ?? [];
    if (Array.isArray(approvedV) && approvedV.length > 0) errors.push(`C4: HARD_ONLY but approvedValidators non-empty`);
  }
  return errors;
}

// ────────────────────────────────────────────────────────────────────────
// Twin detection — group configs by canonical params
// ────────────────────────────────────────────────────────────────────────
function canonicalize(o) {
  if (Array.isArray(o)) return o.map(canonicalize);
  if (o && typeof o === "object") {
    const out = {};
    for (const k of Object.keys(o).sort()) out[k] = canonicalize(o[k]);
    return out;
  }
  return o;
}

// ────────────────────────────────────────────────────────────────────────
// Agent rotation (simulated; mirrors HLO daemon's round-robin)
// ────────────────────────────────────────────────────────────────────────
const AGENTS = ["agent-36ce", "agent-3100", "agent-5044", "agent-98c5", "agent-d4a8", "agent-01f1", "agent-c8e4"];
function pickAgentByCellSeed(cellKey) {
  let h = 0;
  for (const c of cellKey) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return AGENTS[h % AGENTS.length];
}

// ────────────────────────────────────────────────────────────────────────
// Predicate stub-call check — at least the catch-all s00-in-flight should
// fire for any "fresh" job context.
// ────────────────────────────────────────────────────────────────────────
const stubCtx = {
  job: { status: 0, activeValidator: "0x0000000000000000000000000000000000000000" },
  submissions: [],
  events: {
    JobCreated: [], WorkSubmitted: [], SubmissionApproved: [], SubmissionRejected: [],
    JobCancelled: [], AllSubmissionsRejected: [], TimedJobFinalized: [],
    ValidatorRotated: [], ValidatorClaimed: [], ScriptResultRecorded: [],
    RatingGateFailed: [], JobCreatedV15: [], JobAccepted: [], ValidationScriptResult: [],
  },
  counts: { approved: 0, rejected: 0, pending: 0, notSel: 0, distinctWorkers: 0, all_rejected: false },
  configParams: {},
};

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────
console.log(`\n=== shadow-hlo :: ${libArg} ===\n`);

const desc = describeLib();
const fatalErrors = [];

console.log(`[lib]`);
console.log(`  style:           ${desc.style}`);
console.log(`  axes:            ${desc.axisNames.join(", ")}`);
console.log(`  configs total:   ${desc.configs.length}`);
console.log(`  ABI param set:   ${abiParamSet.size} createJob inputs`);

// 1. Validate every config produces ABI-valid params
let valid = 0, invalid = 0;
const constraintViolators = [];
const paramSamples = [];
const groups = new Map();
for (const key of desc.configs) {
  let params;
  try {
    params = desc.configToParams(key);
  } catch (e) {
    fatalErrors.push(`config="${key}" parse error: ${e.message}`);
    invalid++;
    continue;
  }
  const abiErrs = validateAbi(params);
  const c4Errs = checkC4(params);
  if (abiErrs.length === 0 && c4Errs.length === 0) {
    valid++;
  } else {
    invalid++;
    if (abiErrs.length) fatalErrors.push(`config="${key}" ABI errors: ${abiErrs.join("; ")}`);
    if (c4Errs.length) constraintViolators.push({ key, errs: c4Errs });
  }
  // Twin grouping (canonical params)
  const sig = JSON.stringify(canonicalize(params));
  if (!groups.has(sig)) groups.set(sig, []);
  groups.get(sig).push(key);
  paramSamples.push({ key, params });
}

console.log(`\n[validation]`);
console.log(`  configs walked:                  ${desc.configs.length}`);
console.log(`  configs producing valid params:  ${valid}/${desc.configs.length}  (${((valid / desc.configs.length) * 100).toFixed(1)}%)`);
console.log(`  invalid configs:                 ${invalid}`);
if (constraintViolators.length) {
  console.log(`  AXIS_CONSTRAINTS violators:      ${constraintViolators.length}`);
  for (const cv of constraintViolators.slice(0, 5)) {
    console.log(`    ✗ ${cv.key} — ${cv.errs.join("; ")}`);
  }
}

// 2. Twin detection
const twins = [...groups.entries()].filter(([_, keys]) => keys.length > 1);
console.log(`\n[twins]`);
console.log(`  unique on-chain states: ${groups.size}`);
console.log(`  twin groups:            ${twins.length}`);
if (twins.length) {
  console.log(`  config-keys grouped by identical createJob params:`);
  for (const [_sig, keys] of twins.slice(0, 16)) {
    console.log(`    · [${keys.length}] ${keys.join(" ≡ ")}`);
  }
  if (twins.length > 16) console.log(`    ...and ${twins.length - 16} more groups`);
}

// 3. Predicate stub-call check
console.log(`\n[predicates]`);
const predicates = cellDefs.PREDICATES || {};
let predFn = 0, predThrew = 0;
for (const [id, p] of Object.entries(predicates)) {
  if (typeof p !== "function") {
    fatalErrors.push(`predicate ${id} not callable (typeof ${typeof p})`);
    continue;
  }
  predFn++;
  try { p(stubCtx); } catch (e) { predThrew++; }
}
console.log(`  callable:        ${predFn}/${Object.keys(predicates).length}`);
console.log(`  threw on stub:   ${predThrew}`);

// 4. Sample 3 cells (one per val-mode value) — full createJob param dump
console.log(`\n[sample cells (3 picked across val-mode)]`);
function pickValModeAxis(axes) {
  return axes.find((a) => /val.*mode|valmode/i.test(a.name));
}
const valModeAxis = pickValModeAxis(desc.axes);
const valModeValues = valModeAxis ? valModeAxis.values : [];
const samples = [];
for (const v of valModeValues.slice(0, 3)) {
  // Pick first config whose key starts with this val-mode value
  const found = paramSamples.find((p) => p.key.startsWith(v + "-"));
  if (found) samples.push({ valModeValue: v, ...found });
}
for (const s of samples) {
  const agent = pickAgentByCellSeed(s.key);
  console.log(`\n  ━━ cell ${s.key} (val-mode=${s.valModeValue}) → assigned to ${agent} ━━`);
  // Print params, sorted by ABI input order (so side-by-side compare is easy).
  // Use lookupParam so fixture's no-underscore names align with ABI underscore convention.
  for (const inp of createJobInputs) {
    const v = lookupParam(s.params, inp.name);
    if (v === undefined) continue;
    const display = Array.isArray(v) ? `[${v.length} address(es)]` : JSON.stringify(v);
    console.log(`    ${inp.name.padEnd(28)} ${inp.type.padEnd(11)} ${display}`);
  }
}

// 5. Verdict
console.log("");
if (fatalErrors.length) {
  console.log(`[FAIL] ${fatalErrors.length} hard failure(s):`);
  for (const e of fatalErrors.slice(0, 10)) console.log(`  ✗ ${e}`);
  if (fatalErrors.length > 10) console.log(`  ...and ${fatalErrors.length - 10} more`);
  process.exit(1);
}
console.log(`[OK] shadow-hlo passed — ${valid}/${desc.configs.length} configs valid, ${twins.length} twin groups`);
process.exit(0);
