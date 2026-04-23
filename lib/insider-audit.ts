// Scan persona SOUL/USER docs for test-harness leakage.
//
// Test agents must not know the shape of the evaluation (scenario IDs,
// expected outcomes, validation modes). A leak biases the swarm — Grind
// would know s04 is the rejection loop and start gaming it. The scanner
// runs on every PersonaCard render and surfaces findings as a badge.

export interface AuditFinding {
  file: string;
  line: number;
  match: string;
  pattern: string;
  snippet: string;
}

export interface AuditReport {
  clean: boolean;
  findings: AuditFinding[];
}

const LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "expected_outcome", re: /expected.*outcome/i },
  { name: "validationMode", re: /validationMode/i },
  { name: "validation_mode_enum", re: /HARD_ONLY|SOFT_ONLY|HARD_THEN_SOFT/ },
  { name: "scenario_s##", re: /scenario.*s\d{2}/i },
  { name: "config_c##", re: /config.*c\d{2}/i },
  { name: "assertion", re: /assertion/i },
  { name: "should_pass_fail", re: /should.*pass|should.*fail/i },
  // Standalone scenario IDs — word-bounded s01..s20.
  { name: "scenario_id_bare", re: /\bs(0[1-9]|1\d|20)\b/ }
];

export function auditPersonaDoc(
  file: string,
  content: string
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { name, re } of LEAK_PATTERNS) {
      const m = line.match(re);
      if (m) {
        findings.push({
          file,
          line: i + 1,
          match: m[0],
          pattern: name,
          snippet: line.trim()
        });
      }
    }
  }
  return findings;
}

export function auditPersona(docs: {
  soul_md?: string;
  user_md?: string;
}): AuditReport {
  const findings: AuditFinding[] = [];
  if (docs.soul_md) findings.push(...auditPersonaDoc("SOUL.md", docs.soul_md));
  if (docs.user_md) findings.push(...auditPersonaDoc("USER.md", docs.user_md));
  return { clean: findings.length === 0, findings };
}
