#!/usr/bin/env node
/**
 * validate-engine-lib.mjs <libPath>
 *
 * Phase D.1 — structural soundness check for any lib/<slug>/ produced by
 * the engine OR hand-written fixtures. Asserts the lib is consumable by
 * the rest of the runtime stack (HLO, scanner, auditor) without actually
 * dispatching anything on-chain.
 *
 * Usage:
 *   node framework/validate-engine-lib.mjs lib/awp                       # baseline
 *   node framework/validate-engine-lib.mjs lib/agentwork-protocol-23becc # engine
 *
 * Exits non-zero on any HARD failure listed in the spec:
 *   - any predicate isn't a function
 *   - cross-product yields 0 valid configs
 *   - import errors
 *   - axis source_param names don't match the V15 ABI (engine-style libs only)
 */
import { resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const libArg = process.argv[2];
if (!libArg) {
  console.error("usage: node framework/validate-engine-lib.mjs <libPath>");
  process.exit(2);
}
const libPath = isAbsolute(libArg) ? libArg : resolve(process.cwd(), libArg);
if (!existsSync(libPath)) {
  console.error(`lib path does not exist: ${libPath}`);
  process.exit(2);
}

const indexPath = resolve(libPath, "index.js");
if (!existsSync(indexPath)) {
  console.error(`${indexPath} missing — run \`npm run build:lib\` first`);
  process.exit(2);
}

let lib;
try {
  lib = await import(pathToFileURL(indexPath).href);
} catch (e) {
  console.error(`IMPORT FAILED for ${libArg}:`, e.message);
  process.exit(1);
}

const errors = [];
const warnings = [];

function report(label, value) {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

console.log(`\n=== validate-engine-lib :: ${libArg} ===\n`);

// ────────────────────────────────────────────────────────────────────────
// AXES + cross-product configs
// ────────────────────────────────────────────────────────────────────────
console.log(`[matrix]`);
const matrix = lib.matrix || lib;
const AXES = matrix.AXES;
let axisCount = 0;
let axisNames = [];
let sourceParams = [];
if (Array.isArray(AXES)) {
  // Engine-style: array of { name, source_param, values, maps_to }.
  // source_param can be a string (single param) OR an array (axis collapses
  // multiple params, e.g. worker-access = approvedWorkers_ + minWorkerRating_).
  axisCount = AXES.length;
  axisNames = AXES.map((a) => a.name || "<unnamed>");
  sourceParams = AXES.flatMap((a) => {
    if (typeof a.source_param === "string") return [a.source_param];
    if (Array.isArray(a.source_param)) return a.source_param.filter((s) => typeof s === "string");
    return [];
  });
} else if (AXES && typeof AXES === "object") {
  // Fixture-style: { name: [...values] }
  axisNames = Object.keys(AXES);
  axisCount = axisNames.length;
} else {
  errors.push(`AXES export missing or wrong type (${typeof AXES})`);
}
report("AXES count", axisCount);
report("axis names", axisNames.join(", "));
if (sourceParams.length) report("source_params", sourceParams.join(", "));

const ALL_CONFIGS = matrix.ALL_CONFIGS;
const CONFIG_COUNT = matrix.CONFIG_COUNT ?? (Array.isArray(ALL_CONFIGS) ? ALL_CONFIGS.length : null);
if (!Array.isArray(ALL_CONFIGS)) {
  errors.push("ALL_CONFIGS missing or not an array");
} else if (ALL_CONFIGS.length === 0) {
  errors.push("ALL_CONFIGS has 0 entries — cross-product yields nothing");
}
report("CONFIG_COUNT", CONFIG_COUNT);
if (Array.isArray(ALL_CONFIGS) && ALL_CONFIGS.length > 0) {
  report("config sample", ALL_CONFIGS.slice(0, 3).join(" | "));
}

// Engine-only check: source_param names must match V15.createJob ABI args
if (sourceParams.length) {
  try {
    const contracts = lib.contracts || lib;
    // Try several common ABI export names; fall back to scanning for one that
    // contains a createJob entry.
    const candidates = ["JOB_NFT_ABI", "JOBNFT_ABI", "JOB_NFT_V15_ABI"];
    let abi = null;
    for (const k of candidates) {
      if (Array.isArray(contracts[k])) { abi = contracts[k]; break; }
    }
    if (!abi) {
      for (const v of Object.values(contracts)) {
        if (Array.isArray(v) && v.some((e) => e?.type === "function" && e?.name === "createJob")) {
          abi = v; break;
        }
      }
    }
    if (!abi) {
      warnings.push("could not locate JobNFT ABI export to validate axis source_params");
    } else {
      const createJob = abi.find((e) => e?.type === "function" && e?.name === "createJob");
      if (!createJob) {
        warnings.push("createJob not found in JobNFT ABI");
      } else {
        const abiParamNames = new Set();
        function collectNames(inputs) {
          for (const i of inputs || []) {
            if (i.name) abiParamNames.add(i.name);
            if (Array.isArray(i.components)) collectNames(i.components);
          }
        }
        collectNames(createJob.inputs);
        const unknown = sourceParams.filter((p) => !abiParamNames.has(p) && !abiParamNames.has(p.replace(/_$/, "")));
        if (unknown.length) {
          // Engine emits trailing "_" sometimes (validationMode_) — accept matches
          // either with or without the underscore.
          errors.push(`axis source_params NOT in V15.createJob ABI: ${unknown.join(", ")}`);
        } else {
          report("source_param ↔ ABI", `all ${sourceParams.length} match V15.createJob inputs`);
        }
      }
    }
  } catch (e) {
    warnings.push(`source_param ABI check threw: ${e.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// SCENARIOS
// ────────────────────────────────────────────────────────────────────────
console.log(`\n[scenarios]`);
const scenarios = lib.scenarios || lib;
const ALL_SCENARIOS = scenarios.ALL_SCENARIOS;
if (!Array.isArray(ALL_SCENARIOS)) {
  errors.push("ALL_SCENARIOS missing or not an array");
} else {
  report("total", ALL_SCENARIOS.length);
  const byStatus = {};
  for (const s of ALL_SCENARIOS) {
    const k = s.status || "<unknown>";
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byStatus)) {
    report(`  status=${k}`, v);
  }
  // List applicability expressions (compact)
  const applicabilities = ALL_SCENARIOS.map((s) => `${s.id}: ${s.applicability || "any"}`);
  console.log(`  applicability:`);
  for (const a of applicabilities.slice(0, 12)) console.log(`    · ${a}`);
  if (applicabilities.length > 12) console.log(`    · ...and ${applicabilities.length - 12} more`);
}

// ────────────────────────────────────────────────────────────────────────
// CELL PREDICATES — every entry must be a callable function;
// invoke each with a stub context to confirm no throw.
// ────────────────────────────────────────────────────────────────────────
console.log(`\n[cell-defs]`);
const cellDefs = lib.cellDefs || lib;
const PREDICATES = cellDefs.PREDICATES;
const PRIORITY = cellDefs.PRIORITY;
if (!PREDICATES || typeof PREDICATES !== "object") {
  errors.push("PREDICATES missing or not an object");
} else {
  const ids = Object.keys(PREDICATES);
  report("predicate count", ids.length);
  if (Array.isArray(PRIORITY)) report("PRIORITY length", PRIORITY.length);

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

  let nonFn = 0, threw = 0, fnOk = 0;
  for (const [id, pred] of Object.entries(PREDICATES)) {
    if (typeof pred !== "function") {
      errors.push(`predicate ${id} is not a function (got ${typeof pred})`);
      nonFn++;
      continue;
    }
    try {
      const r = pred(stubCtx);
      if (typeof r !== "boolean") {
        warnings.push(`predicate ${id} returned non-boolean: ${typeof r}`);
      }
      fnOk++;
    } catch (e) {
      warnings.push(`predicate ${id} threw on stub ctx: ${e.message?.slice(0, 100)}`);
      threw++;
    }
  }
  report("typeof === function", `${fnOk}/${ids.length} ok`);
  if (nonFn) report("NON-FUNCTIONS", nonFn);
  if (threw) report("threw on stub", threw);
}

// ────────────────────────────────────────────────────────────────────────
// RULES
// ────────────────────────────────────────────────────────────────────────
console.log(`\n[rules]`);
const rules = lib.rules || lib;
const RULES = rules.RULES;
if (!Array.isArray(RULES)) {
  errors.push("RULES missing or not an array");
} else {
  report("total", RULES.length);
  // Group by contract — the prefix of rule.id (before the first dot)
  const byContract = {};
  for (const r of RULES) {
    const prefix = String(r.id || "").split(".")[0] || "<unknown>";
    byContract[prefix] = (byContract[prefix] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byContract)) {
    report(`  ${k}`, v);
  }
  // unique fns
  const fns = new Set(RULES.map((r) => r.fn).filter(Boolean));
  report("unique fns", fns.size);
}

// ────────────────────────────────────────────────────────────────────────
// EVENTS — sanity that EVENT_SIGS resolves to topic0 hashes
// ────────────────────────────────────────────────────────────────────────
console.log(`\n[events]`);
const events = lib.events || lib;
const EVENT_SIGS = events.EVENT_SIGS;
if (!EVENT_SIGS || typeof EVENT_SIGS !== "object") {
  errors.push("EVENT_SIGS missing or wrong shape");
} else {
  const names = Object.keys(EVENT_SIGS);
  report("event count", names.length);
  // Spot-check shape: each value is a 0x66-char hex string (32 bytes + 0x)
  let bad = 0;
  for (const [n, sig] of Object.entries(EVENT_SIGS)) {
    if (typeof sig !== "string" || !/^0x[0-9a-f]{64}$/i.test(sig)) bad++;
  }
  if (bad) errors.push(`${bad} EVENT_SIGS entries are not 0x..32-byte hex`);
  else report("topic0 shape", "all 32-byte hex");
}

// ────────────────────────────────────────────────────────────────────────
// Final verdict
// ────────────────────────────────────────────────────────────────────────
console.log("");
if (warnings.length) {
  console.log(`[warn] ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  · ${w}`);
}
if (errors.length) {
  console.log(`[FAIL] ${errors.length} hard failure(s):`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`[OK] structural validation passed (${warnings.length} warnings)`);
process.exit(0);
