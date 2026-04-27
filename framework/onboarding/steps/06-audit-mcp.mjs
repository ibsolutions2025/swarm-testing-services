/**
 * Step 06 — audit-mcp.
 *
 * Mechanical: read manifest.integration.mcp_server (if present) and record
 * its install path, version, tool list, and coverage URL. No LLM — the
 * payload is structured already.
 *
 * Phase B v1 does NOT npm-install + smoke-test the MCP server (that's a
 * follow-up that needs sandboxed execution). It records what the manifest
 * advertises so step 12 can include MCP coverage in the audit doc.
 */

export async function run(ctx) {
  const manifest = ctx.steps?.["02-discover-manifest"]?.output?.manifest;
  if (!manifest) return { ok: false, error: "no manifest from step 02" };

  const integration = manifest.integration || {};
  const mcp = integration.mcp_server || null;

  if (!mcp) {
    return {
      ok: true,
      output: {
        present: false,
        finding: {
          category: "mcp_product_gap",
          severity: "medium",
          description: "Manifest has no integration.mcp_server entry. Onboarding tools cannot discover the protocol's MCP server without it.",
        },
      },
    };
  }

  const tools = Array.isArray(mcp.tools) ? mcp.tools : [];
  const out = {
    present: true,
    name: mcp.name || null,
    description: mcp.description || null,
    status: mcp.status || null,
    version: mcp.version || null,
    npmInstall: mcp.npm_install || null,
    npmUrl: mcp.npm_url || null,
    repo: mcp.repo || null,
    toolCount: tools.length,
    tools,
    contractsVersion: mcp.awp_contracts_version || mcp.contracts_version || null,
    installDocsUrl: mcp.install_docs || null,
    coverageAuditUrl: mcp.coverage_audit || null,
  };

  // Heuristic findings the engine surfaces directly from manifest data
  const findings = [];
  if (out.status && out.status !== "published") {
    findings.push({
      category: "mcp_product_gap",
      severity: "medium",
      description: `MCP server status is "${out.status}" — onboarding tools may not find an installable package. Publish to npm and update manifest.status to "published".`,
    });
  }
  if (out.toolCount === 0) {
    findings.push({
      category: "mcp_product_gap",
      severity: "high",
      description: "MCP server declares zero tools. Either the server has no implemented tools, or the manifest's `integration.mcp_server.tools` array is empty.",
    });
  }
  out.findings = findings;

  return { ok: true, output: out };
}
