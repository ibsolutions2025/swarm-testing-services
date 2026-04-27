#!/usr/bin/env node
/**
 * framework/onboarding/engine.mjs — STS Onboarding Engine.
 *
 * Given ONLY a URL, discovers the protocol's contracts, ABIs, docs, MCP
 * server, state machine, and matrix axes via mechanical crawling + LLM
 * extraction. Output: lib/<slug>/* + clients/<slug>/AUDIT-AND-DESIGN.md.
 *
 * The engine has ZERO pre-knowledge of any specific protocol. All knowledge
 * is derived per-run from the URL. See clients/awp/SWARM-V2-DESIGN.md
 * sections 3-5 for the architectural rationale.
 *
 * Phase B Batch 1 covers steps 01-04 only (URL validation through ABI
 * fetch). Subsequent steps land in Batch 2.
 *
 * Usage:
 *   node framework/onboarding/engine.mjs <url> [--run-id <id>] [--from <step>] [--out-dir <path>]
 *
 *   --run-id     reuse a prior run-dir for resume (default: timestamp-based)
 *   --from       start at step N (1-12) instead of step 01 (resume mode)
 *   --out-dir    where to emit lib/<slug>/* + clients/<slug>/* (default:
 *                  runs/<runId>/output/ — per-run scratch dir for Phase C
 *                  multi-tenant isolation; greenlight copies into canonical
 *                  lib/<slug>-<user_short>/ at cutover)
 *
 * State persistence: framework/onboarding/runs/<runId>/state.json carries
 * the cumulative ctx between steps. Each step records its output verbatim.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as step01 from "./steps/01-validate-url.mjs";
import * as step02 from "./steps/02-discover-manifest.mjs";
import * as step03 from "./steps/03-inventory-contracts.mjs";
import * as step04 from "./steps/04-fetch-abis.mjs";
import * as step05 from "./steps/05-crawl-docs.mjs";
import * as step06 from "./steps/06-audit-mcp.mjs";
import * as step07 from "./steps/07-generate-rules.mjs";
import * as step08 from "./steps/08-generate-events.mjs";
import * as step09 from "./steps/09-derive-matrix.mjs";
import * as step10 from "./steps/10-derive-scenarios.mjs";
import * as step11 from "./steps/11-generate-cell-defs.mjs";
import * as step12 from "./steps/12-write-audit-doc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// Step registry — ordered per design 3.1. Step order: 1-4 mechanical
// discovery, 5-6 doc/MCP audits, 7-11 LLM-driven extraction, 12 synthesis.
const STEPS = [
  { id: "01-validate-url",         run: step01.run },
  { id: "02-discover-manifest",    run: step02.run },
  { id: "03-inventory-contracts",  run: step03.run },
  { id: "04-fetch-abis",           run: step04.run },
  { id: "05-crawl-docs",           run: step05.run },
  { id: "06-audit-mcp",            run: step06.run },
  { id: "07-generate-rules",       run: step07.run },
  { id: "08-generate-events",      run: step08.run },
  { id: "09-derive-matrix",        run: step09.run },
  { id: "10-derive-scenarios",     run: step10.run },
  { id: "11-generate-cell-defs",   run: step11.run },
  { id: "12-write-audit-doc",      run: step12.run },
];

function argVal(flag, def) {
  const i = process.argv.indexOf(flag);
  return (i >= 0 && i + 1 < process.argv.length) ? process.argv[i + 1] : def;
}

function generateRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function readStateIfExists(stateFile) {
  if (!existsSync(stateFile)) return null;
  try {
    const txt = await readFile(stateFile, "utf8");
    return JSON.parse(txt);
  } catch (e) {
    console.error(`[engine] could not read prior state at ${stateFile}: ${e.message}`);
    return null;
  }
}

async function writeState(stateFile, ctx) {
  // Strip any large blobs from steps if they ever get added (right now
  // step 04 stores ABIs in memory only — they're written to lib/<slug>/contracts.ts
  // but not into ctx.steps to keep state.json readable).
  await writeFile(stateFile, JSON.stringify(ctx, null, 2), "utf8");
}

async function main() {
  const url = process.argv[2];
  if (!url || url.startsWith("--")) {
    console.error("usage: node framework/onboarding/engine.mjs <url> [--run-id <id>] [--from <stepId>] [--out-dir <path>]");
    process.exit(2);
  }

  const runId = argVal("--run-id", generateRunId());
  const startStep = argVal("--from", null);
  const runDir = join(__dirname, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const stateFile = join(runDir, "state.json");

  // Phase C: outDir defaults to runs/<runId>/output/ so engine never writes
  // to global lib/<slug>/. Greenlight (C.7) copies into canonical location.
  const outDirArg = argVal("--out-dir", null);
  const outDir = outDirArg ? resolve(outDirArg) : join(runDir, "output");
  await mkdir(outDir, { recursive: true });

  // Initial ctx — engine input + repo root + empty steps map. Resume mode
  // hydrates from existing state.json.
  const prior = await readStateIfExists(stateFile);
  const ctx = prior || {
    runId,
    runDir,
    repoRoot: REPO_ROOT,
    outDir,
    input: { url },
    startedAt: new Date().toISOString(),
    steps: {},
  };
  ctx.input = ctx.input || { url };
  ctx.input.url = url; // allow URL override on re-run
  ctx.repoRoot = REPO_ROOT;
  ctx.outDir = outDir; // always honor latest --out-dir (or default)
  ctx.steps = ctx.steps || {};

  console.log(`=== STS Onboarding Engine ===`);
  console.log(`URL:      ${url}`);
  console.log(`Run dir:  ${runDir}`);
  console.log(`Out dir:  ${outDir}`);
  console.log(`Steps:    ${STEPS.length} (Phase B Batch 1: 01-04)`);
  if (startStep) console.log(`Start at: ${startStep} (resume)`);
  console.log("");

  const seenStart = !startStep;
  let resumeReached = seenStart;
  for (const step of STEPS) {
    if (!resumeReached) {
      if (step.id === startStep) resumeReached = true;
      else { console.log(`[skip ] ${step.id}  (resume — using cached output from prior run)`); continue; }
    }

    const t0 = Date.now();
    process.stdout.write(`[ run ] ${step.id} ...`);
    let result;
    try {
      result = await step.run(ctx);
    } catch (e) {
      console.log(` ERR (${e.message?.slice(0, 200)})`);
      ctx.steps[step.id] = { ok: false, error: e.message, stack: e.stack?.slice(0, 1000), elapsedMs: Date.now() - t0 };
      await writeState(stateFile, ctx);
      console.error(`\nFATAL: step ${step.id} threw — engine halted. State written to ${stateFile}`);
      process.exit(1);
    }
    const elapsed = Date.now() - t0;
    if (!result.ok) {
      console.log(` FAIL (${elapsed} ms) — ${result.error || "no error msg"}`);
      ctx.steps[step.id] = { ok: false, error: result.error, output: result.output || null, elapsedMs: elapsed };
      await writeState(stateFile, ctx);
      console.error(`\nFATAL: step ${step.id} failed. State written to ${stateFile}`);
      process.exit(1);
    }
    console.log(` ok (${elapsed} ms)`);
    ctx.steps[step.id] = { ok: true, output: result.output, elapsedMs: elapsed };
    await writeState(stateFile, ctx);

    // Per-step inline summary so the operator sees progress in the terminal
    if (step.id === "01-validate-url") {
      console.log(`        → ${result.output.status} ${result.output.contentType.split(";")[0]} (${result.output.bodyLength} bytes)`);
    } else if (step.id === "02-discover-manifest") {
      console.log(`        → ${result.output.manifestUrl}`);
      console.log(`        → name="${result.output.rawName}" → slug="${result.output.slug}" schema=${result.output.schemaVersion || "?"}`);
    } else if (step.id === "03-inventory-contracts") {
      console.log(`        → ${result.output.total} contracts on chain ${result.output.chain.id} (${result.output.chain.name})`);
      console.log(`        → ${result.output.withManifestAbiUrl}/${result.output.total} have manifest abi_endpoints`);
    } else if (step.id === "04-fetch-abis") {
      console.log(`        → wrote ${result.output.contractsTsPath}`);
      console.log(`        → ${result.output.counts.fetched_ok}/${result.output.counts.total} ABIs fetched (sources: ${JSON.stringify(result.output.counts.by_source)})`);
      const failed = result.output.fetchResults.filter((r) => !r.ok);
      if (failed.length) {
        console.log(`        ⚠ ${failed.length} failed:`);
        for (const f of failed) console.log(`          - ${f.name} (${f.address}): ${f.error?.slice(0, 100)}`);
      }
    }
  }

  ctx.completedAt = new Date().toISOString();
  await writeState(stateFile, ctx);
  console.log(`\n=== DONE — state at ${stateFile} ===`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
