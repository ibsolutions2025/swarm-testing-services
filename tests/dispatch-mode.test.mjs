import test from "node:test";
import assert from "node:assert/strict";
import { dispatchWritesEnabled, resolveDispatchMode } from "../framework/dispatch-mode.mjs";

test("--dry-run overrides every write-capable environment mode", () => {
  for (const configured of ["http", "cli", "dryrun", "unknown", ""]) {
    const options = { argv: ["node", "hlo-daemon.mjs", "--dry-run"], env: { DISPATCH_MODE: configured } };
    assert.equal(resolveDispatchMode(options), "dryrun");
    assert.equal(dispatchWritesEnabled(options), false);
  }
});

test("only known explicit modes can enable writes", () => {
  assert.equal(resolveDispatchMode({ argv: [], env: { DISPATCH_MODE: "http" } }), "http");
  assert.equal(resolveDispatchMode({ argv: [], env: { HLO_DISPATCH_MODE: "cli" } }), "cli");
  assert.equal(resolveDispatchMode({ argv: [], env: { DISPATCH_MODE: "surprise" } }), "dryrun");
});
