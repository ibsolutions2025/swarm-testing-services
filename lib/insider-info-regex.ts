// lib/insider-info-regex.ts
//
// Hard-fail any HLO dispatch text that leaks test-harness internals (scenario
// IDs, validation-mode enums, "test"/"matrix"/"coverage" terms) into the
// natural-language message we ship to a swarm agent. A leak biases the swarm:
// if Grind learns "scenario s05 is the rejection loop", Grind starts gaming
// the rejection loop instead of behaving like a real protocol participant.
//
// Ported + extended from `scripts/swarm-agent-runner.mjs` (LEAK_PATTERNS) and
// `lib/insider-audit.ts` (auditor for SOUL/USER docs). Phase A v2 broadens
// coverage to also reject:
//   - bare config keys like `soft-open-multi-rating-approved`
//   - test-harness vocabulary ("test", "matrix", "coverage", "fixture", etc.)
//   - HLO action keys (`claim_validator`, `submit_work` — agent decides, not us)
//
// Used by:
//   - HLO daemon — every dispatch message goes through `assertInsiderInfoClean`
//     before agent_task fires.
//   - SOUL.md scanner — agent identity files must not embed scenario hints.
//   - Auditor — flags any orchestration_events row whose `dispatch_message_text`
//     would have been rejected (catches drift in dispatch-message generators).
//
// Throws on any match. Refusing to dispatch is always safer than silently
// biasing the swarm.

export interface InsiderInfoMatch {
  pattern: string;
  match: string;
  index: number;
  excerpt: string; // up to 80 chars around the match
}

const LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Original patterns (mirror swarm-agent-runner.mjs LEAK_PATTERNS)
  { name: "expected_outcome", re: /expected.*outcome/i },
  { name: "validationMode", re: /validationMode/i },
  { name: "validation_mode_enum", re: /HARD_ONLY|SOFT_ONLY|HARD_THEN_SOFT/ },
  { name: "scenario_s##", re: /scenario.*s\d{2}/i },
  { name: "config_c##", re: /config[\s-]+c\d{1,2}\b/i },
  { name: "assertion", re: /assertion/i },
  { name: "should_pass_fail", re: /should.*pass|should.*fail/i },
  { name: "scenario_id_bare", re: /\bs(0[1-9]|1\d|20)\b/ },

  // New Phase A patterns — broaden coverage
  { name: "config_key_bare", re: /\b(soft|hard|hardsift)-(open|timed)-(single|multi)-(open|approved|rating)-(open|approved|rating|na)\b/i },
  { name: "test_harness_vocab", re: /\b(test[-\s]?harness|test[-\s]?swarm|test[-\s]?matrix|coverage[-\s]?matrix|test[-\s]?fixture|fixture[-\s]?for)\b/i },
  { name: "hlo_action_key", re: /\b(claim_validator|submit_work|approve_submission|reject_submission|reject_all|cancel_job|finalize_timed_job|submit_review)\b/ },
  { name: "matrix_or_cell", re: /\b(matrix\s+cell|cell\s+predicate|terminal\s+scenario|cell[-\s]?def)\b/i },
  { name: "untested_cell", re: /\buntested[-\s]?cell|coverage[-\s]?gap|gap[-\s]?in[-\s]?matrix/i },
  // Common gotcha — leaking the framework name
  { name: "swarm_testing_services", re: /\bswarm[-\s]?testing[-\s]?services\b/i },
  { name: "hlo_or_orchestrator", re: /\b(HLO|hlo[-\s]?daemon|orchestrator|orchestration[-\s]?event)\b/i },
];

/**
 * Throws if `text` contains any leak pattern. `label` is included in the
 * error so the caller can tell which dispatch / file / SOUL.md leaked.
 */
export function assertInsiderInfoClean(label: string, text: string): void {
  const matches = findInsiderInfoLeaks(text);
  if (matches.length > 0) {
    const first = matches[0];
    throw new Error(
      `[insider-info] leak in ${label}: pattern=${first.pattern} ` +
      `matched="${first.match}" excerpt="${first.excerpt}" — refusing to dispatch`
    );
  }
}

/**
 * Non-throwing variant — returns the list of matches for auditing/logging.
 * Useful for the dispatch-message generator's pre-flight check.
 */
export function findInsiderInfoLeaks(text: string): InsiderInfoMatch[] {
  if (!text || typeof text !== "string") return [];
  const out: InsiderInfoMatch[] = [];
  for (const { name, re } of LEAK_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 30);
      const end = Math.min(text.length, m.index + m[0].length + 30);
      out.push({
        pattern: name,
        match: m[0],
        index: m.index,
        excerpt: text.slice(start, end),
      });
    }
  }
  return out;
}

/**
 * Convenience for the legacy auditPersonaDoc consumers (PersonaCard etc.) —
 * returns line-by-line findings shaped like the old `auditPersonaDoc` result.
 */
export function auditTextLineByLine(file: string, content: string): Array<{
  file: string; line: number; pattern: string; match: string; snippet: string;
}> {
  const out: Array<{ file: string; line: number; pattern: string; match: string; snippet: string }> = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, re } of LEAK_PATTERNS) {
      const m = line.match(re);
      if (m) {
        out.push({
          file,
          line: i + 1,
          pattern: name,
          match: m[0],
          snippet: line.trim(),
        });
      }
    }
  }
  return out;
}

export const INSIDER_LEAK_PATTERNS = LEAK_PATTERNS.map(({ name, re }) => ({
  name,
  pattern: re.source,
  flags: re.flags,
}));
