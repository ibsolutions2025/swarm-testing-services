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

async function fetchRowsByStatus(statusFilter) {
  // Page through lifecycle_results — Supabase REST caps at 1000/req without a
  // higher Range header. We pull up to 10000; raise if cell coverage outgrows.
  // statusFilter: 'eq.passed' or 'in.(running,attempted,failed)' etc.
  const all = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const r = await fetch(
      `${STS_URL}/rest/v1/lifecycle_results?project_id=eq.awp&status=${statusFilter}` +
      `&select=config_key,scenario_key&limit=1000&offset=${offset}`,
      { headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` } },
    );
    if (!r.ok) {
      throw new Error(`lifecycle_results fetch (status=${statusFilter}) ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const rows = await r.json();
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}

// Pull the (intended_config, intended_scenario) pairs from recent HLO
// dispatches. lifecycle_results rows for non-terminal jobs carry a
// `scenario_key` of 's00-in-flight' (scanner placeholder until the job
// reaches terminal status), so they can't tell us the INTENDED cell.
// orchestration_events.meta does — the HLO daemon records intended_config
// and intended_scenario at dispatch time.
//
// Look back STEERING_INFLIGHT_LOOKBACK_HOURS (default 6h) since dispatches
// older than that are very likely to have either completed (and shown up
// in passedRows) or stalled out and the scanner will eventually flag the
// row as something other than `running`. 6h matches the longest reasonable
// drain-to-terminal latency we observe in practice.
async function fetchInFlightDispatches() {
  const lookbackHours = Number(process.env.STEERING_INFLIGHT_LOOKBACK_HOURS || 6);
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const all = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const r = await fetch(
      `${STS_URL}/rest/v1/orchestration_events?project_id=eq.awp` +
      `&source=eq.hlo-daemon&event_type=eq.dispatch&ran_at=gte.${since}` +
      `&select=meta&limit=1000&offset=${offset}`,
      { headers: { apikey: STS_KEY, Authorization: `Bearer ${STS_KEY}` } },
    );
    if (!r.ok) break;
    const rows = await r.json();
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  // Extract verified dispatches (lifecycle=verified) — `requested` rows
  // include attempts that may have failed, and we already pull `failed`
  // separately. Verified ones are the jobs actually on-chain.
  const cells = new Map(); // "cfg|sce" -> count
  for (const row of all) {
    const m = row.meta || {};
    if (m.lifecycle !== 'verified') continue;
    if (!m.intended_config || !m.intended_scenario) continue;
    const k = `${m.intended_config}|${m.intended_scenario}`;
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  return cells;
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
      note: `passed=${payload.coveragePct}% touched=${payload.touchedPct}% gaps=${payload.underCoveredCells.length}/${payload.totalCells}`,
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

  // 1. Pull passed rows + in-flight intent in parallel. Phase I: a cell
  // already targeted by an in-flight job shouldn't be steered toward —
  // duplicate posts just pile work into a busy cell while the long tail
  // of empty cells stays empty.
  //
  // "In-flight" comes from orchestration_events not lifecycle_results
  // because lifecycle rows for non-terminal jobs carry scenario_key=
  // 's00-in-flight' (scanner placeholder). The HLO daemon records the
  // INTENDED (config_key, scenario_id) at dispatch time, and that's what
  // we count toward "this cell is already being worked".
  const [passedRows, inFlightCounts] = await Promise.all([
    fetchRowsByStatus('eq.passed'),
    fetchInFlightDispatches(),
  ]);
  const passedCounts = new Map();
  for (const row of passedRows) {
    if (!row.config_key || !row.scenario_key) continue;
    const k = `${row.config_key}|${row.scenario_key}`;
    passedCounts.set(k, (passedCounts.get(k) || 0) + 1);
  }
  // Prune in-flight counts for cells that have already passed — those
  // jobs reached terminal status; cell is covered, no point flagging it
  // as "still being worked".
  for (const k of passedCounts.keys()) inFlightCounts.delete(k);

  // 2. Build canonical cell space (applicable cells only) with both counts
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
        in_flight_count: inFlightCounts.get(k) || 0,
      });
    }
  }

  // 3. Filter "truly under-covered": no pass yet AND no in-flight job either.
  // The covered universe = passed >= 1 OR in_flight >= 1. Sort by total
  // attention (passedCount + in_flight_count) ascending so cells with zero
  // touches surface first. Cap at TOP_LIMIT.
  const underCovered = allCells
    .filter(c => c.passedCount < TARGET_PER_CELL && c.in_flight_count === 0)
    .sort((a, b) => (a.passedCount + a.in_flight_count) - (b.passedCount + b.in_flight_count))
    .slice(0, TOP_LIMIT);

  const passedCells = allCells.filter(c => c.passedCount >= TARGET_PER_CELL).length;
  const inFlightCells = allCells.filter(c => c.passedCount === 0 && c.in_flight_count > 0).length;
  const coveragePct = allCells.length === 0 ? 0
    : Number(((passedCells / allCells.length) * 100).toFixed(2));
  const touchedPct = allCells.length === 0 ? 0
    : Number((((passedCells + inFlightCells) / allCells.length) * 100).toFixed(2));

  const payload = {
    generatedAt: new Date().toISOString(),
    targetPerCell: TARGET_PER_CELL,
    underCoveredCells: underCovered,
    totalCells: allCells.length,
    passedCells,
    inFlightCells,
    coveragePct,        // % at status=passed
    touchedPct,         // % with passed OR in-flight (drain will terminalize these)
    durationMs: Date.now() - t0,
  };

  // 4. Write file artifact
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');

  // 5. Mirror to Supabase heartbeat for cross-host consumption (HLO is on
  // Windows; it pulls from Supabase rather than scp'ing the file).
  await emitHeartbeat(payload);

  console.log(
    `[steering] passed=${payload.coveragePct}% touched=${payload.touchedPct}% ` +
    `(${payload.passedCells} passed, ${payload.inFlightCells} in-flight, ` +
    `${payload.underCoveredCells.length} truly empty / ${payload.totalCells} total) ` +
    `wrote=${OUT_PATH} ms=${payload.durationMs}`,
  );
  if (payload.underCoveredCells.length > 0) {
    console.log(
      `[steering] top under-covered: ` +
      payload.underCoveredCells.slice(0, 5).map(c =>
        `${c.config_key}|${c.scenario_id}(passed=${c.passedCount},inflight=${c.in_flight_count})`).join(' '),
    );
  }
}

main().catch(e => {
  console.error(`[steering] FATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
