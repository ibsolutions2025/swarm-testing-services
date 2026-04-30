#!/usr/bin/env node
/**
 * matrix-steering.mjs — generate target-gaps.json for HLO daemon (Phase G).
 *
 * Reads lifecycle_results passed counts per cell, computes the canonical
 * cell space (ALL_CONFIGS × CLASSIFIABLE_SCENARIO_IDS, applicability-filtered),
 * and writes:
 *
 *   1. /root/test-swarm/target-gaps.json  (file artifact for ops/HLO local read)
 *   2. system_heartbeats row with component=matrix-steering and the same JSON
 *      in meta — so HLO (running on Windows pm2, separate host) can pull the
 *      latest gaps via Supabase without needing the file.
 *
 * Pure read: no on-chain calls, no LLM calls. ~$0/run.
 *
 * Invocation:
 *   /usr/bin/node /root/test-swarm/matrix-steering.mjs
 *
 * Cron (VPS):
 *   *\/15 * * * * . /root/.awp-env; /usr/bin/node /root/test-swarm/matrix-steering.mjs
 *     >> /var/log/awp-steering.log 2>&1
 *
 * Env:
 *   STS_SUPABASE_URL, STS_SUPABASE_KEY  (service-role)
 *   STEERING_OUT_PATH       Override output path (default: /root/test-swarm/target-gaps.json)
 *   STEERING_TARGET_PER_CELL  Coverage target per cell (default: 1)
 *   STEERING_TOP_LIMIT      Max under-covered cells in output (default: 200)
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve lib/awp/index.js relative to this script's directory. On VPS the
// script lives at /root/test-swarm/matrix-steering.mjs and the lib is at
// /root/test-swarm/lib/awp/index.js — same layout as in-repo.
const awpLibPath = resolve(__dirname, 'lib', 'awp', 'index.js');
const awp = await import(awpLibPath);
const { ALL_CONFIGS, CLASSIFIABLE_SCENARIO_IDS, parseConfigKey, isCellApplicable } = awp;

const STS_URL = process.env.STS_SUPABASE_URL || 'https://ldxcenmhazelrnrlxuwq.supabase.co';
const STS_KEY = process.env.STS_SUPABASE_KEY;
const OUT_PATH = process.env.STEERING_OUT_PATH || '/root/test-swarm/target-gaps.json';
const TARGET_PER_CELL = Number(process.env.STEERING_TARGET_PER_CELL || 1);
const TOP_LIMIT = Number(process.env.STEERING_TOP_LIMIT || 200);

if (!STS_KEY) {
  console.error('[steering] STS_SUPABASE_KEY required — aborting');
  process.exit(2);
}

async function fetchPassedRows() {
  // Page through lifecycle_results — Supabase REST caps at 1000/req without a
  // higher Range header. We pull up to 5000; raise if cell coverage outgrows.
  const all = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const r = await fetch(
      `${STS_URL}/rest/v1/lifecycle_results?project_id=eq.awp&status=eq.passed` +
      `&select=config_key,scenario_key&limit=1000&offset=${offset}`,
      { headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` } },
    );
    if (!r.ok) {
      throw new Error(`lifecycle_results fetch ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const rows = await r.json();
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

async function emitHeartbeat(payload) {
  const r = await fetch(`${STS_URL}/rest/v1/system_heartbeats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: STS_KEY,
      Authorization: `Bearer ${STS_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      project_id: 'awp',
      component: 'matrix-steering',
      outcome: 'ok',
      actions_count: payload.underCoveredCells.length,
      note: `coverage=${payload.coveragePct}% gaps=${payload.underCoveredCells.length}/${payload.totalCells}`,
      meta: payload,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.warn(`[steering] heartbeat write ${r.status}: ${txt.slice(0, 240)}`);
  }
}

async function main() {
  const t0 = Date.now();

  // 1. Pull passed rows from Supabase
  const rows = await fetchPassedRows();
  const passedCounts = new Map();
  for (const row of rows) {
    if (!row.config_key || !row.scenario_key) continue;
    const k = `${row.config_key}|${row.scenario_key}`;
    passedCounts.set(k, (passedCounts.get(k) || 0) + 1);
  }

  // 2. Build canonical cell space (applicable cells only)
  const allCells = [];
  for (const cfg of ALL_CONFIGS) {
    let params;
    try { params = parseConfigKey(cfg); } catch { continue; }
    for (const sid of CLASSIFIABLE_SCENARIO_IDS) {
      if (!isCellApplicable(params, sid)) continue;
      const k = `${cfg}|${sid}`;
      allCells.push({
        config_key: cfg,
        scenario_id: sid,
        passedCount: passedCounts.get(k) || 0,
      });
    }
  }

  // 3. Filter under-covered, sort by lowest passedCount, cap at TOP_LIMIT
  const underCovered = allCells
    .filter(c => c.passedCount < TARGET_PER_CELL)
    .sort((a, b) => a.passedCount - b.passedCount)
    .slice(0, TOP_LIMIT);

  const passedCells = allCells.filter(c => c.passedCount >= TARGET_PER_CELL).length;
  const coveragePct = allCells.length === 0 ? 0
    : Number(((passedCells / allCells.length) * 100).toFixed(2));

  const payload = {
    generatedAt: new Date().toISOString(),
    targetPerCell: TARGET_PER_CELL,
    underCoveredCells: underCovered,
    totalCells: allCells.length,
    passedCells,
    coveragePct,
    durationMs: Date.now() - t0,
  };

  // 4. Write file artifact
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');

  // 5. Mirror to Supabase heartbeat for cross-host consumption (HLO is on
  // Windows; it pulls from Supabase rather than scp'ing the file).
  await emitHeartbeat(payload);

  console.log(
    `[steering] ${payload.coveragePct}% coverage ` +
    `(${payload.passedCells}/${payload.totalCells} cells passed) ` +
    `gaps=${payload.underCoveredCells.length} ` +
    `wrote=${OUT_PATH} ` +
    `ms=${payload.durationMs}`,
  );
  if (payload.underCoveredCells.length > 0) {
    console.log(
      `[steering] top under-covered: ` +
      payload.underCoveredCells.slice(0, 5).map(c =>
        `${c.config_key}|${c.scenario_id}(passed=${c.passedCount})`).join(' '),
    );
  }
}

main().catch(e => {
  console.error(`[steering] FATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
