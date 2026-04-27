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

const DEFAULT_HEADERS = {
  // Identify ourselves so target servers can grant well-known access if
  // they're locked behind UA-blocking middleware.
  "User-Agent": "STS-OnboardingEngine/0.1 (+swarm-testing-services)",
  Accept: "application/json, text/html;q=0.9, */*;q=0.5",
};

export async function fetchPage(url, opts = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) },
    });
    const contentType = r.headers.get("content-type") || "";
    const body = await r.text();
    return {
      ok: r.ok,
      status: r.status,
      finalUrl: r.url,
      contentType,
      body,
      bodyLength: body.length,
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      contentType: "",
      body: "",
      bodyLength: 0,
      error: e.message,
      elapsedMs: Date.now() - t0,
    };
  }
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
