#!/usr/bin/env node
/**
 * framework/onboarding/validate-against-fixture.mjs
 *
 * Diff harness for Phase B. Compares the auto-generated lib/<slug>/* tree
 * against the hand-written lib/<fixture>/* tree (default: agentwork-protocol
 * vs awp). Reports per-file semantic similarity.
 *
 * Files compared (semantic, not literal):
 *   contracts.ts   — CONTRACT_ADDRESSES + per-ABI signatures
 *   events.ts      — EVENT_SIGS topic0 hashes (must match byte-for-byte)
 *   rules.ts       — RULES list count + fn/errorName overlap
 *   matrix.ts      — AXES count + axis names + total config count
 *   scenarios.ts   — ALL_SCENARIOS ids + classifiable count
 *   cell-defs.ts   — PREDICATES key set + PRIORITY length
 *   state-machine.ts — exported symbols only (it's stub on engine side)
 *
 * Each file gets:
 *   - file size delta
 *   - similarity score (0-100)
 *   - hard mismatches list
 *   - acceptable variances list
 *
 * Exit 0 always — diff report is the deliverable, not a pass/fail gate.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : def;
}

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const engineSlug = argVal("--engine", "agentwork-protocol");
const fixtureSlug = argVal("--fixture", "awp");

console.log("=== Validate engine output vs hand-written fixture ===");
console.log(`Engine slug:  ${engineSlug}`);
console.log(`Fixture slug: ${fixtureSlug}`);
console.log("");

function setDiff(a, b) {
  const A = new Set(a), B = new Set(b);
  return {
    only_in_fixture: [...A].filter((x) => !B.has(x)),
    only_in_engine: [...B].filter((x) => !A.has(x)),
    shared: [...A].filter((x) => B.has(x)),
  };
}

function similarity(shared, total) {
  return total === 0 ? 100 : Math.round((shared / total) * 100);
}

function tryRead(path) {
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

// ─── contracts.ts ─────────────────────────────────────────────────
function extractAddresses(src) {
  const m = src.match(/CONTRACT_ADDRESSES\s*=\s*\{([\s\S]*?)\}\s*(?:as const)?\s*;/);
  if (!m) return null;
  const out = {};
  const re = /(\w+)\s*:\s*'(0x[0-9a-fA-F]{40})'/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) out[mm[1]] = mm[2].toLowerCase();
  return out;
}

function extractAbiKeys(src) {
  return [...src.matchAll(/export const (\w+_ABI)\s*=/g)].map((m) => m[1]);
}

function extractAbiSigCounts(src) {
  // Match each ABI block, count entries by type
  const out = {};
  const re = /export const (\w+_ABI)\s*=\s*\[/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    let depth = 0, i = m.index + m[0].length - 1, inStr = false, strCh = null, lc = false, bc = false;
    for (; i < src.length; i++) {
      const c = src[i], c2 = src[i + 1] || "";
      if (lc) { if (c === "\n") lc = false; continue; }
      if (bc) { if (c === "*" && c2 === "/") { bc = false; i++; } continue; }
      if (inStr) { if (c === "\\") { i++; continue; } if (c === strCh) { inStr = false; strCh = null; } continue; }
      if (c === "/" && c2 === "/") { lc = true; i++; continue; }
      if (c === "/" && c2 === "*") { bc = true; i++; continue; }
      if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
      if (c === "[") depth++;
      else if (c === "]") { depth--; if (depth === 0) { i++; break; } }
    }
    let body = src.slice(m.index + m[0].length - 1, i).replace(/\] as const;/g, "];");
    let abi;
    try { abi = JSON.parse(body); }
    catch (e) {
      try {
        // eslint-disable-next-line no-new-func
        abi = Function(`"use strict"; return (${body});`)();
      } catch { abi = []; }
    }
    if (Array.isArray(abi)) {
      out[name] = {
        functions: abi.filter((e) => e.type === "function").map((e) => `${e.name}(${(e.inputs||[]).map((i) => i.type).join(",")})`).sort(),
        events: abi.filter((e) => e.type === "event").map((e) => `${e.name}(${(e.inputs||[]).map((i) => i.type).join(",")})`).sort(),
        errors: abi.filter((e) => e.type === "error").map((e) => e.name).sort(),
      };
    }
  }
  return out;
}

async function diffContractsTs() {
  const fix = await tryRead(resolve(repoRoot, "lib", fixtureSlug, "contracts.ts"));
  const eng = await tryRead(resolve(repoRoot, "lib", engineSlug, "contracts.ts"));
  if (!fix || !eng) return { file: "contracts.ts", missing: !fix ? "fixture" : "engine" };

  const fAddrs = extractAddresses(fix) || {};
  const eAddrs = extractAddresses(eng) || {};
  const addrDiff = setDiff(Object.keys(fAddrs), Object.keys(eAddrs));
  const valueMismatches = addrDiff.shared.filter((k) => fAddrs[k] !== eAddrs[k]);

  const fAbis = extractAbiSigCounts(fix);
  const eAbis = extractAbiSigCounts(eng);
  const abiDiff = setDiff(Object.keys(fAbis), Object.keys(eAbis));

  let totalSigs = 0, matchedSigs = 0;
  for (const name of abiDiff.shared) {
    const fS = fAbis[name], eS = eAbis[name];
    const fnD = setDiff(fS.functions, eS.functions);
    const evD = setDiff(fS.events, eS.events);
    const erD = setDiff(fS.errors, eS.errors);
    totalSigs += fS.functions.length + fS.events.length + fS.errors.length;
    matchedSigs += fnD.shared.length + evD.shared.length + erD.shared.length;
  }

  const sizeDelta = eng.length - fix.length;
  const sim = similarity(matchedSigs + addrDiff.shared.length, totalSigs + Object.keys(fAddrs).length);

  return {
    file: "contracts.ts",
    fixtureBytes: fix.length,
    engineBytes: eng.length,
    sizeDelta,
    similarity: sim,
    addressDiff: { shared: addrDiff.shared.length, only_in_fixture: addrDiff.only_in_fixture, only_in_engine: addrDiff.only_in_engine, valueMismatches },
    abiDiff: { shared: abiDiff.shared.length, only_in_fixture: abiDiff.only_in_fixture, only_in_engine: abiDiff.only_in_engine },
    sigStats: { totalShared: matchedSigs, totalAcrossSharedAbis: totalSigs },
  };
}

// ─── events.ts ─────────────────────────────────────────────────
function extractEventSigs(src) {
  // Both fixture (pinned values + lazy-computed) and engine (single-shot) emit
  // EVENT_SIGS as Record<EventName, hex>. Extract via regex.
  const out = {};
  // Fixture's _PINNED block + the EVENT_SIGS = (() => {})() builder. Pull all entries.
  // Engine's "export const EVENT_SIGS: Record<EventName, ...> = { Name: '0x...', ... }".
  const re = /['"]?(\w+)['"]?\s*:\s*['"`](0x[0-9a-fA-F]{64})['"`]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const k = m[1];
    if (k.length > 1 && /^[A-Z]/.test(k)) {
      // Skip duplicates (fixture has both _PINNED + computed)
      if (!out[k]) out[k] = m[2].toLowerCase();
    }
  }
  return out;
}

async function diffEventsTs() {
  const fix = await tryRead(resolve(repoRoot, "lib", fixtureSlug, "events.ts"));
  const eng = await tryRead(resolve(repoRoot, "lib", engineSlug, "events.ts"));
  if (!fix || !eng) return { file: "events.ts", missing: !fix ? "fixture" : "engine" };

  const fSigs = extractEventSigs(fix);
  const eSigs = extractEventSigs(eng);
  const diff = setDiff(Object.keys(fSigs), Object.keys(eSigs));
  const valueMismatches = diff.shared.filter((k) => fSigs[k] && eSigs[k] && fSigs[k] !== eSigs[k]);
  const matchedHashes = diff.shared.filter((k) => fSigs[k] === eSigs[k]).length;

  return {
    file: "events.ts",
    fixtureBytes: fix.length,
    engineBytes: eng.length,
    sizeDelta: eng.length - fix.length,
    similarity: similarity(matchedHashes, Object.keys(fSigs).length),
    eventDiff: { shared: diff.shared.length, only_in_fixture: diff.only_in_fixture, only_in_engine: diff.only_in_engine },
    hashesMatched: matchedHashes,
    hashMismatches: valueMismatches,
  };
}

// ─── rules.ts ─────────────────────────────────────────────────
function countRules(src) {
  // Fixture uses TS object literal style with UNQUOTED keys:
  //   { id: "V15.createJob.rewardZero", fn: "createJob", ... }
  // Engine uses JSON.stringify (QUOTED keys):
  //   { "id": "JobNFT.createJob.reviewGateBlocked", "fn": "createJob", ... }
  // Match either style: optional outer quotes around the key name.
  const KEY_RE = (key) => new RegExp(`['"]?${key}['"]?\\s*:\\s*['"]([^'"]+)['"]`, "g");
  const ids = [...src.matchAll(KEY_RE("id"))].map((m) => m[1]);
  const fns = [...src.matchAll(KEY_RE("fn"))].map((m) => m[1]);
  const errors = [...src.matchAll(KEY_RE("errorName"))].map((m) => m[1]);
  return {
    count: ids.length,
    ids,
    fns: [...new Set(fns)].sort(),
    errors: [...new Set(errors)].sort(),
  };
}

async function diffRulesTs() {
  const fix = await tryRead(resolve(repoRoot, "lib", fixtureSlug, "rules.ts"));
  const eng = await tryRead(resolve(repoRoot, "lib", engineSlug, "rules.ts"));
  if (!fix || !eng) return { file: "rules.ts", missing: !fix ? "fixture" : "engine" };

  const f = countRules(fix);
  const e = countRules(eng);
  const fnDiff = setDiff(f.fns, e.fns);
  const errDiff = setDiff(f.errors, e.errors);

  return {
    file: "rules.ts",
    fixtureBytes: fix.length,
    engineBytes: eng.length,
    sizeDelta: eng.length - fix.length,
    similarity: similarity(fnDiff.shared.length + errDiff.shared.length, f.fns.length + f.errors.length),
    fixtureRuleCount: f.count,
    engineRuleCount: e.count,
    fnDiff: { shared: fnDiff.shared.length, only_in_fixture: fnDiff.only_in_fixture, only_in_engine: fnDiff.only_in_engine },
    errorDiff: { shared: errDiff.shared.length, only_in_fixture: errDiff.only_in_fixture.slice(0, 20), only_in_engine: errDiff.only_in_engine.slice(0, 20) },
  };
}

// ─── matrix.ts ─────────────────────────────────────────────────
function extractAxisNames(src) {
  // Two distinct shapes to handle:
  //
  // Engine emit (JSON.stringify): `export const AXES = [{ "name": "val-mode", ... }, ...]`
  //   → extract from `name: "..."` entries inside an array
  //
  // Fixture emit (TS object literal): `export const AXES = { valMode: [...], deadline: [...], ... }`
  //   → axis names are the OBJECT KEYS at the top level of the AXES object
  //
  // Sniff which shape we're looking at by whether the AXES expression starts
  // with `[` (array) or `{` (object).
  const axesArrMatch = src.match(/AXES[^=]*=\s*(\[[\s\S]*?\])\s*(?:as const)?\s*;/);
  if (axesArrMatch) {
    // Array of objects with `name:` field — engine style
    return [...axesArrMatch[1].matchAll(/['"]?name['"]?\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  }
  const axesObjMatch = src.match(/AXES[^=]*=\s*(\{[\s\S]*?\})\s*(?:as const)?\s*;/);
  if (axesObjMatch) {
    // Object literal — keys at depth 1 are the axis names. Track brace depth
    // to ignore keys inside nested values.
    const body = axesObjMatch[1];
    const out = [];
    let depth = 0, i = 0, inStr = false, strCh = null, lc = false, bc = false;
    while (i < body.length) {
      const c = body[i], c2 = body[i + 1] || "";
      if (lc) { if (c === "\n") lc = false; i++; continue; }
      if (bc) { if (c === "*" && c2 === "/") { bc = false; i++; } i++; continue; }
      if (inStr) { if (c === "\\") { i += 2; continue; } if (c === strCh) { inStr = false; strCh = null; } i++; continue; }
      if (c === "/" && c2 === "/") { lc = true; i += 2; continue; }
      if (c === "/" && c2 === "*") { bc = true; i += 2; continue; }
      if (c === '"' || c === "'") { inStr = true; strCh = c; i++; continue; }
      if (c === "{") { depth++; i++; continue; }
      if (c === "}") { depth--; i++; continue; }
      if (c === "[") { depth++; i++; continue; }
      if (c === "]") { depth--; i++; continue; }
      // At depth 1, look for an unquoted identifier followed by `:`
      if (depth === 1) {
        const m = body.slice(i).match(/^([A-Za-z_$][\w$]*)\s*:/);
        if (m) {
          out.push(m[1]);
          i += m[0].length;
          continue;
        }
      }
      i++;
    }
    return out;
  }
  return [];
}

async function diffMatrixTs() {
  const fix = await tryRead(resolve(repoRoot, "lib", fixtureSlug, "matrix.ts"));
  const eng = await tryRead(resolve(repoRoot, "lib", engineSlug, "matrix.ts"));
  if (!fix || !eng) return { file: "matrix.ts", missing: !fix ? "fixture" : "engine" };

  // Fixture's matrix.ts uses `AXES = { valMode: ..., deadline: ..., ... }` (object),
  // engine uses `AXES = [{name: 'val-mode', ...}, ...]` (array). Both contain axis name strings.
  const fAxes = extractAxisNames(fix);
  const eAxes = extractAxisNames(eng);
  // Normalize axis name shapes (camelCase vs kebab-case)
  const norm = (s) => s.toLowerCase().replace(/-/g, "");
  const fNorm = fAxes.map(norm);
  const eNorm = eAxes.map(norm);
  const overlap = fNorm.filter((n) => eNorm.includes(n)).length;

  // Total config count
  const fCount = (fix.match(/CONFIG_COUNT[^=]*=\s*(\d+)/) || [])[1] || (fix.match(/ALL_CONFIGS[^=]*=\s*\[([\s\S]*?)\]/) || ["", ""])[1].split(",").length;
  const eCount = (eng.match(/CONFIG_COUNT[^=]*=\s*(\d+)/) || [])[1] || "?";

  return {
    file: "matrix.ts",
    fixtureBytes: fix.length,
    engineBytes: eng.length,
    sizeDelta: eng.length - fix.length,
    similarity: similarity(overlap, fAxes.length || 1),
    fixtureAxes: fAxes,
    engineAxes: eAxes,
    fixtureConfigCount: fCount,
    engineConfigCount: eCount,
  };
}

// ─── scenarios.ts ─────────────────────────────────────────────────
function extractScenarioIds(src) {
  // Match both unquoted-key (fixture: `id: "s01-..."`) and quoted-key
  // (engine: `"id": "s01-..."`) styles.
  return [...src.matchAll(/['"]?id['"]?\s*:\s*['"]([sS]\d+[-\w]*)['"]/g)].map((m) => m[1]);
}

async function diffScenariosTs() {
  const fix = await tryRead(resolve(repoRoot, "lib", fixtureSlug, "scenarios.ts"));
  const eng = await tryRead(resolve(repoRoot, "lib", engineSlug, "scenarios.ts"));
  if (!fix || !eng) return { file: "scenarios.ts", missing: !fix ? "fixture" : "engine" };

  const fIds = extractScenarioIds(fix);
  const eIds = extractScenarioIds(eng);
  const diff = setDiff(fIds, eIds);

  return {
    file: "scenarios.ts",
    fixtureBytes: fix.length,
    engineBytes: eng.length,
    sizeDelta: eng.length - fix.length,
    similarity: similarity(diff.shared.length, fIds.length || 1),
    fixtureCount: fIds.length,
    engineCount: eIds.length,
    only_in_fixture: diff.only_in_fixture,
    only_in_engine: diff.only_in_engine,
  };
}

// ─── cell-defs.ts ─────────────────────────────────────────────────
function extractPredicateKeys(src) {
  // Both fixture and engine have PREDICATES = { 's01-...': ..., 's05-...': ... }
  const m = src.match(/PREDICATES[^=]*=\s*\{([\s\S]*?)\};/);
  if (!m) return [];
  return [...m[1].matchAll(/['"]([sS]\d+[-\w]*)['"]\s*:/g)].map((mm) => mm[1]);
}

async function diffCellDefsTs() {
  const fix = await tryRead(resolve(repoRoot, "lib", fixtureSlug, "cell-defs.ts"));
  const eng = await tryRead(resolve(repoRoot, "lib", engineSlug, "cell-defs.ts"));
  if (!fix || !eng) return { file: "cell-defs.ts", missing: !fix ? "fixture" : "engine" };

  const fK = extractPredicateKeys(fix);
  const eK = extractPredicateKeys(eng);
  const diff = setDiff(fK, eK);

  return {
    file: "cell-defs.ts",
    fixtureBytes: fix.length,
    engineBytes: eng.length,
    sizeDelta: eng.length - fix.length,
    similarity: similarity(diff.shared.length, fK.length || 1),
    fixtureKeys: fK,
    engineKeys: eK,
    only_in_fixture: diff.only_in_fixture,
    only_in_engine: diff.only_in_engine,
  };
}

// ─── state-machine.ts ─────────────────────────────────────────────
async function diffStateMachineTs() {
  const fix = await tryRead(resolve(repoRoot, "lib", fixtureSlug, "state-machine.ts"));
  const eng = await tryRead(resolve(repoRoot, "lib", engineSlug, "state-machine.ts"));
  if (!fix || !eng) return { file: "state-machine.ts", missing: !fix ? "fixture" : "engine" };

  const fSyms = [...fix.matchAll(/export\s+(?:const|function|type|interface)\s+(\w+)/g)].map((m) => m[1]);
  const eSyms = [...eng.matchAll(/export\s+(?:const|function|type|interface)\s+(\w+)/g)].map((m) => m[1]);
  const diff = setDiff(fSyms, eSyms);

  return {
    file: "state-machine.ts",
    fixtureBytes: fix.length,
    engineBytes: eng.length,
    sizeDelta: eng.length - fix.length,
    similarity: similarity(diff.shared.length, fSyms.length || 1),
    only_in_fixture: diff.only_in_fixture,
    only_in_engine: diff.only_in_engine,
    note: "engine emits a stub state-machine; full equivalence not expected at Phase B v1",
  };
}

// ─── Run all diffs ─────────────────────────────────────────────
const reports = {};
reports["contracts.ts"]    = await diffContractsTs();
reports["events.ts"]       = await diffEventsTs();
reports["rules.ts"]        = await diffRulesTs();
reports["matrix.ts"]       = await diffMatrixTs();
reports["scenarios.ts"]    = await diffScenariosTs();
reports["cell-defs.ts"]    = await diffCellDefsTs();
reports["state-machine.ts"] = await diffStateMachineTs();

console.log("──── Per-file similarity ────");
console.log("");
const summaryLines = [];
for (const [file, r] of Object.entries(reports)) {
  if (r.missing) {
    console.log(`  ${file.padEnd(20)} MISSING (${r.missing} side absent)`);
    summaryLines.push({ file, sim: 0, missing: r.missing });
    continue;
  }
  console.log(`  ${file.padEnd(20)} similarity=${String(r.similarity).padStart(3)}%  size: ${r.fixtureBytes}→${r.engineBytes} (Δ${r.sizeDelta >= 0 ? "+" : ""}${r.sizeDelta})`);
  summaryLines.push({ file, sim: r.similarity, fbytes: r.fixtureBytes, ebytes: r.engineBytes });
}

console.log("\n──── Detailed report ────\n");
for (const [file, r] of Object.entries(reports)) {
  if (r.missing) continue;
  console.log(`▶ ${file}`);
  console.log(`  similarity: ${r.similarity}%`);
  if (file === "contracts.ts") {
    console.log(`  addresses shared: ${r.addressDiff.shared} | only-fixture: ${r.addressDiff.only_in_fixture.join(",") || "(none)"} | only-engine: ${r.addressDiff.only_in_engine.join(",") || "(none)"}`);
    console.log(`  ABI exports shared: ${r.abiDiff.shared} | sigs shared: ${r.sigStats.totalShared}/${r.sigStats.totalAcrossSharedAbis}`);
    if (r.abiDiff.only_in_fixture.length) console.log(`  ABI only in fixture: ${r.abiDiff.only_in_fixture.join(", ")}`);
    if (r.abiDiff.only_in_engine.length)  console.log(`  ABI only in engine:  ${r.abiDiff.only_in_engine.join(", ")}`);
  }
  if (file === "events.ts") {
    console.log(`  event names shared: ${r.eventDiff.shared} | only-fixture: ${r.eventDiff.only_in_fixture.length} | only-engine: ${r.eventDiff.only_in_engine.length}`);
    console.log(`  topic0 hashes matched (byte-for-byte): ${r.hashesMatched}`);
    if (r.hashMismatches.length) console.log(`  hash mismatches: ${r.hashMismatches.join(", ")}`);
  }
  if (file === "rules.ts") {
    console.log(`  rule count: fixture=${r.fixtureRuleCount}, engine=${r.engineRuleCount}`);
    console.log(`  fns shared: ${r.fnDiff.shared} | only-fixture: ${r.fnDiff.only_in_fixture.length} | only-engine: ${r.fnDiff.only_in_engine.length}`);
    console.log(`  errorNames shared: ${r.errorDiff.shared} | only-fixture sample: ${r.errorDiff.only_in_fixture.slice(0, 5).join(",") || "(none)"}`);
  }
  if (file === "matrix.ts") {
    console.log(`  axes: fixture=${r.fixtureAxes.length} (${r.fixtureAxes.join(",")}), engine=${r.engineAxes.length} (${r.engineAxes.join(",")})`);
    console.log(`  config counts: fixture=${r.fixtureConfigCount}, engine=${r.engineConfigCount}`);
  }
  if (file === "scenarios.ts") {
    console.log(`  scenario count: fixture=${r.fixtureCount}, engine=${r.engineCount}`);
    if (r.only_in_fixture.length) console.log(`  only in fixture: ${r.only_in_fixture.join(", ")}`);
    if (r.only_in_engine.length)  console.log(`  only in engine:  ${r.only_in_engine.join(", ")}`);
  }
  if (file === "cell-defs.ts") {
    console.log(`  predicates: fixture=${r.fixtureKeys.length}, engine=${r.engineKeys.length}`);
    if (r.only_in_fixture.length) console.log(`  only in fixture: ${r.only_in_fixture.join(", ")}`);
    if (r.only_in_engine.length)  console.log(`  only in engine:  ${r.only_in_engine.join(", ")}`);
  }
  if (file === "state-machine.ts") {
    console.log(`  ${r.note}`);
    if (r.only_in_fixture.length) console.log(`  symbols only in fixture: ${r.only_in_fixture.slice(0, 8).join(", ")}${r.only_in_fixture.length > 8 ? ` (+${r.only_in_fixture.length - 8} more)` : ""}`);
  }
  console.log("");
}

console.log("──── Summary table ────");
const avg = Math.round(summaryLines.filter((s) => !s.missing).reduce((a, s) => a + s.sim, 0) / Math.max(1, summaryLines.filter((s) => !s.missing).length));
console.log(`Average similarity across ${summaryLines.filter((s) => !s.missing).length} files: ${avg}%`);
process.exit(0);
