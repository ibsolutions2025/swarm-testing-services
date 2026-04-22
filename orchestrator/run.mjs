#!/usr/bin/env node
import { requireEnv, env } from "./env.mjs";
import { claimNextQueued, setStatus, saveMatrix, savePersona, saveRun } from "./db.mjs";
import { designMatrix } from "./matrix-designer.mjs";
import { generatePersona } from "./persona-generator.mjs";
import { dispatchCampaign } from "./dispatcher.mjs";

requireEnv();

const ONCE = process.argv.includes("--once");

async function processCampaign(campaign) {
  const { id: campaignId, url, description } = campaign;
  console.log(`[orchestrator] ▶ campaign ${campaignId}`);

  // 1. Matrix
  await setStatus(campaignId, "designing");
  const { rows, columns } = await designMatrix({ url, description });
  await saveMatrix(campaignId, rows, columns);
  console.log(`[orchestrator]   matrix: ${rows.length} rows × ${columns.length} cols`);

  // 2. Personas
  await setStatus(campaignId, "generating_personas");
  const personasByRowId = {};
  for (const row of rows) {
    try {
      const persona = await generatePersona({ url, description, row });
      const personaId = await savePersona(campaignId, row, persona);
      personasByRowId[row.id] = { ...persona, db_id: personaId };
      console.log(`[orchestrator]   persona: ${persona.name} (${row.label})`);
    } catch (err) {
      console.error(
        `[orchestrator]   persona gen failed for row ${row.id}:`,
        err.message
      );
      personasByRowId[row.id] = fallbackPersona(row);
    }
  }

  // 3. Dispatch
  await setStatus(campaignId, "running");
  await dispatchCampaign({
    url,
    description,
    rows,
    columns,
    personasByRowId,
    onCell: async ({ row, col, persona, result }) => {
      await saveRun(campaignId, row, col, persona.db_id ?? null, result);
      console.log(
        `[orchestrator]   run ${row.id}×${col.id} → ${result.outcome}`
      );
    }
  });

  await setStatus(campaignId, "completed");
  console.log(`[orchestrator] ✓ campaign ${campaignId} completed`);
}

function fallbackPersona(row) {
  return {
    name: `Generic user — ${row.label}`,
    archetype: "generic",
    goals: ["Complete the task"],
    biases: [],
    soul_md:
      "I'm trying to get something done with this product. I have no strong opinions going in; I'll react to what I see.",
    db_id: null
  };
}

async function tick() {
  const campaign = await claimNextQueued();
  if (!campaign) return false;
  try {
    await processCampaign(campaign);
  } catch (err) {
    console.error(
      `[orchestrator] ✗ campaign ${campaign.id} failed:`,
      err.message
    );
    await setStatus(campaign.id, "failed", err.message ?? String(err));
  }
  return true;
}

async function loop() {
  console.log(
    `[orchestrator] started (poll=${env.POLL_INTERVAL_MS}ms, concurrency=${env.MAX_CONCURRENT_RUNS})`
  );
  // process SIGINT cleanly
  let stopping = false;
  process.on("SIGINT", () => {
    console.log("[orchestrator] SIGINT — finishing current campaign then exiting");
    stopping = true;
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const didWork = await tick();
    if (ONCE) return;
    if (stopping) return;
    if (!didWork) {
      await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_MS));
    }
  }
}

loop().catch((err) => {
  console.error("[orchestrator] fatal:", err);
  process.exit(1);
});
