/**
 * Step 02 — discover-manifest.
 *
 * Locate the protocol's machine-readable manifest. Tries the two
 * agent.json conventions used in the wild:
 *   - /.well-known/agent.json   (the spec'd canonical path)
 *   - /api/.well-known/agent.json (Vercel-style API-route variant)
 *
 * Stores the manifest verbatim in ctx for downstream steps. Derives a
 * URL/dir-safe slug from manifest.name so output paths can be predicted
 * (`lib/<slug>/`, `clients/<slug>/`).
 *
 * No fallback crawl yet — design 3.1 step 02 says "fetch /.well-known/agent.json
 * OR crawl for it"; if neither standard path works, we fail loudly so the
 * operator knows the protocol's discovery surface needs improvement. A
 * crawl-based fallback is a Phase B v2 improvement once we see a real
 * protocol that needs it.
 */

import { discoverAgentManifest, slugify } from "../lib/url-crawler.mjs";

export async function run(ctx) {
  const origin = ctx.steps?.["01-validate-url"]?.output?.origin;
  if (!origin) {
    return { ok: false, error: "no origin from step 01" };
  }

  const result = await discoverAgentManifest(origin);
  if (!result.ok) {
    return {
      ok: false,
      error: `manifest not found at any standard location for ${origin}`,
      tried: result.tried,
    };
  }

  const m = result.manifest;
  // Generic shape sanity — these are common across spec'd manifests.
  // Engine doesn't require ALL fields; just notes which are present.
  const present = {
    schema_version: typeof m.schema_version === "string",
    name: typeof m.name === "string",
    description: typeof m.description === "string",
    network: typeof m.network === "object" && m.network !== null,
    contracts: typeof m.contracts === "object" && m.contracts !== null,
    integration: typeof m.integration === "object" && m.integration !== null,
    capabilities: Array.isArray(m.capabilities),
    abi_endpoints: Array.isArray(m.abi_endpoints),
  };

  // Derive slug from name. If name is missing, fall back to URL hostname.
  const rawName = m.name || new URL(origin).hostname;
  const slug = slugify(rawName);

  return {
    ok: true,
    output: {
      manifestUrl: result.manifestUrl,
      manifest: m,
      slug,
      rawName,
      schemaVersion: m.schema_version || null,
      present,
      tried: result.tried,
    },
  };
}
