/**
 * Step 05 — crawl-docs.
 *
 * Fetch the protocol's primary docs page (manifest.documentation_url or
 * manifest.agent_docs_url) and ask the LLM to produce a structured audit:
 * sections, clarity ratings, and findings.
 *
 * Output is recorded in ctx (no file emit). Step 12 incorporates it into
 * the AUDIT-AND-DESIGN.md doc.
 */

import { fetchPage } from "../lib/url-crawler.mjs";
import { callSonnetJson } from "../lib/llm.mjs";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function run(ctx) {
  const manifest = ctx.steps?.["02-discover-manifest"]?.output?.manifest;
  if (!manifest) return { ok: false, error: "no manifest from step 02" };

  // Pick the most agent-relevant docs URL the manifest exposes.
  const docsUrl =
    manifest.agent_docs_url ||
    manifest.documentation_url ||
    manifest.documentation?.quick_start ||
    null;
  if (!docsUrl) {
    return {
      ok: true,
      output: {
        skipped: true,
        reason: "no agent_docs_url or documentation_url in manifest",
        findings: [{
          category: "docs_product_gap",
          severity: "high",
          description: "Manifest exposes no top-level documentation_url or agent_docs_url. Onboarding tools cannot find the entry-point docs page.",
        }],
      },
    };
  }

  const page = await fetchPage(docsUrl);
  if (!page.ok) {
    return {
      ok: true,
      output: {
        docsUrl,
        unreachable: true,
        error: page.error || `HTTP ${page.status}`,
        findings: [{
          category: "docs_product_gap",
          severity: "high",
          description: `Manifest's documentation URL ${docsUrl} returned ${page.error || `HTTP ${page.status}`}. Fix or update manifest.`,
        }],
      },
    };
  }

  // Strip HTML tags to keep prompt lean. Naive but enough for audit purposes.
  let text = page.body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Cap at ~50k chars to fit comfortably in the 128k context with room to spare
  if (text.length > 50000) text = text.slice(0, 50000) + "\n\n[truncated]";

  const promptPath = resolve(__dirname, "..", "prompts", "crawl-docs.md");
  const promptTemplate = await readFile(promptPath, "utf8");
  const userPrompt = `${promptTemplate}\n\nPage URL: ${docsUrl}\n\nRendered content (HTML stripped):\n\n${text}`;

  const llm = await callSonnetJson({
    system: "You are a precise docs auditor. Output only the requested JSON object.",
    user: userPrompt,
    maxTokens: 8192,
    label: "crawl-docs",
  });
  if (!llm.ok) {
    return { ok: true, output: { docsUrl, llmError: llm.error, findings: [] } };
  }

  const j = llm.value || {};
  return {
    ok: true,
    output: {
      docsUrl,
      sectionCount: Array.isArray(j.sections) ? j.sections.length : 0,
      completeness: j.meta?.completeness || null,
      sections: Array.isArray(j.sections) ? j.sections : [],
      findings: Array.isArray(j.findings) ? j.findings : [],
      bodyLength: text.length,
      usage: llm.usage,
    },
  };
}
