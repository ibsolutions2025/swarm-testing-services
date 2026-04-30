#!/usr/bin/env node
/**
 * swarm-agent-runner.mjs — LLM dispatcher for the AWP swarm.
 *
 * Single entrypoint. Given a persona (Spark/Grind/Judge/Chaos/Scout/Flash/
 * Bridge), a task type (create|submit|review), and a context object, makes
 * a chat-completions call using the persona's SOUL.md as the system
 * prompt, and returns a typed JSON object. No viem, no chain, no
 * Supabase — pure LLM orchestration. The caller writes the resulting tx.
 *
 * Provider routing (2026-04-30):
 *   AGENT_RUNNER_PROVIDER=chutes  (default) → Chutes Kimi K2.6-TEE
 *   AGENT_RUNNER_PROVIDER=openrouter        → OpenRouter (legacy, fallback)
 * If chutes is selected but CHUTES_API_KEY is missing AND
 * OPENROUTER_API_KEY is set, the runner auto-falls-back to openrouter
 * with a warning rather than throwing.
 *
 * Cost envelope: Kimi K2.6-TEE via Chutes is roughly an order of
 * magnitude cheaper than Anthropic Sonnet and ~3-5x cheaper than the
 * old Gemma-4 27B path. Cap 1500 output tokens (Kimi reasoning chains
 * eat ~500 tokens before emitting the final JSON), cap 3 turns.
 * Expected cost <$1/day at the current swarm cadence (~7 agents × 80
 * active jobs × ~3 LLM calls per lifecycle).
 *
 * Insider-info clean: every prompt string is regex-scanned for leak
 * patterns (scenario IDs, validation-mode enums, "test"/"matrix"/etc.)
 * before being sent. Any match throws — we'd rather hard-fail in cron
 * than silently bias the swarm.
 *
 * Env:
 *   CHUTES_API_KEY        — required when AGENT_RUNNER_PROVIDER=chutes
 *   OPENROUTER_API_KEY    — required when AGENT_RUNNER_PROVIDER=openrouter
 *                           (or as fallback when Chutes key missing)
 *   AGENT_RUNNER_PROVIDER — chutes | openrouter (default: chutes)
 *   AGENT_RUNNER_MODEL    — overrides per-provider default
 *   AGENTS_BASE_DIR       — defaults to /root/test-swarm
 */

import { readFileSync } from "fs";
import path from "path";

// ============================================================
// Persona → agent-N mapping (SOUL.md lives at <base>/agent-<N>/SOUL.md
// on the VPS). Fallback file layout is agents/awp-test-<N>/SOUL.md
// (this repo's layout) — the runner tries both.
// ============================================================
const PERSONA_TO_N = new Map([
  ["Spark", 1],
  ["Grind", 2],
  ["Judge", 3],
  ["Chaos", 4],
  ["Scout", 5],
  ["Flash", 6],
  ["Bridge", 7]
]);

const DEFAULT_AGENTS_BASE = process.env.AGENTS_BASE_DIR || "/root/test-swarm";

// ============================================================
// Provider config
// ============================================================
const PROVIDERS = {
  chutes: {
    endpoint: "https://llm.chutes.ai/v1/chat/completions",
    apiKeyEnv: "CHUTES_API_KEY",
    defaultModel: "moonshotai/Kimi-K2.6-TEE",
    headers: () => ({})
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "google/gemma-4-27b-it",
    headers: () => ({
      "HTTP-Referer": "https://swarm-testing-services.vercel.app",
      "X-Title": "STS swarm agent runner"
    })
  }
};

function pickProvider() {
  const requested = (process.env.AGENT_RUNNER_PROVIDER || "chutes").toLowerCase();
  if (!PROVIDERS[requested]) {
    throw new Error(
      `[agent-runner] unknown AGENT_RUNNER_PROVIDER=${requested} ` +
        `(allowed: ${Object.keys(PROVIDERS).join(", ")})`
    );
  }
  // Fallback: if chutes selected but key missing, drop to openrouter when possible
  if (
    requested === "chutes" &&
    !process.env.CHUTES_API_KEY &&
    process.env.OPENROUTER_API_KEY
  ) {
    console.log(
      "[agent-runner] CHUTES_API_KEY missing — falling back to openrouter"
    );
    return "openrouter";
  }
  return requested;
}

function defaultModelFor(provider) {
  return process.env.AGENT_RUNNER_MODEL || PROVIDERS[provider].defaultModel;
}

// ============================================================
// Insider-info regex scanner — mirrors lib/insider-audit.ts patterns.
// Every prompt string must pass this before hitting the LLM.
// ============================================================
const LEAK_PATTERNS = [
  { name: "expected_outcome", re: /expected.*outcome/i },
  { name: "validationMode", re: /validationMode/i },
  { name: "validation_mode_enum", re: /HARD_ONLY|SOFT_ONLY|HARD_THEN_SOFT/ },
  { name: "scenario_s##", re: /scenario.*s\d{2}/i },
  { name: "config_c##", re: /config.*c\d{2}/i },
  { name: "assertion", re: /assertion/i },
  { name: "should_pass_fail", re: /should.*pass|should.*fail/i },
  { name: "scenario_id_bare", re: /\bs(0[1-9]|1\d|20)\b/ }
];

export function assertInsiderInfoClean(label, text) {
  for (const p of LEAK_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      throw new Error(
        `[agent-runner] insider-info leak in ${label}: ` +
          `pattern=${p.name} matched="${m[0]}" — refusing to call LLM`
      );
    }
  }
}

// ============================================================
// SOUL loader — reads the persona's SOUL.md from disk. Caches in-memory
// per process (fine, cron processes are short-lived).
// ============================================================
const soulCache = new Map();

function loadSoul(persona) {
  if (soulCache.has(persona)) return soulCache.get(persona);
  const n = PERSONA_TO_N.get(persona);
  if (!n) throw new Error(`[agent-runner] unknown persona: ${persona}`);

  // Try VPS layout first (agent-N/SOUL.md), then repo layout (awp-test-N).
  const candidates = [
    path.join(DEFAULT_AGENTS_BASE, `agent-${n}`, "SOUL.md"),
    path.join(DEFAULT_AGENTS_BASE, `awp-test-${n}`, "SOUL.md")
  ];
  let raw = null;
  for (const p of candidates) {
    try {
      raw = readFileSync(p, "utf8");
      break;
    } catch {
      /* continue */
    }
  }
  if (raw == null) {
    throw new Error(
      `[agent-runner] SOUL.md not found for ${persona} (tried ${candidates.join(", ")})`
    );
  }
  // Scan SOUL for leak patterns too — if the SOUL leaks, the prompt leaks.
  assertInsiderInfoClean(`${persona}/SOUL.md`, raw);
  soulCache.set(persona, raw);
  return raw;
}

// ============================================================
// Prompt templates. Tightened for Kimi K2.6 (which is dumber than
// Sonnet on nuanced reasoning) — every prompt ends with an explicit
// one-line JSON example and the strict "ONLY JSON, no prose, no
// fences" instruction. Reject coerceResult will discard non-JSON.
// ============================================================
function buildPrompt(taskType, context) {
  if (taskType === "create") {
    const reward = context?.rewardUSDC ?? "5";
    const lines = Array.isArray(context?.constraints) ? context.constraints : [];
    const bullets =
      lines.length === 0
        ? ""
        : "\n" + lines.map((l) => `  - ${l}`).join("\n");
    return (
      `You want to post a new job on the AgentWork Protocol. Job constraints:\n` +
      `  - Reward: ${reward} USDC` +
      bullets +
      `\nPick any topic that fits how you operate as an agent — something ` +
      `you'd genuinely want done by another agent. Write a concise title ` +
      `(under 80 chars) and a 2-3 sentence description that a worker could ` +
      `act on. Don't mention AWP internals, don't label the job as any kind ` +
      `of trial, don't reference platform machinery.\n\n` +
      `Respond with ONLY a JSON object — no prose before or after, no ` +
      `markdown code fences. Schema: {"title": string, "description": string}.\n` +
      `Example: {"title":"Draft a 200-word competitive analysis of three RPC providers","description":"Compare Alchemy, Infura, and QuickNode on free-tier limits, error rates, and getLogs reliability. 200 words, plain text."}`
    );
  }
  if (taskType === "submit") {
    const j = context?.job ?? {};
    return (
      `A job is open on the AgentWork Protocol.\n` +
      `Title: ${j.title ?? ""}\n` +
      `Description: ${j.description ?? ""}\n` +
      `Reward: ${j.rewardUSDC ?? "5"} USDC\n` +
      `Posted by: ${j.posterShort ?? "unknown"}\n\n` +
      `You've decided to submit work on this. Produce a plausible ` +
      `deliverable URL (must start with https://, length >= 50, and include ` +
      `a comma — the URL can be invented; think of it as where your work ` +
      `would live). Add a 1-2 sentence note about what you submitted. Stay ` +
      `in character.\n\n` +
      `Respond with ONLY a JSON object — no prose before or after, no ` +
      `markdown code fences. Schema: {"deliverableUrl": string, "note": string}.\n` +
      `Example: {"deliverableUrl":"https://drafts.example.com/job/123,competitive-analysis-v1.md","note":"Comparison of Alchemy, Infura, QuickNode on getLogs reliability — see linked draft."}`
    );
  }
  if (taskType === "review") {
    const j = context?.job ?? {};
    const s = context?.submission ?? {};
    return (
      `You're reviewing a submission on the AgentWork Protocol.\n` +
      `Job:\n` +
      `  Title: ${j.title ?? ""}\n` +
      `  Description: ${j.description ?? ""}\n` +
      `Submission by ${s.workerShort ?? "someone"}:\n` +
      `  Deliverable URL: ${s.deliverableUrl ?? ""}\n` +
      `  Note: "${s.note ?? ""}"\n\n` +
      `Decide whether to approve or reject, pick a quality score 0-100, ` +
      `and write a 1-3 sentence reason. Be consistent with your character ` +
      `— if your persona is blunt, write bluntly; if generous, be generous.\n\n` +
      `Respond with ONLY a JSON object — no prose before or after, no ` +
      `markdown code fences. Schema: {"decision": "approve"|"reject", "score": integer 0-100, "reason": string}.\n` +
      `Example: {"decision":"approve","score":78,"reason":"Deliverable matches the brief; minor formatting issues but core analysis is solid."}`
    );
  }
  throw new Error(`[agent-runner] unknown taskType: ${taskType}`);
}

// ============================================================
// Fallbacks (only used when both JSON parse attempts fail).
// ============================================================
function fallbackResult(taskType, persona, context) {
  if (taskType === "create") {
    return {
      title: "New task — consolidated",
      description: "A job for an autonomous agent on AWP.",
      fell_back: true
    };
  }
  if (taskType === "submit") {
    const jobId = context?.job?.jobId ?? context?.jobId ?? "unknown";
    const slug = (persona || "agent").toLowerCase();
    return {
      deliverableUrl: `https://awp-submissions.example.com/job${jobId},${slug}-delivery-auto-fallback`,
      note: "Submitted.",
      fell_back: true
    };
  }
  if (taskType === "review") {
    return {
      decision: "approve",
      score: 70,
      reason: "Meets the requirement.",
      // Back-compat alias for callers that read .comment
      comment: "Meets the requirement.",
      fell_back: true
    };
  }
  throw new Error(`[agent-runner] fallback: unknown taskType ${taskType}`);
}

// ============================================================
// Provider call (Chutes / OpenRouter share the OpenAI-compatible shape)
// ============================================================
async function callProvider({ provider, model, messages, maxTokens }) {
  const cfg = PROVIDERS[provider];
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `[agent-runner] ${cfg.apiKeyEnv} is not set — cannot dispatch LLM call (provider=${provider})`
    );
  }
  const t0 = Date.now();
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...cfg.headers()
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.7,
      response_format: { type: "json_object" }
    })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "<unreadable>");
    throw new Error(
      `[agent-runner] ${provider} HTTP ${res.status}: ${txt.slice(0, 300)}`
    );
  }
  const body = await res.json();
  const ms = Date.now() - t0;
  const msg = body?.choices?.[0]?.message ?? {};
  // Reasoning models (e.g. Kimi K2.6-TEE on Chutes) often put the final
  // text in `reasoning_content` (or `reasoning`) and leave `content` null.
  // Prefer `content`, then fall through to either reasoning field.
  const content =
    (typeof msg.content === "string" && msg.content.length > 0
      ? msg.content
      : null) ??
    (typeof msg.reasoning_content === "string" ? msg.reasoning_content : null) ??
    (typeof msg.reasoning === "string" ? msg.reasoning : "") ??
    "";
  const usage = body?.usage ?? {};
  return {
    content,
    usage: {
      in: usage.prompt_tokens ?? 0,
      out: usage.completion_tokens ?? 0
    },
    ms
  };
}

// Walk the string and return the LAST balanced top-level {...} blob.
// Reasoning-model outputs often contain multiple {...} fragments inside
// the trace ("the JSON would be {...}") followed by the final answer
// also as {...}. We want the last complete one.
function findLastBalancedObject(s) {
  let lastBlob = null;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        lastBlob = s.slice(start, i + 1);
        start = -1;
      }
    }
  }
  return lastBlob;
}

function tryParseJson(s) {
  if (typeof s !== "string") return null;
  // Trim code fences if the model wrapped them.
  let trimmed = s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  // First try direct parse (fast path for clean responses).
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  // Reasoning trace or stray prose — find the last balanced {...} blob.
  const blob = findLastBalancedObject(trimmed);
  if (!blob) return null;
  try {
    return JSON.parse(blob);
  } catch {
    return null;
  }
}

// ============================================================
// Result validators per taskType.
// ============================================================
function coerceResult(taskType, parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (taskType === "create") {
    if (typeof parsed.title !== "string" || typeof parsed.description !== "string")
      return null;
    return {
      title: parsed.title.slice(0, 200),
      description: parsed.description.slice(0, 2000),
      note: typeof parsed.note === "string" ? parsed.note : undefined
    };
  }
  if (taskType === "submit") {
    if (
      typeof parsed.deliverableUrl !== "string" ||
      typeof parsed.note !== "string"
    )
      return null;
    if (!parsed.deliverableUrl.startsWith("https://")) return null;
    if (parsed.deliverableUrl.length < 50) return null;
    if (!parsed.deliverableUrl.includes(",")) return null;
    return { deliverableUrl: parsed.deliverableUrl, note: parsed.note };
  }
  if (taskType === "review") {
    const dec = parsed.decision;
    const sc = parsed.score;
    if (dec !== "approve" && dec !== "reject") return null;
    const scoreNum = typeof sc === "number" ? Math.round(sc) : parseInt(sc, 10);
    if (!Number.isFinite(scoreNum) || scoreNum < 0 || scoreNum > 100) return null;
    // Accept either `reason` (new schema) or `comment` (legacy).
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason
        : typeof parsed.comment === "string"
          ? parsed.comment
          : null;
    if (reason == null) return null;
    return {
      decision: dec,
      score: scoreNum,
      reason: reason.slice(0, 400),
      // Back-compat alias for downstream callers that still read .comment
      comment: reason.slice(0, 400)
    };
  }
  return null;
}

// ============================================================
// Public entrypoint
// ============================================================
export async function runAgent({
  persona,
  taskType,
  context,
  maxTurns = 3,
  model
}) {
  if (!persona) throw new Error("[agent-runner] missing persona");
  if (!taskType) throw new Error("[agent-runner] missing taskType");

  const provider = pickProvider();
  const resolvedModel = model || defaultModelFor(provider);

  const soul = loadSoul(persona);
  const userPrompt = buildPrompt(taskType, context || {});

  // Insider-info sanity check on every generated prompt string.
  assertInsiderInfoClean(`${persona}/${taskType}/system`, soul);
  assertInsiderInfoClean(`${persona}/${taskType}/user`, userPrompt);

  const messages = [
    { role: "system", content: soul },
    { role: "user", content: userPrompt }
  ];

  let lastErr = null;
  let turns = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const t0 = Date.now();

  const hardCap = Math.min(Math.max(1, maxTurns), 3);
  for (let attempt = 0; attempt < hardCap; attempt++) {
    turns++;
    let call;
    try {
      call = await callProvider({
        provider,
        model: resolvedModel,
        messages,
        maxTokens: 1500
      });
    } catch (e) {
      lastErr = e;
      break;
    }
    tokensIn += call.usage.in;
    tokensOut += call.usage.out;

    const parsed = tryParseJson(call.content);
    const result = coerceResult(taskType, parsed);
    if (result) {
      const ms = Date.now() - t0;
      console.log(
        `[agent-runner] persona=${persona} task=${taskType} provider=${provider} ` +
          `model=${resolvedModel} turns=${turns} tokens=${tokensIn}/${tokensOut} ` +
          `ms=${ms} outcome=ok`
      );
      return { ...result, fell_back: false };
    }

    // Parse or validation failure — add a corrective turn and retry once.
    messages.push({ role: "assistant", content: call.content });
    messages.push({
      role: "user",
      content:
        "Your previous reply was not valid JSON matching the required shape. " +
        "Respond with only the JSON object specified — no commentary, no " +
        "code fences, no preamble. Just the raw JSON object."
    });
  }

  // Fallback path.
  const fb = fallbackResult(taskType, persona, context || {});
  const ms = Date.now() - t0;
  console.log(
    `[agent-runner] persona=${persona} task=${taskType} provider=${provider} ` +
      `model=${resolvedModel} turns=${turns} tokens=${tokensIn}/${tokensOut} ` +
      `ms=${ms} outcome=fallback` +
      (lastErr ? ` err=${lastErr.message?.slice(0, 500)}` : "")
  );
  return fb;
}

// Allow running as CLI for smoke tests: node swarm-agent-runner.mjs <persona> <task> <json-context>
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const [, , persona, taskType, ctxJson] = process.argv;
    if (!persona || !taskType) {
      console.error("usage: swarm-agent-runner.mjs <persona> <task> <json-context>");
      process.exit(2);
    }
    let context = {};
    try {
      if (ctxJson) context = JSON.parse(ctxJson);
    } catch (e) {
      console.error(`bad json context: ${e.message}`);
      process.exit(2);
    }
    try {
      const r = await runAgent({ persona, taskType, context });
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  })();
}
