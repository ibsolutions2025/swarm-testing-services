import { chatJson } from "./llm.mjs";
import { env } from "./env.mjs";

/**
 * Turn a buyer's plain-English campaign description into a 2-axis matrix:
 * rows = product/service configurations, columns = agentic user scenarios.
 *
 * Returns { rows: MatrixRow[], columns: MatrixColumn[] }.
 *
 * Deliberately kept compact (≤ MAX_ROWS × MAX_COLUMNS cells) so MVP cost
 * stays predictable. Rows & columns both get stable string ids.
 */
export async function designMatrix({ url, description }) {
  const system = `You are a test matrix designer for an agentic product testing service.

Given a URL and a plain-English description of what the buyer wants tested, produce a 2-axis matrix:
- "rows" are product/service configurations (tier, feature flag, device, environment — things that change the product's state/presentation)
- "columns" are agentic user scenarios (signup, pricing-comparison, purchase, error-recovery, mobile-first-flow, etc.)

Rules:
- Return at most ${env.MAX_ROWS} rows and at most ${env.MAX_COLUMNS} columns.
- Each row and column needs a short human-readable label (<= 40 chars).
- Each column needs a longer \`scenario\` field (2-3 sentences describing the task a persona will attempt) and a \`success_criteria\` array (2-4 bullet strings).
- Each row needs a \`config\` object describing the state the persona should simulate (e.g. {"device": "mobile", "tier": "free"}).
- Row and column \`id\` values MUST be stable slugs (snake_case), unique within their axis.
- Infer reasonable defaults if the buyer was vague. Don't ask clarifying questions.

Return JSON with exactly this shape:
{
  "rows": [{ "id": "...", "label": "...", "config": { ... } }, ...],
  "columns": [{ "id": "...", "label": "...", "scenario": "...", "success_criteria": ["...", "..."] }, ...]
}`;

  const user = `URL: ${url}

Buyer's description:
${description}

Design the matrix.`;

  const json = await chatJson({
    model: env.MODEL_MATRIX,
    system,
    user,
    maxTokens: 3000
  });

  // Defensive normalization
  const rows = Array.isArray(json.rows) ? json.rows.slice(0, env.MAX_ROWS) : [];
  const columns = Array.isArray(json.columns)
    ? json.columns.slice(0, env.MAX_COLUMNS)
    : [];

  for (const r of rows) {
    r.id ||= slug(r.label ?? "row");
    r.label ||= r.id;
    r.config ||= {};
  }
  for (const c of columns) {
    c.id ||= slug(c.label ?? "col");
    c.label ||= c.id;
    c.scenario ||= c.label;
    c.success_criteria = Array.isArray(c.success_criteria)
      ? c.success_criteria
      : [];
  }

  if (rows.length === 0 || columns.length === 0) {
    throw new Error("matrix designer produced empty rows or columns");
  }

  return { rows, columns };
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
}
