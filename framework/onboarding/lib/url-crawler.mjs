/**
 * url-crawler.mjs — generic HTTP fetcher for the Onboarding Engine.
 *
 * Knows nothing about AWP or any specific protocol. Pure web3-conventions
 * helper:
 *   - GET with redirect follow + content-type sniffing
 *   - JSON parsing wrapper
 *   - slugify(name) for "AgentWork Protocol" → "agentwork-protocol"
 *   - well-known discovery: try /.well-known/agent.json AND
 *     /api/.well-known/agent.json (Vercel-style API routes are common)
 *
 * No retries, no caching — engine state is recorded by the caller. Each
 * step that uses this helper is responsible for failure handling.
 */

import { assertPublicTargetUrl } from "../../../lib/target-url.mjs";

const DEFAULT_HEADERS = {
  // Identify ourselves so target servers can grant well-known access if
  // they're locked behind UA-blocking middleware.
  "User-Agent": "STS-OnboardingEngine/0.1 (+swarm-testing-services)",
  Accept: "application/json, text/html;q=0.9, */*;q=0.5",
};

export async function fetchPage(url, opts = {}) {
  const t0 = Date.now();
  try {
    const timeoutMs = boundedNumber(opts.timeoutMs ?? process.env.STS_FETCH_TIMEOUT_MS, 30_000, 1_000, 120_000);
    const maxBytes = boundedNumber(opts.maxBytes ?? process.env.STS_MAX_FETCH_BYTES, 2_000_000, 65_536, 5_000_000);
    const maxRedirects = boundedNumber(opts.maxRedirects, 5, 0, 10);
    let currentUrl = String(url);

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const safe = await assertPublicTargetUrl(currentUrl);
      const r = await fetch(safe.url, {
        method: "GET",
        redirect: "manual",
        headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (r.status >= 300 && r.status < 400) {
        const location = r.headers.get("location");
        if (!location) throw new Error(`redirect ${r.status} did not include a location header`);
        if (redirectCount === maxRedirects) throw new Error(`redirect limit exceeded (${maxRedirects})`);
        currentUrl = new URL(location, safe.url).toString();
        continue;
      }

      const contentType = r.headers.get("content-type") || "";
      const body = await readBodyLimited(r, maxBytes);
      return {
        ok: r.ok,
        status: r.status,
        finalUrl: safe.url.toString(),
        contentType,
        body,
        bodyLength: Buffer.byteLength(body, "utf8"),
        elapsedMs: Date.now() - t0,
      };
    }

    throw new Error("redirect loop ended unexpectedly");
  } catch (e) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      contentType: "",
      body: "",
      bodyLength: 0,
      error: e instanceof Error ? e.message : String(e),
      errorCode: typeof e === "object" && e && "code" in e ? String(e.code) : "fetch_failed",
      elapsedMs: Date.now() - t0,
    };
  }
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

async function readBodyLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response exceeds ${maxBytes} byte limit`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel("response size limit exceeded");
      throw new Error(`response exceeds ${maxBytes} byte limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export async function fetchJson(url, opts = {}) {
  const r = await fetchPage(url, opts);
  if (!r.ok) {
    return { ok: false, status: r.status, error: r.error || `HTTP ${r.status}` };
  }
  try {
    return { ok: true, status: r.status, finalUrl: r.finalUrl, json: JSON.parse(r.body) };
  } catch (e) {
    return { ok: false, status: r.status, error: `bad JSON at ${r.finalUrl}: ${e.message}` };
  }
}

/**
 * Generic well-known agent.json discovery. Tries the two locations almost
 * every protocol uses today (the spec'd `/.well-known/agent.json` and the
 * Vercel-API-route variant `/api/.well-known/agent.json`).
 */
export async function discoverAgentManifest(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");
  const candidates = [
    `${base}/.well-known/agent.json`,
    `${base}/api/.well-known/agent.json`,
  ];
  const tried = [];
  for (const url of candidates) {
    const r = await fetchJson(url);
    tried.push({ url, ok: r.ok, status: r.status, error: r.error });
    if (r.ok && r.json && typeof r.json === "object") {
      return { ok: true, manifestUrl: r.finalUrl || url, manifest: r.json, tried };
    }
  }
  return { ok: false, manifestUrl: null, manifest: null, tried };
}

/**
 * Slugify a human-readable name into a URL/dir-safe identifier.
 * Examples:
 *   "AgentWork Protocol"  →  "agentwork-protocol"
 *   "Some New Network!"   →  "some-new-network"
 *   "v2/Multi-Sig DAO"    →  "v2-multi-sig-dao"
 */
export function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[\s/_]+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unknown";
}
