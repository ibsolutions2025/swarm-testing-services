/**
 * llm.mjs — model-agnostic LLM client for Onboarding Engine LLM steps.
 *
 * Routes to whichever provider has a working API key, in this order:
 *   1. Anthropic (ANTHROPIC_API_KEY)               — claude-sonnet-4-6
 *   2. OpenRouter (OPENROUTER_API_KEY)             — anthropic/claude-sonnet-4
 *   3. Chutes (CHUTES_API_KEY)                     — moonshotai/Kimi-K2.6-TEE
 *      (used when first two are unset; Kimi is a Sonnet-class extractor +
 *       openclaw.json registers it as the default subagent model)
 *
 * Override model via ENGINE_MODEL env. Override provider via ENGINE_PROVIDER
 * env (anthropic|openrouter|chutes).
 *
 * Single entry point: callSonnet({ system, user, maxTokens, temperature }).
 * Returns { ok, content, usage, model, elapsedMs }. The function is named
 * callSonnet for historical reasons; the actual model in use is whatever
 * the auto-selected provider serves.
 *
 * No prompt caching yet (Phase B v1 keeps it simple — each step is one
 * isolated LLM turn).
 */

const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CHUTES_BASE = "https://llm.chutes.ai/v1";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const CHUTES_KEY = process.env.CHUTES_API_KEY || "";

function pickProvider() {
  const explicit = (process.env.ENGINE_PROVIDER || "").toLowerCase();
  if (explicit === "anthropic" && ANTHROPIC_KEY) return "anthropic";
  if (explicit === "openrouter" && OPENROUTER_KEY) return "openrouter";
  if (explicit === "chutes" && CHUTES_KEY) return "chutes";
  // Default preference order per design spec: Sonnet 4.6 first, OpenRouter
  // Sonnet routing second, Chutes/Kimi only as last-resort fallback (Kimi
  // costs reasoning tokens + has 5-7 min per LLM call which timed out
  // step 10 in Phase B v1 — see Phase B Iteration 1 report).
  if (ANTHROPIC_KEY) return "anthropic";
  if (OPENROUTER_KEY) return "openrouter";
  if (CHUTES_KEY) return "chutes";
  return null;
}

function pickModel(provider) {
  if (process.env.ENGINE_MODEL) return process.env.ENGINE_MODEL;
  // Sonnet 4.6 per design spec section 3 + 6.B
  if (provider === "anthropic") return "claude-sonnet-4-5-20250929";
  if (provider === "openrouter") return "anthropic/claude-sonnet-4-5";
  if (provider === "chutes") return "moonshotai/Kimi-K2.6-TEE";
  return null;
}

async function callAnthropic({ system, user, maxTokens, temperature, model, label }) {
  const url = `${ANTHROPIC_BASE.replace(/\/+$/, "")}/v1/messages`;
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system: system || "",
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, error: `[${label}] anthropic HTTP ${r.status}: ${txt.slice(0, 400)}`, elapsedMs: Date.now() - t0 };
  }
  const json = await r.json();
  const blocks = Array.isArray(json.content) ? json.content : [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  return {
    ok: true,
    content: text,
    usage: json.usage || {},
    stopReason: json.stop_reason || null,
    model: json.model || model,
    provider: "anthropic",
    elapsedMs: Date.now() - t0,
  };
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
  const text = (choice.message && choice.message.content) || "";
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
  if (provider === "anthropic") {
    return await callAnthropic({ system, user, maxTokens, temperature, model, label });
  }
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
    return { ok: false, error: "no LLM provider available — set ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or CHUTES_API_KEY" };
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
