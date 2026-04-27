/**
 * Step 01 — validate-url.
 *
 * Sanity-check the URL the user submitted: it parses, it's reachable, it
 * returns a 2xx, and it serves something we can recognize as a web page
 * (HTML or a JSON manifest). No protocol-specific knowledge.
 */

import { fetchPage } from "../lib/url-crawler.mjs";

export async function run(ctx) {
  const url = ctx.input?.url;
  if (!url) {
    return { ok: false, error: "no url provided to engine" };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { ok: false, error: `URL parse failed: ${e.message}` };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, error: `unsupported protocol "${parsed.protocol}" — engine only handles http/https` };
  }

  const r = await fetchPage(url);
  if (!r.ok) {
    return {
      ok: false,
      error: `URL unreachable: ${r.error || `HTTP ${r.status}`}`,
      probe: r,
    };
  }

  return {
    ok: true,
    output: {
      url: parsed.toString(),
      origin: parsed.origin,
      finalUrl: r.finalUrl,
      status: r.status,
      contentType: r.contentType,
      bodyExcerpt: r.body.slice(0, 600),
      bodyLength: r.bodyLength,
      elapsedMs: r.elapsedMs,
    },
  };
}
