import fs from "fs/promises";
import path from "path";

/**
 * Server-only filesystem reader for the 7 awp-test-N agent dirs.
 *
 * Layout on disk:
 *   agents/awp-test-<n>/IDENTITY.md   (required — holds Name + wallet)
 *   agents/awp-test-<n>/SOUL.md       (optional — may be absent post-scrub)
 *   agents/awp-test-<n>/USER.md       (optional)
 *   agents/awp-test-<n>/openclaw.json (optional — stripped in scrubbed mirrors)
 *
 * The personas tab is hardcoded to project_id='awp' for now; when STS
 * generalizes, this module moves into a per-project resolver keyed by DB
 * config instead of the flat filesystem.
 */

const AGENTS_DIR = path.join(process.cwd(), "agents");

// Fallback names in case IDENTITY.md is missing or unparseable. These match
// the authoritative names written into each agent's IDENTITY.md today.
const PERSONA_FALLBACK: Record<number, string> = {
  1: "Spark",
  2: "Grind",
  3: "Judge",
  4: "Chaos",
  5: "Scout",
  6: "Flash",
  7: "Bridge"
};

export interface AgentDoc {
  name: string; // e.g. "awp-test-1"
  persona: string; // e.g. "Spark"
  wallet: string | null; // 0x… hex or null if missing
  model: string | null; // from openclaw.json if present
  identity_md: string;
  soul_md: string;
  user_md: string;
  openclaw_json: Record<string, unknown> | null;
  missing: string[]; // names of expected files that weren't on disk
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

function parseIdentity(content: string): { persona: string | null; wallet: string | null } {
  let persona: string | null = null;
  let wallet: string | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!persona) {
      const m = line.match(/^Name:\s*(\S.*?)\s*$/i);
      if (m) persona = m[1];
    }
    if (!wallet) {
      const m = line.match(/^Address:\s*(0x[a-fA-F0-9]{40})\s*$/);
      if (m) wallet = m[1];
    }
    if (persona && wallet) break;
  }
  return { persona, wallet };
}

export async function getAgent(name: string): Promise<AgentDoc | null> {
  const match = name.match(/^awp-test-([1-7])$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);

  const dir = path.join(AGENTS_DIR, name);
  const [identity, soul, user, openclawRaw] = await Promise.all([
    readIfExists(path.join(dir, "IDENTITY.md")),
    readIfExists(path.join(dir, "SOUL.md")),
    readIfExists(path.join(dir, "USER.md")),
    readIfExists(path.join(dir, "openclaw.json"))
  ]);

  // Agent dir missing entirely.
  if (identity === null && soul === null && user === null) return null;

  const parsed = identity ? parseIdentity(identity) : { persona: null, wallet: null };

  let openclaw_json: Record<string, unknown> | null = null;
  let model: string | null = null;
  if (openclawRaw) {
    try {
      openclaw_json = JSON.parse(openclawRaw);
      const m = (openclaw_json as any)?.model;
      if (typeof m === "string") model = m;
    } catch {
      // Ignore parse errors — fall through with null.
    }
  }

  const missing: string[] = [];
  if (identity === null) missing.push("IDENTITY.md");
  if (soul === null) missing.push("SOUL.md");
  if (user === null) missing.push("USER.md");
  if (openclawRaw === null) missing.push("openclaw.json");

  return {
    name,
    persona: parsed.persona || PERSONA_FALLBACK[n] || name,
    wallet: parsed.wallet,
    model,
    identity_md: identity ?? "",
    soul_md: soul ?? "",
    user_md: user ?? "",
    openclaw_json,
    missing
  };
}

export async function getAwpAgents(): Promise<AgentDoc[]> {
  const names = ["awp-test-1", "awp-test-2", "awp-test-3", "awp-test-4", "awp-test-5", "awp-test-6", "awp-test-7"];
  const bundle = await Promise.all(names.map((n) => getAgent(n)));
  return bundle.filter((a): a is AgentDoc => a !== null);
}
