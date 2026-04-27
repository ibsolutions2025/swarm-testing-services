/**
 * abi-fetcher.mjs — chain-explorer-aware ABI fetcher for the Onboarding Engine.
 *
 * Knows nothing about any specific protocol. Maps chainId → explorer API
 * endpoint via a generic registry (Etherscan v2 unified API is the modern
 * single endpoint; per-chain Basescan/Polygonscan/etc. are kept as
 * fallbacks because some chains haven't migrated yet).
 *
 * Always returns ABI as an array (Etherscan returns it as a JSON-encoded
 * string inside the result envelope; we unwrap that here).
 *
 * API key support is opt-in via env vars (ETHERSCAN_API_KEY for v2 unified;
 * per-chain BASESCAN_API_KEY etc. for legacy endpoints). Without a key the
 * public rate limit is 5 req/sec which is plenty for typical 5-15 contract
 * inventories.
 */

import { fetchJson } from "./url-crawler.mjs";

// Generic chainId → explorer registry. Add more entries as needed; nothing
// in this map is AWP-specific (Etherscan/Basescan/Polygonscan are public
// chain explorers used by countless protocols).
const EXPLORERS = {
  // Ethereum mainnet
  1:     { name: "etherscan",  v1: "https://api.etherscan.io/api",          v2chain: 1 },
  // Sepolia
  11155111: { name: "etherscan-sepolia", v1: "https://api-sepolia.etherscan.io/api", v2chain: 11155111 },
  // Base mainnet
  8453:  { name: "basescan",   v1: "https://api.basescan.org/api",          v2chain: 8453 },
  // Base Sepolia
  84532: { name: "basescan-sepolia", v1: "https://api-sepolia.basescan.org/api", v2chain: 84532 },
  // Polygon mainnet
  137:   { name: "polygonscan", v1: "https://api.polygonscan.com/api",      v2chain: 137 },
  // Polygon Mumbai (deprecated but present in some manifests)
  80001: { name: "polygonscan-mumbai", v1: "https://api-testnet.polygonscan.com/api", v2chain: 80001 },
  // Arbitrum One
  42161: { name: "arbiscan",   v1: "https://api.arbiscan.io/api",           v2chain: 42161 },
  // Optimism
  10:    { name: "optimistic-etherscan", v1: "https://api-optimistic.etherscan.io/api", v2chain: 10 },
};

const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";

function chainKey(chainId) {
  return EXPLORERS[Number(chainId)] || null;
}

function pickApiKey() {
  // Prefer the unified Etherscan v2 key; per-chain keys are a backup. Both
  // optional — public endpoints work without keys at 5 req/sec.
  return (
    process.env.ETHERSCAN_API_KEY ||
    process.env.BASESCAN_API_KEY ||
    process.env.POLYGONSCAN_API_KEY ||
    ""
  );
}

/**
 * Fetch the ABI for a single contract. Tries Etherscan v2 unified API
 * first (works for most chains with a single key), falls back to the
 * legacy per-chain endpoint if v2 doesn't have the chain.
 *
 * Returns { ok, abi, source, error }.
 *   ok: bool
 *   abi: array  (parsed from JSON-string response)
 *   source: 'etherscan-v2' | '<explorer-name>' | 'manifest'
 *   error: string (when ok=false)
 */
export async function fetchAbiFromExplorer(chainId, address) {
  const ex = chainKey(chainId);
  if (!ex) {
    return {
      ok: false,
      abi: null,
      source: "no-explorer",
      error: `no explorer registered for chainId ${chainId}`,
    };
  }
  const apiKey = pickApiKey();
  // Try Etherscan v2 unified
  const v2Url =
    `${ETHERSCAN_V2}` +
    `?chainid=${ex.v2chain}` +
    `&module=contract&action=getabi` +
    `&address=${address}` +
    (apiKey ? `&apikey=${apiKey}` : "");
  let v2 = await fetchJson(v2Url);
  if (
    v2.ok &&
    v2.json &&
    String(v2.json.status) === "1" &&
    typeof v2.json.result === "string"
  ) {
    try {
      const abi = JSON.parse(v2.json.result);
      if (Array.isArray(abi)) return { ok: true, abi, source: "etherscan-v2" };
    } catch (e) {
      // fall through to v1
    }
  }
  // Fall back to legacy per-chain endpoint
  const v1Url =
    `${ex.v1}?module=contract&action=getabi&address=${address}` +
    (apiKey ? `&apikey=${apiKey}` : "");
  let v1 = await fetchJson(v1Url);
  if (
    v1.ok &&
    v1.json &&
    String(v1.json.status) === "1" &&
    typeof v1.json.result === "string"
  ) {
    try {
      const abi = JSON.parse(v1.json.result);
      if (Array.isArray(abi)) return { ok: true, abi, source: ex.name };
    } catch (e) {
      // give up
    }
  }
  // Synthesize an error message from whichever response had useful info
  const detail =
    (v2.json && v2.json.message) ||
    (v2.json && v2.json.result) ||
    v2.error ||
    (v1.json && v1.json.message) ||
    (v1.json && v1.json.result) ||
    v1.error ||
    "unknown explorer error";
  return {
    ok: false,
    abi: null,
    source: "explorer-failed",
    error: `${ex.name}: ${String(detail).slice(0, 200)}`,
  };
}

/**
 * Fetch ABI from a manifest-supplied URL. Used as the primary path when
 * the protocol's manifest lists `abi_endpoints` (the URL hands back ABI
 * JSON directly, which is faster + doesn't depend on the contract being
 * verified on Etherscan/Basescan).
 *
 * Tolerates both shapes:
 *   - bare ABI array: [...]
 *   - wrapped: { abi: [...] } or { result: [...] }
 */
export async function fetchAbiFromManifestUrl(url) {
  const r = await fetchJson(url);
  if (!r.ok) {
    return { ok: false, abi: null, source: "manifest", error: r.error };
  }
  const j = r.json;
  if (Array.isArray(j)) return { ok: true, abi: j, source: "manifest" };
  if (j && Array.isArray(j.abi)) return { ok: true, abi: j.abi, source: "manifest" };
  if (j && Array.isArray(j.result)) return { ok: true, abi: j.result, source: "manifest" };
  return {
    ok: false,
    abi: null,
    source: "manifest",
    error: `manifest URL ${url} returned unexpected shape (keys: ${j ? Object.keys(j).join(",") : "n/a"})`,
  };
}

/**
 * Best-effort ABI fetch for one (contractName, address) pair.
 * Tries manifest URL first if available, then chain explorer, then
 * the alternate of whichever didn't work.
 */
export async function fetchAbi({ chainId, address, manifestAbiUrl = null }) {
  if (manifestAbiUrl) {
    const m = await fetchAbiFromManifestUrl(manifestAbiUrl);
    if (m.ok) return m;
  }
  const e = await fetchAbiFromExplorer(chainId, address);
  if (e.ok) return e;
  if (manifestAbiUrl) {
    // Manifest already failed at start; report explorer error as the headline
    return e;
  }
  return e;
}

export const KNOWN_CHAINS = Object.fromEntries(
  Object.entries(EXPLORERS).map(([id, e]) => [id, e.name])
);
