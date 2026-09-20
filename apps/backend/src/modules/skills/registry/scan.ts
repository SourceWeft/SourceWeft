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
  /** The bundle's TEXT files; the regex sweep reads these. */
  files: Array<{
    path: string;
    contentText: string;
    role: "model-readable" | "script";
  }>;
  /**
   * The bundle's non-text files. Their content cannot be swept for patterns, so
   * the only question asked of them is whether they are code
   * (`detectExecutableBinary`).
   */
  binaryFiles?: Array<{ path: string; bytes: Uint8Array }>;
  /** `allowed-tools` from the frontmatter (verbatim). */
  allowedTools: string[];
};

/** Flag raised when a bundle ships compiled or otherwise opaque code. */
export const EXECUTABLE_BINARY_FLAG = "binary:executable";

/**
 * Extensions that mean "loadable code" whatever the bytes look like: native
 * libraries and executables, JVM and WebAssembly modules, and the compiled
 * forms script runtimes import directly (`.pyc`, `.pyd`, `.node`). A `.jar` is
 * a zip by magic, so only its name gives it away.
 */
const EXECUTABLE_BINARY_EXTENSION =
  /\.(?:exe|dll|msi|so|dylib|jar|class|wasm|pyc|pyo|pyd|node|o|a)$|\.so\.[0-9.]+$/i;

/** Leading bytes of the executable container formats. */
const EXECUTABLE_MAGICS: Array<{ format: string; bytes: number[] }> = [
  { format: "ELF", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { format: "PE (MZ)", bytes: [0x4d, 0x5a] },
  { format: "Mach-O", bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { format: "Mach-O", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { format: "Mach-O", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { format: "Mach-O", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  // Shared by universal Mach-O binaries and Java class files — code either way.
  { format: "Mach-O universal / Java class", bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { format: "Mach-O universal", bytes: [0xbe, 0xba, 0xfe, 0xca] },
  { format: "Mach-O universal", bytes: [0xca, 0xfe, 0xba, 0xbf] },
  { format: "WebAssembly", bytes: [0x00, 0x61, 0x73, 0x6d] },
  // A script that is not valid UTF-8 still runs, and could not be text-scanned.
  { format: "shebang script", bytes: [0x23, 0x21] },
];

/**
 * Whether a NON-TEXT bundle file is executable code, and why — or null.
 *
 * Fonts, images, PDFs, audio/video and office templates are what skills
 * legitimately ship and pass silently; so does any other binary that is not
 * recognisably code. The magic bytes are checked whatever the extension says,
 * so an ELF renamed `logo.png` is still an ELF: the extension is the author's
 * claim, the bytes are the file.
 */
export function detectExecutableBinary(file: {
  path: string;
  bytes: Uint8Array;
}): string | null {
  const magic = EXECUTABLE_MAGICS.find(
    (candidate) =>
      file.bytes.length >= candidate.bytes.length &&
      candidate.bytes.every((byte, index) => file.bytes[index] === byte),
  );
  if (magic) {
    return magic.format;
  }
  const extension = EXECUTABLE_BINARY_EXTENSION.exec(file.path);
  return extension ? `${extension[0].toLowerCase()} file` : null;
}

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

  // Opaque code cannot be reviewed by a regex, so a human looks before it
  // surfaces catalog-wide. One finding per file: the reviewer needs the list.
  for (const file of input.binaryFiles ?? []) {
    if (detectExecutableBinary(file)) {
      findings.push({ ruleId: EXECUTABLE_BINARY_FLAG, file: file.path });
      flags.add(EXECUTABLE_BINARY_FLAG);
    }
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
