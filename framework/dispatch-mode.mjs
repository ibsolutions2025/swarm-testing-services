const ALLOWED_MODES = new Set(["dryrun", "cli", "http"]);

export function resolveDispatchMode({ argv = process.argv, env = process.env } = {}) {
  if (Array.isArray(argv) && argv.includes("--dry-run")) return "dryrun";

  const configured = String(env.DISPATCH_MODE || env.HLO_DISPATCH_MODE || "dryrun")
    .trim()
    .toLowerCase();
  return ALLOWED_MODES.has(configured) ? configured : "dryrun";
}

export function dispatchWritesEnabled(options) {
  return resolveDispatchMode(options) !== "dryrun";
}
