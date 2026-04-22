#!/usr/bin/env node
// Smoke test: does the matrix designer + persona generator + dispatcher
// produce reasonable output end-to-end, without touching Supabase?
//
// Run: OPENROUTER_API_KEY=... node smoke.mjs

import { designMatrix } from "./matrix-designer.mjs";
import { generatePersona } from "./persona-generator.mjs";
import { runCell } from "./dispatcher.mjs";

const fake = {
  url: "https://linear.app",
  description:
    "I want to see if new users can sign up, create their first issue, and invite a teammate within 5 minutes. Focus on clarity of onboarding."
};

async function main() {
  console.log("[smoke] designing matrix…");
  const { rows, columns } = await designMatrix(fake);
  console.log(`[smoke]   ${rows.length} rows × ${columns.length} cols`);

  const row = rows[0];
  const col = columns[0];

  console.log(`[smoke] generating persona for row "${row.label}"…`);
  const persona = await generatePersona({
    url: fake.url,
    description: fake.description,
    row
  });
  console.log(`[smoke]   persona: ${persona.name} (${persona.archetype})`);

  console.log(`[smoke] running cell ${row.id}×${col.id}…`);
  const result = await runCell({
    url: fake.url,
    campaignDescription: fake.description,
    row,
    col,
    persona
  });
  console.log(
    `[smoke]   outcome=${result.outcome} quote=${JSON.stringify(result.quote)}`
  );
  console.log(
    `[smoke]   transcript turns: ${result.transcript?.length ?? 0} (${result.duration_ms}ms)`
  );

  console.log("[smoke] ✓ ok");
}

main().catch((e) => {
  console.error("[smoke] ✗", e);
  process.exit(1);
});
