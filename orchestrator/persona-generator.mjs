import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatJson } from "./llm.mjs";
import { env } from "./env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY_DIR = path.join(__dirname, "..", "personas", "library");

let _libraryCache = null;

async function loadLibrary() {
  if (_libraryCache) return _libraryCache;
  try {
    const files = await fs.readdir(LIBRARY_DIR);
    const out = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      const raw = await fs.readFile(path.join(LIBRARY_DIR, f), "utf8");
      try {
        out.push(JSON.parse(raw));
      } catch {
        // skip malformed
      }
    }
    _libraryCache = out;
    return out;
  } catch {
    _libraryCache = [];
    return [];
  }
}

/**
 * Generate a campaign-specific persona for a given matrix row. Uses the
 * starter library as inspiration — the LLM picks the closest archetype
 * and adapts it to the row's config.
 *
 * Returns { name, archetype, goals, biases, soul_md }.
 */
export async function generatePersona({ url, description, row }) {
  const library = await loadLibrary();
  const librarySummary = library
    .map((p) => `- ${p.name} (${p.archetype}): goals=${JSON.stringify(p.goals).slice(0, 140)}`)
    .join("\n");

  const system = `You are a persona designer for agentic product testing.

Given a matrix row describing a product configuration to simulate, produce ONE persona who would realistically encounter that configuration. Draw inspiration from the starter library below — match the closest archetype, then adapt it to this row's config.

Rules:
- Write goals and biases as first-person-compatible short sentences.
- soul_md must be 3-6 sentences in the persona's OWN voice, first person.
- Do not mention "the product", "the platform", "the service" abstractly — the persona has no idea the product exists yet; they just know the URL they're pointed at.
- Do not include any meta commentary about testing. The persona does not know they are being tested.

Return JSON:
{
  "name": "First Last",
  "archetype": "short phrase",
  "goals": ["...", "..."],
  "biases": ["...", "..."],
  "soul_md": "first-person paragraph"
}

Starter library (for inspiration only — do NOT just copy):
${librarySummary}`;

  const user = `URL: ${url}
Buyer's description of what they want tested: ${description}

Matrix row to simulate:
- label: ${row.label}
- config: ${JSON.stringify(row.config)}

Generate the persona.`;

  const json = await chatJson({
    model: env.MODEL_PERSONA,
    system,
    user,
    maxTokens: 1200
  });

  json.name ||= row.label;
  json.archetype ||= "Unspecified";
  json.goals = Array.isArray(json.goals) ? json.goals : [];
  json.biases = Array.isArray(json.biases) ? json.biases : [];
  json.soul_md ||= "";

  return json;
}
