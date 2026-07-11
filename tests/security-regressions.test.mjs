import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("signup never mutates an existing account through the admin API", async () => {
  const source = await readFile(new URL("../app/api/auth/signup/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /updateUserById|listUsers|createAdminClient|email_confirm\s*:\s*true/);
  assert.match(source, /auth\.signUp/);
});

test("external ABI parsing does not execute dynamic functions", async () => {
  const files = [
    "../framework/onboarding/steps/08-generate-events.mjs",
    "../framework/onboarding/validate-against-fixture.mjs",
    "../framework/onboarding/lib/runtime-helpers.template.ts"
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bFunction\s*\(|\bnew\s+Function\s*\(/);
  }
});

test("Next.js configuration does not allow wildcard Server Action origins", async () => {
  const source = await readFile(new URL("../next.config.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /allowedOrigins\s*:\s*\[\s*["']\*["']/);
  assert.match(source, /X-Content-Type-Options/);
});

test("private result APIs use the user session and never expose wildcard CORS", async () => {
  const files = [
    "../app/api/test-results/lifecycle/route.ts",
    "../app/api/test-results/orchestration/route.ts",
    "../app/api/test-results/heartbeats/route.ts"
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /createServerClient/);
    assert.match(source, /auth\.getUser\(\)/);
    assert.doesNotMatch(source, /createAdminClient|Access-Control-Allow-Origin/);
  }
});

test("agent failures never fabricate a passing review", async () => {
  const source = await readFile(
    new URL("../scripts/swarm-agent-runner.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /fallbackResult/);
  assert.doesNotMatch(source, /decision\s*:\s*["']approve["']\s*,\s*score\s*:\s*70/);
});

test("campaign intake authenticates before DNS work and enforces a database quota", async () => {
  const source = await readFile(
    new URL("../app/api/test-campaign/route.ts", import.meta.url),
    "utf8"
  );
  assert.ok(source.indexOf("auth.getUser()") < source.indexOf("await assertPublicTargetUrl"));
  assert.match(source, /consume_campaign_quota/);
  assert.match(source, /status:\s*429/);
  assert.match(source, /STS_ALLOW_PRODUCTION_TARGETS/);

  const migration = await readFile(
    new URL("../supabase/migrations/0011_production_readiness_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = public, pg_temp/);
  assert.match(migration, /REVOKE ALL ON campaign_quota_buckets FROM anon, authenticated/);
});

test("shared GitHub credentials are restricted to allowlisted repository owners", async () => {
  const source = await readFile(
    new URL("../framework/onboarding/lib/source-fetcher.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /STS_GITHUB_TOKEN_ALLOWED_OWNERS/);
  assert.match(source, /pickGithubToken\(owner\)/);
  assert.match(source, /allowedOwners\.has/);
});

test("onboarding server fails closed around targets and generated-code activation", async () => {
  const source = await readFile(
    new URL("../framework/onboarding/server.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /assertPublicTargetUrl/);
  assert.match(source, /STS_ALLOW_CODE_CUTOVER/);
  assert.match(source, /request body too large/);
  assert.match(source, /invalid output filename/);
});

test("greenlight is disabled by default and finalizes its database ledger atomically", async () => {
  const route = await readFile(
    new URL("../app/api/onboarding/greenlight/route.ts", import.meta.url),
    "utf8"
  );
  assert.ok(route.indexOf("auth.getUser()") < route.indexOf("await req.text()"));
  assert.match(route, /STS_ALLOW_CODE_CUTOVER/);
  assert.match(route, /finalize_onboarding_greenlight/);
  assert.doesNotMatch(route, /\.from\(["']client_libs["']\)\s*\.upsert/);

  const migration = await readFile(
    new URL("../supabase/migrations/0011_production_readiness_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION finalize_onboarding_greenlight/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /REVOKE ALL ON FUNCTION finalize_onboarding_greenlight/);
});
