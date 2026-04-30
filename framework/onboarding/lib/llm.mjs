/**
 * llm.mjs — model-agnostic LLM client for Onboarding Engine LLM steps.
 *
 * Anthropic is intentionally NOT a provider here. Agent-side code (engine,
 * auditor, swarm) runs only on open-source models via Chutes (primary) or
 * OpenRouter (fallback). Anthropic auth is reserved for human-driven dev
 * tools (Claude Code, Cowork) — never imported by agent runtime.
 *
 * Routes to whichever provider has a working API key, in this order:
 *   1. Chutes (CHUTES_API_KEY)         — moonshotai/Kimi-K2.6-TEE
 *   2. OpenRouter (OPENROUTER_API_KEY) — moonshotai/kimi-k2-instruct
 *
 * Override model via ENGINE_MODEL env. Override provider via ENGINE_PROVIDER
 * env (chutes|openrouter).
 *
 * Single entry point: callSonnet({ system, user, maxTokens, temperature }).
 * Returns { ok, content, usage, model, elapsedMs }. Function name retained
 * for back-compat with existing callers; the actual model in use is
 * whichever Kimi the auto-selected provider serves.
 *
 * No prompt caching yet (Phase B v1 keeps it simple — each step is one
 * isolated LLM turn).
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CHUTES_BASE = "https://llm.chutes.ai/v1";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const CHUTES_KEY = process.env.CHUTES_API_KEY || "";

function pickProvider() {
  const explicit = (process.env.ENGINE_PROVIDER || "").toLowerCase();
  if (explicit === "chutes" && CHUTES_KEY) return "chutes";
  if (explicit === "openrouter" && OPENROUTER_KEY) return "openrouter";
  // Default preference order: Chutes first (Kimi K2.6-TEE), OpenRouter
  // fallback (Kimi K2 instruct). Anthropic is intentionally absent.
  if (CHUTES_KEY) return "chutes";
  if (OPENROUTER_KEY) return "openrouter";
  return null;
}

function pickModel(provider) {
  if (process.env.ENGINE_MODEL) return process.env.ENGINE_MODEL;
  if (provider === "chutes") return "moonshotai/Kimi-K2.6-TEE";
  if (provider === "openrouter") return "moonshotai/kimi-k2-instruct";
  return null;
}

async function callOpenAICompat({ baseUrl, apiKey, system, user, maxTokens, temperature, model, label, provider }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const t0 = Date.now();
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      // OpenRouter is happier with a referer + title; harmless for Chutes
      "HTTP-Referer": "https://swarm-testing-services.vercel.app",
      "X-Title": "STS Onboarding Engine",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, error: `[${label}] ${provider} HTTP ${r.status}: ${txt.slice(0, 400)}`, elapsedMs: Date.now() - t0 };
  }
  const json = await r.json();
  const choice = (json.choices && json.choices[0]) || {};
  // Reasoning models (Kimi K2.6-TEE on Chutes) put the final answer in
  // message.reasoning_content / message.reasoning, with content === null.
  const msg = choice.message || {};
  const text =
    (typeof msg.content === "string" && msg.content.length > 0
      ? msg.content
      : null) ??
    (typeof msg.reasoning_content === "string" ? msg.reasoning_content : null) ??
    (typeof msg.reasoning === "string" ? msg.reasoning : "") ??
    "";
  return {
    ok: true,
    content: typeof text === "string" ? text : "",
    usage: json.usage || {},
    stopReason: choice.finish_reason || null,
    model: json.model || model,
    provider,
    elapsedMs: Date.now() - t0,
  };
}

async function dispatchOnce({ provider, system, user, maxTokens, temperature, model, label }) {
  if (provider === "openrouter") {
    return await callOpenAICompat({
      baseUrl: OPENROUTER_BASE, apiKey: OPENROUTER_KEY,
      system, user, maxTokens, temperature, model, label, provider: "openrouter",
    });
  }
  if (provider === "chutes") {
    return await callOpenAICompat({
      baseUrl: CHUTES_BASE, apiKey: CHUTES_KEY,
      system, user, maxTokens, temperature, model, label, provider: "chutes",
    });
  }
  return { ok: false, error: `[${label}] unknown provider "${provider}"` };
}

export async function callSonnet({
  system,
  user,
  maxTokens = 8192,
  temperature = 0,
  model = null,
  label = "engine-llm",
}) {
  if (!user) {
    return { ok: false, error: `[${label}] no user prompt provided` };
  }
  const provider = pickProvider();
  if (!provider) {
    return { ok: false, error: "no LLM provider available — set CHUTES_API_KEY or OPENROUTER_API_KEY" };
  }
  const m = model || pickModel(provider);

  // Retry with exponential backoff per spec target 1: 5s, 15s, 45s — 3 attempts total.
  // Network errors (fetch failed) and 5xx responses retry. 4xx (auth, bad request)
  // do not — they won't fix themselves. Step 10 timed out at 5min on Chutes in
  // Phase B v1; explicit retry surfaces transient-vs-persistent failure.
  const delays = [0, 5_000, 15_000, 45_000];
  let lastErr = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    try {
      const r = await dispatchOnce({ provider, system, user, maxTokens, temperature, model: m, label: `${label}#a${attempt + 1}` });
      if (r.ok) return r;
      lastErr = r;
      // 4xx responses won't recover — abort early
      const errMsg = r.error || "";
      if (/HTTP 4(00|01|03|04|13|22)/.test(errMsg)) {
        return r;
      }
    } catch (e) {
      lastErr = { ok: false, error: `[${label}] ${provider} threw: ${e.message}` };
    }
  }
  return lastErr || { ok: false, error: `[${label}] all retries exhausted` };
}

/**
 * Convenience: ask the LLM to produce a JSON object. Wraps callSonnet,
 * appends an instruction to the user prompt to return only valid JSON,
 * parses the result. On parse failure, retries once with a corrective
 * follow-up.
 */
export async function callSonnetJson({ system, user, schema, maxTokens, label = "engine-llm-json" }) {
  const wrappedUser =
    user +
    "\n\n---\n" +
    "Respond with ONLY valid JSON matching the structure above. " +
    "No prose, no markdown code fences, no commentary. Just the raw JSON object/array.";
  const r = await callSonnet({ system, user: wrappedUser, maxTokens, label });
  if (!r.ok) return r;

  const tryParse = (raw) => {
    let s = String(raw).trim();
    // Strip code fences if the model added them despite instructions
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try { return { ok: true, value: JSON.parse(s) }; } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  let parsed = tryParse(r.content);
  if (parsed.ok) {
    return { ok: true, value: parsed.value, content: r.content, usage: r.usage, elapsedMs: r.elapsedMs };
  }

  // Retry once with explicit corrective prompt
  const correctiveUser =
    user +
    "\n\n---\n" +
    "Your previous reply was not valid JSON. Reply with ONLY the JSON object/array — no prose, no fences, no commentary.\n" +
    `Parse error: ${parsed.error.slice(0, 200)}`;
  const r2 = await callSonnet({ system, user: correctiveUser, maxTokens, label: label + "-retry" });
  if (!r2.ok) return r2;
  parsed = tryParse(r2.content);
  if (parsed.ok) {
    return { ok: true, value: parsed.value, content: r2.content, usage: r2.usage, elapsedMs: r2.elapsedMs };
  }
  return { ok: false, error: `[${label}] JSON parse failed twice: ${parsed.error}`, content: r2.content };
}
