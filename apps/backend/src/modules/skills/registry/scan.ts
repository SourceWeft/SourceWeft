/**
 * Stage 3 — prompt-injection / safety scan for a submitted skill
 * (docs/architecture/skill-registry-index.md §3 Stage 3 / §5).
 *
 * A skill is *instructions the model executes*, so prompt injection is the
 * dominant risk. This mirrors `market/scan.ts` in shape — a static regex sweep
 * returning `{ reviewRequired, flags }` so clean submissions auto-index and
 * flagged ones queue for review — but scans for skill-specific hazards rather
 * than MCP install commands. Matching a pattern does NOT mean malicious; it
 * means "a human should look before this surfaces catalog-wide."
 *
 * This is intentionally the "don't trust the manifest" gate: it reads the actual
 * bytes, never the skill's self-description.
 */

export type RegistryFinding = { ruleId: string; file?: string; line?: number };
export const SCAN_RULE_VERSION = "1";

export type RegistrySkillScan = {
  findings: RegistryFinding[];
  reviewRequired: boolean;
  flags: string[];
};

export type RegistrySkillScanInput = {
  files: Array<{
    path: string;
    contentText: string;
    role: "model-readable" | "script";
  }>;
  /** `allowed-tools` from the frontmatter (verbatim). */
  allowedTools: string[];
};

// Egress / exfiltration: fetch-then-run and outbound data posts.
const EGRESS_PATTERNS: Array<{ code: string; re: RegExp }> = [
  {
    code: "egress:pipe-to-shell",
    re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
  },
  {
    code: "egress:base64-exec",
    re: /base64\s+(-d|--decode)[^\n|]*\|\s*(ba|z)?sh\b/i,
  },
  {
    code: "egress:external-post",
    re: /\b(requests\.post|axios\.post|fetch)\s*\(\s*['"`]?https?:\/\//i,
  },
  {
    code: "egress:external-post",
    re: /\bcurl\b[^\n]*\s-X\s*POST\b/i,
  },
  {
    // A bare outbound client call (data may leave even on GET).
    code: "egress:fetch",
    re: /\b(urllib\.request|http\.client|net\/http|require\(['"`]https?['"`]\))/i,
  },
];

// Prompt injection: attempts to override the surrounding agent's instructions.
const INJECTION_PATTERNS: Array<{ code: string; re: RegExp }> = [
  {
    code: "injection:override",
    re: /\bignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions?\b/i,
  },
  {
    code: "injection:override",
    re: /\bdisregard\s+(the\s+)?(previous|prior|above|system)\b/i,
  },
  {
    code: "injection:system-prompt",
    re: /\b(system\s*prompt|developer\s*message)\b/i,
  },
];

// Credential / cross-skill file access from within the mounted instructions.
const SECRET_PATTERNS: Array<{ code: string; re: RegExp }> = [
  {
    code: "secrets:read-credentials",
    re: /(\.env\b|\bid_rsa\b|\.ssh\/|aws\/credentials|\.netrc\b|secrets?\.(json|ya?ml|toml))/i,
  },
  {
    code: "secrets:env-access",
    re: /\b(process\.env|os\.environ|getenv)\b/i,
  },
  {
    // Reading a sibling skill's bundle — scope escape (§5 hazard c).
    code: "scope:other-skill-file",
    re: /\.\.\/(?:[^\n"'`]*\/)?SKILL\.md\b/i,
  },
];

/**
 * `allowed-tools` values that imply code execution. Requesting one on an
 * otherwise prompt-only skill is exactly the "script amplification" hazard
 * (§5b) a reviewer must see.
 */
const SENSITIVE_TOOL_PATTERN =
  /\b(bash|shell|zsh|sh|exec|execute|terminal|subprocess|command|computer|code[-_ ]?(exec|execution|interpreter)|run[-_ ]?(code|command|shell))\b/i;

function scanText(
  text: string,
  patterns: Array<{ code: string; re: RegExp }>,
  flags: Set<string>,
  file: string,
  findings: RegistryFinding[],
) {
  for (const { code, re } of patterns) {
    const match = re.exec(text);
    if (match) {
      findings.push({
        ruleId: code,
        file,
        line: text.slice(0, match.index).split("\n").length,
      });
      flags.add(code);
    }
  }
}

export function scanRegistrySkill(
  input: RegistrySkillScanInput,
): RegistrySkillScan {
  const flags = new Set<string>();
  const findings: RegistryFinding[] = [];

  for (const file of input.files) {
    scanText(file.contentText, EGRESS_PATTERNS, flags, file.path, findings);
    scanText(file.contentText, INJECTION_PATTERNS, flags, file.path, findings);
    scanText(file.contentText, SECRET_PATTERNS, flags, file.path, findings);
  }

  for (const tool of input.allowedTools) {
    if (SENSITIVE_TOOL_PATTERN.test(tool)) {
      flags.add("tool:sensitive");
      findings.push({ ruleId: "tool:sensitive", file: "SKILL.md" });
      break;
    }
  }

  const list = [...flags].sort();
  return { reviewRequired: list.length > 0, flags: list, findings };
}
