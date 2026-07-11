import { fetchPage } from "../framework/onboarding/lib/url-crawler.mjs";

function visibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function buildProductContext({ url, docsUrl }) {
  const candidates = [
    { kind: "product", url },
    ...(docsUrl && docsUrl !== url ? [{ kind: "documentation", url: docsUrl }] : [])
  ];
  const sources = [];

  for (const candidate of candidates) {
    const result = await fetchPage(candidate.url, { maxBytes: 2_000_000, timeoutMs: 30_000 });
    if (!result.ok) {
      sources.push({
        kind: candidate.kind,
        requested_url: candidate.url,
        ok: false,
        error: result.error || `HTTP ${result.status}`
      });
      continue;
    }
    const text = visibleText(result.body).slice(0, candidate.kind === "documentation" ? 40_000 : 20_000);
    sources.push({
      kind: candidate.kind,
      requested_url: candidate.url,
      final_url: result.finalUrl,
      ok: true,
      content_type: result.contentType,
      body_length: result.bodyLength,
      text
    });
  }

  return {
    captured_at: new Date().toISOString(),
    sources,
    combined_text: sources
      .filter((source) => source.ok)
      .map((source) => `[${source.kind.toUpperCase()} SOURCE: ${source.final_url}]\n${source.text}`)
      .join("\n\n")
      .slice(0, 60_000)
  };
}
