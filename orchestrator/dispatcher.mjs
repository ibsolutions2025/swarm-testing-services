import { chatJson } from "./llm.mjs";
import { env } from "./env.mjs";

/**
 * Execute a single matrix cell. The persona attempts the scenario against
 * the URL; the LLM roleplays the persona in first person and returns an
 * outcome + quote.
 *
 * NOTE: In v1 the persona does NOT actually drive a browser — it simulates
 * a user session based on what the URL says. A v2 upgrade is to wire this
 * up to Playwright or a real browser MCP so the persona can actually
 * interact with the DOM. For MVP this is still useful: it surfaces
 * copy/flow/assumption failures a human reviewer can confirm.
 */
export async function runCell({ url, campaignDescription, row, col, persona }) {
  const started = Date.now();

  const system = `You are roleplaying as a specific user persona attempting a specific task against a product at a URL.

Rules:
- Stay fully in character. First person throughout.
- You cannot actually click things — instead, narrate what you would do step-by-step, and describe what you'd expect to see or what would frustrate you.
- Do NOT invent features that haven't been described to you. Imagine what a typical product at this URL might show.
- At the end, output a JSON object with:
  {
    "outcome": "pass" | "fail" | "partial" | "error",
    "quote": "one sentence in your voice",
    "transcript": [ { "role": "persona" | "observer", "text": "...", "ts": "ISO timestamp" } ]
  }
- "pass" = success criteria met.
- "fail" = hit a blocker you couldn't reasonably work around.
- "partial" = got somewhere, but some criteria weren't met.
- "error" = the product was broken in a way the persona couldn't diagnose.`;

  const userPrompt = `# Persona
Name: ${persona.name}
Archetype: ${persona.archetype}

Goals:
${(persona.goals ?? []).map((g) => `- ${g}`).join("\n") || "- (none specified)"}

Biases:
${(persona.biases ?? []).map((b) => `- ${b}`).join("\n") || "- (none specified)"}

Inner voice:
${persona.soul_md ?? "(none)"}

# The product
URL: ${url}

Buyer's note about what matters most:
${campaignDescription}

# The scenario
${col.label}: ${col.scenario}

Success criteria:
${(col.success_criteria ?? []).map((s) => `- ${s}`).join("\n") || "- (none specified)"}

# Configuration you're simulating
${Object.entries(row.config ?? {})
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n") || "- default"}

Now roleplay the scenario in 3-6 transcript turns, then emit the final JSON.`;

  let parsed;
  try {
    parsed = await chatJson({
      model: env.MODEL_RUN,
      system,
      user: userPrompt,
      maxTokens: 2000
    });
  } catch (err) {
    return {
      outcome: "error",
      quote: null,
      transcript: [
        {
          role: "system",
          text: `orchestrator error: ${err.message}`,
          ts: new Date().toISOString()
        }
      ],
      duration_ms: Date.now() - started
    };
  }

  const outcome = ["pass", "fail", "partial", "error"].includes(parsed.outcome)
    ? parsed.outcome
    : "partial";

  const transcript = Array.isArray(parsed.transcript)
    ? parsed.transcript.slice(0, 20).map((t) => ({
        role: ["persona", "observer", "system"].includes(t.role)
          ? t.role
          : "persona",
        text: String(t.text ?? "").slice(0, 2000),
        ts: t.ts ?? new Date().toISOString()
      }))
    : [];

  return {
    outcome,
    quote: typeof parsed.quote === "string" ? parsed.quote.slice(0, 280) : null,
    transcript,
    duration_ms: Date.now() - started
  };
}

/**
 * Dispatch an entire campaign with a simple concurrency limit.
 */
export async function dispatchCampaign({ url, description, rows, columns, personasByRowId, onCell }) {
  const cells = [];
  for (const r of rows) for (const c of columns) cells.push({ r, c });

  const limit = env.MAX_CONCURRENT_RUNS;
  let idx = 0;

  async function worker() {
    while (idx < cells.length) {
      const cur = idx++;
      const { r, c } = cells[cur];
      const persona = personasByRowId[r.id];
      const result = await runCell({
        url,
        campaignDescription: description,
        row: r,
        col: c,
        persona
      });
      await onCell({ row: r, col: c, persona, result });
    }
  }

  const workers = Array.from({ length: Math.min(limit, cells.length) }, () =>
    worker()
  );
  await Promise.all(workers);
}
