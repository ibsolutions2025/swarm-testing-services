#!/usr/bin/env node
/**
 * server.mjs — VPS HTTP wrapper for the Onboarding Engine (Phase C.3).
 *
 * The dashboard's POST /api/onboarding inserts an onboarding_runs row +
 * fires this endpoint. We spawn engine.mjs as a detached child so the HTTP
 * call returns in <100ms while the 7-min run continues in the background.
 *
 * Engine progress streams to Supabase via lib/progress-emitter.mjs (already
 * wired in engine.mjs). The dashboard polls Supabase, NOT this server, for
 * step updates. This server only handles spawn + result-fetch + health.
 *
 * Auth: shared bearer token. The dashboard signs requests with
 * Authorization: Bearer <ONBOARDING_SERVER_TOKEN>. If the token isn't set,
 * the server refuses every request.
 *
 * Endpoints:
 *   POST /onboarding/start  { runId, url, userId }       -> 202 spawned
 *   GET  /onboarding/result/:runId                        -> 200 { auditDoc, lib }
 *   GET  /onboarding/health                               -> 200 { ok: true }
 *
 * Run as pm2 entry on the VPS:
 *   ONBOARDING_SERVER_TOKEN=<secret> \
 *   STS_SUPABASE_URL=... STS_SUPABASE_KEY=... \
 *   ANTHROPIC_API_KEY=... GITHUB_PAT_RW=... \
 *     pm2 start framework/onboarding/server.mjs --name onboarding-server
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir, stat, mkdir, writeFile, rm, cp } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const PORT = Number(process.env.PORT || 7711);
const TOKEN = (process.env.ONBOARDING_SERVER_TOKEN || "").trim();

if (!TOKEN) {
  console.error("ONBOARDING_SERVER_TOKEN is not set — refusing to start. Generate a 32+ byte secret and set this env var.");
  process.exit(1);
}

function unauthorized(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

function badRequest(res, msg) {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}

function notFound(res, msg) {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg || "not found" }));
}

function serverError(res, msg) {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}

function checkAuth(req) {
  const raw = String(req.headers["authorization"] || "").trim();
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return Boolean(m && m[1].trim() === TOKEN);
}

async function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { rejectBody(new Error("invalid JSON body")); }
    });
    req.on("error", rejectBody);
  });
}

function sanitizeRunId(s) {
  // run_id from the dashboard is user-controlled; ensure it's safe to use as
  // a filesystem path component and as an argv value.
  return /^[a-zA-Z0-9._-]+$/.test(s) ? s : null;
}

/**
 * Start an engine run. Returns 202 immediately; engine runs detached.
 * Engine itself emits progress to Supabase via progress-emitter.mjs.
 */
async function handleStart(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }

  const { runId, url, userId } = body || {};
  if (!runId || !url) return badRequest(res, "runId and url are required");
  const safeRunId = sanitizeRunId(String(runId));
  if (!safeRunId) return badRequest(res, "invalid runId (allowed: [A-Za-z0-9._-]+)");
  try {
    const u = new URL(String(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    return badRequest(res, "url must be http(s)");
  }

  const enginePath = resolve(__dirname, "engine.mjs");
  const args = [enginePath, String(url), "--run-id", safeRunId];

  // Detached spawn so the engine survives this request. We pipe to /dev/null
  // (server's stdout); progress goes to Supabase.
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log(`[onboarding-server] spawned engine pid=${child.pid} runId=${safeRunId} url=${url} userId=${userId || "(none)"}`);

  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    runId: safeRunId,
    pid: child.pid,
    note: "engine spawned; poll Supabase onboarding_step_events for progress",
  }));
}

/**
 * Read engine output for a completed run.
 * Returns audit doc + lib tree summary (file counts, not full content).
 */
async function handleResult(req, res, runId) {
  const safeRunId = sanitizeRunId(runId);
  if (!safeRunId) return badRequest(res, "invalid runId");

  const outDir = resolve(__dirname, "runs", safeRunId, "output");
  let outDirExists = false;
  try { outDirExists = (await stat(outDir)).isDirectory(); } catch { outDirExists = false; }
  if (!outDirExists) return notFound(res, `no output for run "${safeRunId}"`);

  // Find the slug — there's one subdir under lib/ named after the discovered slug.
  let slug = null;
  try {
    const libEntries = await readdir(join(outDir, "lib"));
    slug = libEntries[0] || null;
  } catch { /* lib dir missing */ }

  if (!slug) return notFound(res, `no slug found in ${outDir}/lib`);

  const libPath = join(outDir, "lib", slug);
  const auditPath = join(outDir, "clients", slug, "AUDIT-AND-DESIGN.md");

  // Lib tree summary — sizes + FULL contents for every file. C.5 needs
  // matrix/scenarios/rules to render the editor; C.7 needs everything for
  // the cutover write; C.6 needs everything for the bundle export. Total
  // size is small (~80KB across 8 files) so always returning content is
  // simpler than juggling multiple endpoints.
  const libFiles = {};
  const libContents = {};
  try {
    const entries = await readdir(libPath);
    for (const f of entries) {
      try {
        const filePath = join(libPath, f);
        const s = await stat(filePath);
        if (!s.isFile()) continue;
        libFiles[f] = s.size;
        libContents[f] = await readFile(filePath, "utf8");
      } catch { /* skip */ }
    }
  } catch { /* lib subdir missing */ }

  // Audit doc — read the markdown verbatim (typical: 5-15 KB).
  let auditDoc = null;
  try { auditDoc = await readFile(auditPath, "utf8"); } catch { /* no audit doc */ }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    runId: safeRunId,
    slug,
    libFiles,
    libContents,
    auditDoc,
    auditDocPath: auditPath,
    libPath,
  }));
}

/**
 * Cutover handler — write the customer's edited engine output to the canonical
 * lib/<targetSlug>/ + clients/<targetSlug>/ paths on the VPS. C.7 of Phase C.
 *
 * Body: {
 *   runId,                 // source run id; we read from runs/<runId>/output/
 *   sourceSlug,            // engine-discovered slug (e.g. "agentwork-protocol")
 *   targetLibDir,          // relative path: "lib/agentwork-protocol-23becc"
 *   targetClientsDir,      // relative path: "clients/agentwork-protocol-23becc"
 *   files,                 // map of relpath-within-target → full content;
 *                          //   keys must start with targetLibDir or targetClientsDir
 * }
 *
 * Strategy:
 * 1. Resolve source dir (runs/<runId>/output/lib/<sourceSlug>/ +
 *    runs/<runId>/output/clients/<sourceSlug>/) — must exist
 * 2. Resolve target dirs (relative to REPO_ROOT)
 * 3. Wipe + recreate target dirs (idempotent — re-cutover replaces)
 * 4. For each file in source dir, write the override (if provided) or
 *    copy verbatim
 * 5. Return { libFiles, clientsFiles, libDir, clientsDir }
 *
 * Path safety: targetLibDir/targetClientsDir must:
 *   - be relative (no leading slash)
 *   - resolve under REPO_ROOT
 *   - match the dashboard's regex shape so clients can't write arbitrary paths
 */
function safeRelPath(p) {
  if (!p || typeof p !== "string") return null;
  if (p.startsWith("/") || p.startsWith("\\")) return null;
  if (p.includes("..")) return null;
  if (!/^(lib|clients)\/[a-zA-Z0-9._-]+\/?$/.test(p)) return null;
  return p.replace(/\/+$/, "");
}

async function handleCutover(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return badRequest(res, e.message); }
  const { runId, sourceSlug, targetLibDir, targetClientsDir, files } = body || {};
  if (!runId || !sourceSlug) return badRequest(res, "runId and sourceSlug required");
  const safeRunId = sanitizeRunId(String(runId));
  if (!safeRunId) return badRequest(res, "invalid runId");
  if (!/^[a-zA-Z0-9._-]+$/.test(String(sourceSlug))) return badRequest(res, "invalid sourceSlug");
  const libRel = safeRelPath(targetLibDir);
  const clientsRel = safeRelPath(targetClientsDir);
  if (!libRel || !clientsRel) return badRequest(res, "targetLibDir/targetClientsDir invalid");
  if (!files || typeof files !== "object") return badRequest(res, "files map required");

  const sourceLib = resolve(__dirname, "runs", safeRunId, "output", "lib", String(sourceSlug));
  const sourceClients = resolve(__dirname, "runs", safeRunId, "output", "clients", String(sourceSlug));
  let sourceLibOk = false, sourceClientsOk = false;
  try { sourceLibOk = (await stat(sourceLib)).isDirectory(); } catch {}
  try { sourceClientsOk = (await stat(sourceClients)).isDirectory(); } catch {}
  if (!sourceLibOk) return notFound(res, `source lib dir missing: ${sourceLib}`);

  const targetLib = resolve(REPO_ROOT, libRel);
  const targetClients = resolve(REPO_ROOT, clientsRel);
  // Sanity: target paths must be inside REPO_ROOT (prevent escapes via symlinks
  // even if regex passed)
  if (!targetLib.startsWith(REPO_ROOT) || !targetClients.startsWith(REPO_ROOT)) {
    return badRequest(res, "target paths escape REPO_ROOT");
  }

  // Wipe + recreate target dirs (idempotent — re-greenlight overwrites)
  await rm(targetLib, { recursive: true, force: true });
  await rm(targetClients, { recursive: true, force: true });
  await mkdir(targetLib, { recursive: true });
  await mkdir(targetClients, { recursive: true });

  // Build override key set (relpath → content)
  const overrideMap = new Map();
  for (const [k, v] of Object.entries(files)) {
    if (typeof v !== "string") continue;
    overrideMap.set(String(k).replace(/\\/g, "/"), v);
  }

  // Copy lib files: for each file in source lib, write override or original
  const libWritten = [];
  for (const f of await readdir(sourceLib)) {
    const stat1 = await stat(join(sourceLib, f));
    if (!stat1.isFile()) continue;
    const targetRelKey = `${libRel}/${f}`;
    const targetPath = join(targetLib, f);
    if (overrideMap.has(targetRelKey)) {
      await writeFile(targetPath, overrideMap.get(targetRelKey), "utf8");
    } else {
      const content = await readFile(join(sourceLib, f), "utf8");
      await writeFile(targetPath, content, "utf8");
    }
    libWritten.push(f);
  }

  // Copy clients files (typically just AUDIT-AND-DESIGN.md)
  const clientsWritten = [];
  if (sourceClientsOk) {
    for (const f of await readdir(sourceClients)) {
      const stat2 = await stat(join(sourceClients, f));
      if (!stat2.isFile()) continue;
      const targetRelKey = `${clientsRel}/${f}`;
      const targetPath = join(targetClients, f);
      if (overrideMap.has(targetRelKey)) {
        await writeFile(targetPath, overrideMap.get(targetRelKey), "utf8");
      } else {
        const content = await readFile(join(sourceClients, f), "utf8");
        await writeFile(targetPath, content, "utf8");
      }
      clientsWritten.push(f);
    }
  }

  // Also write any override-only files (e.g. dashboard generated something
  // not in source — defensive, currently unused)
  for (const [k, v] of overrideMap.entries()) {
    if (k.startsWith(libRel + "/")) {
      const f = k.slice(libRel.length + 1);
      if (!libWritten.includes(f)) {
        await writeFile(join(targetLib, f), v, "utf8");
        libWritten.push(f);
      }
    } else if (k.startsWith(clientsRel + "/")) {
      const f = k.slice(clientsRel.length + 1);
      if (!clientsWritten.includes(f)) {
        await writeFile(join(targetClients, f), v, "utf8");
        clientsWritten.push(f);
      }
    }
  }

  console.log(`[onboarding-server] cutover runId=${safeRunId} → ${libRel} (${libWritten.length} files), ${clientsRel} (${clientsWritten.length} files)`);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    libDir: libRel,
    clientsDir: clientsRel,
    libFiles: libWritten,
    clientsFiles: clientsWritten,
  }));
}

const httpServer = createServer(async (req, res) => {
  // Trim query string + trailing slash for matching
  const path = (req.url || "").split("?")[0].replace(/\/+$/, "") || "/";

  if (path === "/onboarding/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
  }

  if (!checkAuth(req)) return unauthorized(res);

  try {
    if (path === "/onboarding/start" && req.method === "POST") {
      return await handleStart(req, res);
    }
    if (path === "/onboarding/cutover" && req.method === "POST") {
      return await handleCutover(req, res);
    }
    if (req.method === "GET") {
      const m = path.match(/^\/onboarding\/result\/([a-zA-Z0-9._-]+)$/);
      if (m) return await handleResult(req, res, m[1]);
    }
  } catch (e) {
    console.error("[onboarding-server]", e);
    return serverError(res, e.message);
  }

  notFound(res);
});

httpServer.listen(PORT, () => {
  console.log(`onboarding-server listening on :${PORT} (token configured)`);
});
