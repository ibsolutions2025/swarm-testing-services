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
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const PORT = Number(process.env.PORT || 7711);
const TOKEN = process.env.ONBOARDING_SERVER_TOKEN || "";

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
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${TOKEN}`;
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

  // Lib tree summary — file sizes only, not content (full content is fetched
  // separately via the bundle export endpoint at C.6).
  const libFiles = {};
  try {
    const entries = await readdir(libPath);
    for (const f of entries) {
      try {
        const s = await stat(join(libPath, f));
        if (s.isFile()) libFiles[f] = s.size;
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
    auditDoc,
    auditDocPath: auditPath,
    libPath,
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
