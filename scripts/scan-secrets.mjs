#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
  encoding: "utf8"
}).split("\0").filter(Boolean);

const ignoredFiles = new Set(["scripts/scan-secrets.mjs"]);
const tokenRules = [
  ["OpenRouter key", /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g],
  ["Provider API key", /\b(?:cpk_|sk-)[A-Za-z0-9_-]{20,}\b/g],
  ["GitHub token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["Alchemy credential", /https:\/\/[A-Za-z0-9.-]*alchemy\.com\/v2\/(?!REDACTED\b)[A-Za-z0-9_-]{12,}/g]
];
const assignmentRule = /\b(CHUTES_API_KEY|OPENROUTER_API_KEY|MOONSHOT_API_KEY|ALCHEMY_RPC|SUPABASE_SERVICE_ROLE_KEY|ORCHESTRATOR_WEBHOOK_SECRET|ONBOARDING_SERVER_TOKEN|GITHUB_PAT_RW)\s*=\s*([^\s#]+)/g;
const placeholder = /^(?:["']?$|["']?(?:your-|example|placeholder|redacted|changeme|process\.env|\$\{|<))/i;

const findings = [];
for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  if (ignoredFiles.has(normalized) || normalized.startsWith("node_modules/") || normalized.endsWith("package-lock.json")) continue;

  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [name, rule] of tokenRules) {
      rule.lastIndex = 0;
      if (rule.test(line)) findings.push({ file: normalized, line: index + 1, rule: name });
    }
    assignmentRule.lastIndex = 0;
    let match;
    while ((match = assignmentRule.exec(line)) !== null) {
      const value = match[2].replace(/^['"]|['"]$/g, "");
      const readsFromEnvironment = line.includes(`process.env.${match[1]}`);
      const documentedPlaceholder = value.includes("...");
      if (value && !readsFromEnvironment && !documentedPlaceholder && !placeholder.test(value)) {
        findings.push({ file: normalized, line: index + 1, rule: `inline ${match[1]}` });
      }
    }
  });
}

if (findings.length) {
  console.error("Secret scan failed. Values are intentionally not printed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} (${finding.rule})`);
  }
  process.exit(1);
}

console.log(`Secret scan passed (${files.length} tracked/unignored files checked).`);
