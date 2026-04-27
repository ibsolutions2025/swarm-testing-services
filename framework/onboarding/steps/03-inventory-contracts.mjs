/**
 * Step 03 — inventory-contracts.
 *
 * Parse the manifest's `contracts` map + `network` object. Build the
 * canonical contract inventory list the engine carries forward:
 *   { name, address, role?, abiUrl?, chainId, chainName, rpc }
 *
 * Two patterns we accept:
 *   - manifest.contracts is a flat object: { "JobNFT": "0x...", ... }
 *   - or wrapped: { "JobNFT": { address: "0x...", role: "marketplace" } }
 *     (some protocols use this shape — engine handles both)
 *
 * We also look for a sibling `abi_endpoints` array — when present, we map
 * each abi-endpoint URL back to its contract name by matching on the URL
 * path's last segment. That gives us the manifest-supplied ABI URL we'll
 * try first in step 04 (faster + doesn't depend on chain-explorer
 * verification).
 */

function extractAddress(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return value.address || value.addr || value.contract || null;
  }
  return null;
}

function extractRole(value) {
  if (value && typeof value === "object") {
    return value.role || value.kind || null;
  }
  return null;
}

function isHexAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

export async function run(ctx) {
  const manifest = ctx.steps?.["02-discover-manifest"]?.output?.manifest;
  if (!manifest) {
    return { ok: false, error: "no manifest from step 02" };
  }
  if (!manifest.contracts || typeof manifest.contracts !== "object") {
    return { ok: false, error: "manifest has no `contracts` field — protocol needs to add one before STS can onboard it" };
  }
  if (!manifest.network || typeof manifest.network !== "object") {
    return { ok: false, error: "manifest has no `network` field" };
  }

  const chainId = manifest.network.chainId || manifest.network.chain_id;
  const chainName = manifest.network.chain || manifest.network.name || "unknown";
  const rpc = manifest.network.rpc || manifest.network.rpc_url || null;
  if (!chainId) {
    return { ok: false, error: "manifest.network has no chainId" };
  }

  // Build address-by-name map
  const addressByName = {};
  const skipped = [];
  for (const [name, value] of Object.entries(manifest.contracts)) {
    const addr = extractAddress(value);
    if (!isHexAddress(addr)) {
      skipped.push({ name, reason: `non-address value (${typeof value})` });
      continue;
    }
    addressByName[name] = addr;
  }

  // Build manifest abi-endpoint map (last URL path segment → URL)
  const abiUrlByName = {};
  const abiEndpoints = Array.isArray(manifest.abi_endpoints) ? manifest.abi_endpoints : [];
  for (const url of abiEndpoints) {
    if (typeof url !== "string") continue;
    try {
      const u = new URL(url);
      const last = u.pathname.split("/").filter(Boolean).pop();
      if (last) abiUrlByName[last] = url;
    } catch {
      // skip malformed URL
    }
  }

  // Final inventory — a contract appears here only if we have its address
  const contracts = Object.entries(addressByName).map(([name, address]) => ({
    name,
    address,
    role: extractRole(manifest.contracts[name]),
    abiUrl: abiUrlByName[name] || null,
    chainId,
  }));

  return {
    ok: true,
    output: {
      chain: { id: chainId, name: chainName, rpc },
      contracts,
      skipped,
      total: contracts.length,
      withManifestAbiUrl: contracts.filter((c) => c.abiUrl).length,
    },
  };
}
