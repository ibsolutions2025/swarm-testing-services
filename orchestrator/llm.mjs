import { env } from "./env.mjs";

/**
 * Call OpenRouter's chat-completions API. Returns the assistant text.
 *
 * We default to OpenRouter because it normalizes Anthropic/OpenAI/Kimi/etc.
 * and the repo's billing already flows through there. Swap to a direct
 * Anthropic SDK if you prefer.
 */
export async function chat({ model, system, user, responseFormat = null, maxTokens = 4096 }) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://swarm-testing.dev",
      "X-Title": "Swarm Testing Services"
    },
    body: JSON.stringify({
      model,
      messages: [
        system ? { role: "system", content: system } : null,
        { role: "user", content: user }
      ].filter(Boolean),
      max_tokens: maxTokens,
      ...(responseFormat === "json" ? { response_format: { type: "json_object" } } : {})
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM call failed ${res.status}: ${body.slice(0, 400)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("LLM returned empty content");
  }
  return text;
}

/**
 * Convenience — call with `json: true` and we'll parse + retry once on parse fail.
 */
export async function chatJson(opts) {
  const raw = await chat({ ...opts, responseFormat: "json" });
  try {
    return JSON.parse(raw);
  } catch {
    // Extract first {...} block as a fallback.
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("LLM did not return parseable JSON");
  }
}
