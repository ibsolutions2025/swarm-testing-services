// Shared env bootstrap. Fails fast if required vars missing.

const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY"
];

for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`[orchestrator] missing env var: ${k}`);
    // Don't hard-exit on import — run.mjs will validate before starting the loop.
  }
}

export const env = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  // Default to a capable tool-calling model. Override via env for cheaper runs.
  MODEL_MATRIX: process.env.MODEL_MATRIX || "anthropic/claude-sonnet-4",
  MODEL_PERSONA: process.env.MODEL_PERSONA || "anthropic/claude-sonnet-4",
  MODEL_RUN: process.env.MODEL_RUN || "anthropic/claude-haiku-4-5",
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS || 10_000),
  MAX_ROWS: Number(process.env.MAX_ROWS || 5),
  MAX_COLUMNS: Number(process.env.MAX_COLUMNS || 6),
  MAX_CONCURRENT_RUNS: Number(process.env.MAX_CONCURRENT_RUNS || 3)
};

export function requireEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `orchestrator cannot start — missing env: ${missing.join(", ")}`
    );
  }
}
