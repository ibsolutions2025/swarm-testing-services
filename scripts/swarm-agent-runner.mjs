#!/usr/bin/env node
/**
 * swarm-agent-runner.mjs — LLM dispatcher for the AWP swarm.
 *
 * Single entrypoint. Given a persona (Spark/Grind/Judge/Chaos/Scout/Flash/
 * Bridge), a task type (create|submit|review), and a context object, makes
 * an OpenRouter chat-completions call using the persona's SOUL.md as the
 * system prompt, and returns a typed JSON object. No viem, no chain, no
 * Supabase — pure LLM orchestration. The caller writes the resulting tx.
 *
 * Cost envelope: Gemma-4 27B via OpenRouter, cap 600 output tokens, cap 3
 * turns. Expected ~$5/day at the current swarm cadence.
 *
 * Insider-info clean: every prompt string is regex-scanned for leak
 * patterns (scenario IDs, validation-mode enums, "test"/"matrix"/etc.)
 * before being sent. Any match throws — we'd rather hard-fail in cron than
 * silently bias the swarm.
 *
 * Env:
 *   OPENROUTER_API_KEY   — required
 *   AGENTS_BASE_DIR      — optional, defaults to /root/test-swarm
 *   AGENT_RUNNER_MODEL   — optional, defaults to google/gemma-4-27b-it
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
const DEFAULT_MODEL =
  process.env.AGENT_RUNNER_MODEL || "google/gemma-4-27b-it";

// ============================================================
// Insider-info regex scanner — mirrors lib/insider-audit.ts patterns.
// Every prompt string must pass this before hitting OpenRouter.
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
// Prompt templates (mirrors scripts/PERSONA-PROMPTS.md verbatim).
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
      `of trial, don't reference platform machinery.\n` +
      `Return strictly JSON: {"title": "...", "description": "..."}`
    );
  }
  if (taskType === "submit") {
    const j = context?.job ?? {};
    return (
      `A job is open on the AgentWork Protocol.\n` +
      `Title: ${j.title ?? ""}\n` +
      `Description: ${j.description ?? ""}\n` +
      `Reward: ${j.rewardUSDC ?? "5"} USDC\n` +
      `Posted by: ${j.posterShort ?? "unknown"}\n` +
      `You've decided to submit work on this. Produce a plausible ` +
      `deliverable URL (must start with https://, length >= 50, and include ` +
      `a comma — the URL can be invented; think of it as where your work ` +
      `would live). Add a 1-2 sentence note about what you submitted. Stay ` +
      `in character.\n` +
      `Return strictly JSON: {"deliverableUrl": "...", "note": "..."}`
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
      `  Note: "${s.note ?? ""}"\n` +
      `Decide whether to approve or reject, pick a rating from 1-5, and ` +
      `write a 1-3 sentence review comment. Be consistent with your ` +
      `character — if your persona is blunt, write bluntly. If you're ` +
      `generous, be generous.\n` +
      `Return strictly JSON: ` +
      `{"decision":"approve"|"reject","score":1|2|3|4|5,"comment":"..."}`
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
      score: 4,
      comment: "Meets the requirement.",
      fell_back: true
    };
  }
  throw new Error(`[agent-runner] fallback: unknown taskType ${taskType}`);
}

// ============================================================
// OpenRouter call
// ============================================================
async function callOpenRouter({ model, messages, maxTokens }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[agent-runner] OPENROUTER_API_KEY is not set — cannot dispatch LLM call"
    );
  }
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://swarm-testing-services.vercel.app",
      "X-Title": "STS swarm agent runner"
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
      `[agent-runner] OpenRouter HTTP ${res.status}: ${txt.slice(0, 300)}`
    );
  }
  const body = await res.json();
  const ms = Date.now() - t0;
  const content = body?.choices?.[0]?.message?.content ?? "";
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

function tryParseJson(s) {
  if (typeof s !== "string") return null;
  // Trim code fences if the model wrapped them.
  const trimmed = s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
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
    if (!Number.isFinite(scoreNum) || scoreNum < 1 || scoreNum > 5) return null;
    if (typeof parsed.comment !== "string") return null;
    return {
      decision: dec,
      score: scoreNum,
      comment: parsed.comment.slice(0, 400)
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
  model = DEFAULT_MODEL
}) {
  if (!persona) throw new Error("[agent-runner] missing persona");
  if (!taskType) throw new Error("[agent-runner] missing taskType");

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
      call = await callOpenRouter({ model, messages, maxTokens: 600 });
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
        `[agent-runner] persona=${persona} task=${taskType} turns=${turns} ` +
          `tokens=${tokensIn}/${tokensOut} ms=${ms} outcome=ok`
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
        "code fences."
    });
  }

  // Fallback path.
  const fb = fallbackResult(taskType, persona, context || {});
  const ms = Date.now() - t0;
  console.log(
    `[agent-runner] persona=${persona} task=${taskType} turns=${turns} ` +
      `tokens=${tokensIn}/${tokensOut} ms=${ms} outcome=fallback` +
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
