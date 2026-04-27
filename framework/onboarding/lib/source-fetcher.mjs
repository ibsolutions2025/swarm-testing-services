/**
 * source-fetcher.mjs — fetch verified contract source.
 *
 * Cascade (try in order, return first success):
 *   (a) GitHub via manifest.repository — read raw .sol files (preferred:
 *       protocol-author-vouched, no chain-explorer verification dependency)
 *   (b) GitHub heuristic — if manifest has `integration.mcp_server.repo`
 *       at github.com/<org>/<name>-mcp-server, infer parent contracts
 *       repo at github.com/<org>/<name> (works when the org follows the
 *       sibling-repo convention)
 *   (c) Chain explorer via Etherscan v2 unified — falls back when GitHub
 *       paths fail. Requires ETHERSCAN_API_KEY (v1 endpoints are deprecated
 *       since 2025).
 *   (d) Fail with a clear error directing the protocol author to add a
 *       `repository` field to their manifest.
 */

import { fetchJson, fetchPage } from "./url-crawler.mjs";

const EXPLORERS = {
  1:        { v1: "https://api.etherscan.io/api",          v2chain: 1 },
  11155111: { v1: "https://api-sepolia.etherscan.io/api",  v2chain: 11155111 },
  8453:     { v1: "https://api.basescan.org/api",          v2chain: 8453 },
  84532:    { v1: "https://api-sepolia.basescan.org/api",  v2chain: 84532 },
  137:      { v1: "https://api.polygonscan.com/api",       v2chain: 137 },
  42161:    { v1: "https://api.arbiscan.io/api",           v2chain: 42161 },
  10:       { v1: "https://api-optimistic.etherscan.io/api", v2chain: 10 },
};

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

function pickApiKey() {
  return (
    process.env.ETHERSCAN_API_KEY ||
    process.env.BASESCAN_API_KEY ||
    process.env.POLYGONSCAN_API_KEY ||
    ""
  );
}

function parseSourcePayload(rawSource) {
  // Single-file: rawSource is a Solidity string starting with "//" or "pragma" or "// SPDX..."
  const trimmed = String(rawSource || "").trim();
  if (!trimmed) return { ok: false, files: {}, error: "empty source" };
  // Multi-file hardhat-style: starts with "{{" and ends with "}}"
  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    try {
      const inner = trimmed.slice(1, -1); // strip outer braces
      const obj = JSON.parse(inner);
      const sources = obj.sources || {};
      const files = {};
      for (const [name, val] of Object.entries(sources)) {
        files[name] = (val && val.content) || "";
      }
      return { ok: true, files, format: "hardhat-multi" };
    } catch (e) {
      // fall through
    }
  }
  // Multi-file simple JSON: starts with "{" and contains "language"/"sources"
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.sources && typeof obj.sources === "object") {
        const files = {};
        for (const [name, val] of Object.entries(obj.sources)) {
          files[name] = (val && val.content) || "";
        }
        return { ok: true, files, format: "json-multi" };
      }
    } catch (e) {
      // fall through
    }
  }
  // Single-file (most common for simple contracts)
  return { ok: true, files: { "Contract.sol": trimmed }, format: "single" };
}

// ─── GitHub source path ──────────────────────────────────────────────
//
// Given a github URL like "https://github.com/owner/repo" and a contract
// name (e.g. "JobNFT"), find the matching .sol file and return its raw
// contents. Strategy:
//   1. List the repo's `contracts/` directory via GitHub Tree API
//   2. Find files whose name contains the contract name (case-insensitive,
//      so "JobNFT" matches "JobNFTv15.sol", "JobNFTV12.sol", etc.)
//   3. Prefer the longest match (closest to the literal name + version)
//   4. Fetch raw via raw.githubusercontent.com
//
// Defaults to `contracts/` path; falls through to repo root + `src/` if
// the tree API doesn't list a contracts dir.

function parseGithubRepo(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/github\.com[\/:]([\w.\-]+)\/([\w.\-]+?)(?:\.git|\/|$)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function pickGithubToken() {
  // Prefer the explicit RW PAT from secrets/github.env; fall back to
  // generic env names if the operator set them differently. The Cowork
  // harness sometimes pre-populates GH_TOKEN with a sandbox-only token
  // that doesn't have org access — that's why GITHUB_PAT_RW is preferred.
  return (
    process.env.GITHUB_PAT_RW ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    ""
  );
}

async function fetchGithubTree(owner, repo, branch = "main") {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const headers = { "User-Agent": "STS-OnboardingEngine/0.1", Accept: "application/vnd.github+json" };
  const token = pickGithubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    if (r.status === 404 && branch === "main") {
      return await fetchGithubTree(owner, repo, "master");
    }
    return { ok: false, error: `GitHub tree ${r.status}` };
  }
  const json = await r.json();
  return { ok: true, branch, tree: json.tree || [] };
}

async function fetchGithubRaw(owner, repo, branch, path) {
  // Private repos require auth headers even on raw.githubusercontent.com;
  // pass the same token here.
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  const token = pickGithubToken();
  const headers = { "User-Agent": "STS-OnboardingEngine/0.1" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers });
  if (!r.ok) return { ok: false, error: `raw ${r.status} for ${path}` };
  const body = await r.text();
  return { ok: true, content: body };
}

function pickBestSolFile(tree, contractName) {
  // Filter to .sol files (any depth)
  const solFiles = tree.filter((t) => t.type === "blob" && /\.sol$/i.test(t.path));
  if (!solFiles.length) return null;
  const lower = contractName.toLowerCase();

  // Score each candidate. Heuristics:
  //   + base prefix match (file STARTS with the contract name)
  //   + file lives in `contracts/` or `src/` (not nested deep)
  //   + has a version suffix like "v15", "V12" — prefer LATEST (= highest digit sequence)
  //   - in `archive/`, `legacy/`, `old/`, `deprecated/`, `_backup/` paths (these are intentional retired versions)
  //   - stub/interface files (start with `I` and shorter than the canonical name)
  let best = null, bestScore = -Infinity, bestVersion = -1;
  for (const f of solFiles) {
    const path = f.path;
    const basename = path.split("/").pop().toLowerCase();
    if (!basename.includes(lower)) continue;
    let score = 0;
    if (basename.startsWith(lower)) score += 10;
    if (path.startsWith("contracts/") || /^contracts\//i.test(path)) score += 5;
    if (path.startsWith("src/") || /^src\//i.test(path)) score += 3;
    // Penalize archived / legacy paths heavily — these are explicitly
    // retired versions and the protocol's "current" contract is somewhere else
    if (/\/(archive|legacy|old|deprecated|_backup|backup|.bak)\//i.test(path)) score -= 50;
    if (/\.bak$/i.test(path)) score -= 50;
    // Extract version suffix if present (e.g. "JobNFTv15.sol" → 15)
    const ver = (basename.match(/v(\d+)\.sol$/i) || [])[1];
    const verNum = ver ? parseInt(ver, 10) : -1;
    if (verNum > 0) score += verNum; // prefer higher versions
    score += 100 - basename.length; // shorter ≈ closer to canonical when no version
    // Tiebreaker: pick higher version
    if (score > bestScore || (score === bestScore && verNum > bestVersion)) {
      bestScore = score;
      bestVersion = verNum;
      best = f;
    }
  }
  return best;
}

export async function fetchContractSourceFromGithub(repoUrl, contractName) {
  const parsed = parseGithubRepo(repoUrl);
  if (!parsed) {
    return { ok: false, error: `bad github url "${repoUrl}"` };
  }
  const tree = await fetchGithubTree(parsed.owner, parsed.repo);
  if (!tree.ok) return tree;
  const file = pickBestSolFile(tree.tree, contractName);
  if (!file) {
    return {
      ok: false,
      error: `no .sol file matching "${contractName}" in ${parsed.owner}/${parsed.repo} (tree has ${tree.tree.filter((t) => /\.sol$/i.test(t.path)).length} .sol files)`,
    };
  }
  const raw = await fetchGithubRaw(parsed.owner, parsed.repo, tree.branch, file.path);
  if (!raw.ok) return raw;
  return {
    ok: true,
    contractName,
    files: { [file.path]: raw.content },
    format: "github-raw",
    source: `github:${parsed.owner}/${parsed.repo}#${tree.branch}/${file.path}`,
  };
}

/**
 * Heuristic: given an MCP server repo URL like
 * github.com/owner/<protocolname>-mcp-server, return the inferred parent
 * contracts repo URL. AWP follows this convention — ibsolutions2025/awp-mcp-server
 * sits next to ibsolutions2025/agentwork-protocol.
 *
 * Only emits a candidate URL — caller decides whether to try it.
 */
export function inferContractsRepoFromMcpRepo(mcpRepoUrl) {
  const parsed = parseGithubRepo(mcpRepoUrl);
  if (!parsed) return null;
  // Strip "-mcp-server" or "-mcp" suffix; that's our inference signal.
  const stripped = parsed.repo
    .replace(/-mcp-server$/i, "")
    .replace(/-mcp$/i, "")
    .replace(/-server$/i, "");
  if (stripped === parsed.repo) return null; // no transformation made
  return `https://github.com/${parsed.owner}/${stripped}`;
}

/**
 * Cascade source resolver. opts.contractName + opts.manifestRepository +
 * opts.mcpServerRepo direct the engine; only chainId+address are required.
 *
 * Strategy order:
 *   (a) opts.manifestRepository → GitHub raw .sol
 *   (b) inferred contracts repo from opts.mcpServerRepo
 *   (c) chain-explorer (Etherscan v2 unified, then v1)
 *   (d) clear error
 */
export async function fetchContractSource(chainId, address, opts = {}) {
  const errors = [];

  // ─── (a) manifest.repository → GitHub raw ────────────────────────
  if (opts.manifestRepository && opts.contractName) {
    const r = await fetchContractSourceFromGithub(opts.manifestRepository, opts.contractName);
    if (r.ok) return r;
    errors.push(`manifest-repo: ${r.error}`);
  }

  // ─── (b) infer contracts repo from MCP server repo ───────────────
  if (opts.mcpServerRepo && opts.contractName) {
    const inferred = inferContractsRepoFromMcpRepo(opts.mcpServerRepo);
    if (inferred) {
      const r = await fetchContractSourceFromGithub(inferred, opts.contractName);
      if (r.ok) return { ...r, source: r.source + " (inferred from mcp-server-repo)" };
      errors.push(`inferred-repo (${inferred}): ${r.error}`);
    }
  }

  // ─── (c) chain explorer ─────────────────────────────────────────
  const ex = EXPLORERS[Number(chainId)];
  const apiKey = pickApiKey();
  if (ex) {
    const v2Url =
      `${ETHERSCAN_V2}` +
      `?chainid=${ex.v2chain}` +
      `&module=contract&action=getsourcecode` +
      `&address=${address}` +
      (apiKey ? `&apikey=${apiKey}` : "");
    const v2 = await fetchJson(v2Url);
    if (
      v2.ok && v2.json &&
      String(v2.json.status) === "1" &&
      Array.isArray(v2.json.result) && v2.json.result.length
    ) {
      const r = v2.json.result[0];
      if (r.SourceCode) {
        const parsed = parseSourcePayload(r.SourceCode);
        if (parsed.ok) {
          return {
            ok: true,
            contractName: r.ContractName || null,
            compilerVersion: r.CompilerVersion || null,
            files: parsed.files,
            format: parsed.format,
            source: "etherscan-v2",
          };
        }
      }
    }
    if (v2.ok && v2.json) {
      errors.push(`etherscan-v2: ${v2.json.message || v2.json.result || "unknown"}`);
    } else if (v2.error) {
      errors.push(`etherscan-v2: ${v2.error}`);
    }

    // v1 fallback (deprecated since 2025; kept as last-ditch attempt)
    const v1Url = `${ex.v1}?module=contract&action=getsourcecode&address=${address}` + (apiKey ? `&apikey=${apiKey}` : "");
    const v1 = await fetchJson(v1Url);
    if (
      v1.ok && v1.json &&
      String(v1.json.status) === "1" &&
      Array.isArray(v1.json.result) && v1.json.result.length
    ) {
      const r = v1.json.result[0];
      if (r.SourceCode) {
        const parsed = parseSourcePayload(r.SourceCode);
        if (parsed.ok) {
          return {
            ok: true,
            contractName: r.ContractName || null,
            compilerVersion: r.CompilerVersion || null,
            files: parsed.files,
            format: parsed.format,
            source: "explorer-v1",
          };
        }
      }
    }
    if (v1.ok && v1.json) {
      errors.push(`explorer-v1: ${v1.json.message || v1.json.result || "unknown"}`);
    } else if (v1.error) {
      errors.push(`explorer-v1: ${v1.error}`);
    }
  } else {
    errors.push(`no chain explorer registered for chainId ${chainId}`);
  }

  // ─── (d) clear error directing to a fix ─────────────────────────
  return {
    ok: false,
    error:
      `Engine couldn't locate contract source for ${opts.contractName || address}. ` +
      `Tried: ${errors.join(" | ")}. ` +
      `Suggest adding a "repository" field to your protocol's .well-known/agent.json ` +
      `pointing at the github repo containing the .sol files.`,
  };
}
