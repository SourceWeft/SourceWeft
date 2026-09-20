import path from "node:path";
import type { SkillDiagnostic } from "@sourceweft/contracts";
import type { SkillManifestJson } from "@sourceweft/db";
import { parseSkillFrontmatter } from "../frontmatter";
import { deriveRegistrySlug } from "./contracts";
import type { DiscoveredSkill } from "./read";
import { RegistrySubmissionError } from "./errors";
import { detectExecutableBinary, scanRegistrySkill } from "./scan";

/**
 * Stage 3 — Analyze (parse + safety), STATIC ONLY — never executes the skill.
 * docs/architecture/skill-registry-index.md §3 Stage 3 / build phase R2.
 *
 * Produces the frozen metadata that Stage 5 persists next to the stored bundle:
 * validated frontmatter, the injection/safety scan verdict, the `capability`
 * classification (with the "don't trust the manifest" mismatch check), and the
 * bundle-relative `fileManifest`. The bytes themselves are not this stage's
 * business — Stage 5 stores them.
 */

type RegistryFileManifest = NonNullable<
  SkillManifestJson["registry"]
>["fileManifest"];
/**
 * `asset` is a non-text resource — a font, an image, a template: carried and
 * staged with the bundle, never mounted as model-readable text and never
 * treated as a script.
 */
type RegistryFileRole = "model-readable" | "script" | "asset";

export type AnalyzedRegistrySkill = {
  slug: string;
  name: string;
  displayName: string;
  description: string;
  /** Skill dir relative to the repo root — the pointer `#<subpath>`. */
  repoSubpath: string;
  capability: "prompt-only" | "executable";
  /** Declared license name (e.g. "MIT") — display-only, never a gate. */
  license: string | null;
  scan: { reviewRequired: boolean; flags: string[] };
  fileManifest: RegistryFileManifest;
  allowedTools: string[];
  diagnostics: SkillDiagnostic[];
  findings: import("./scan").RegistryFinding[];
};

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

// Files whose bytes must NOT be mounted as model-readable text at runtime: they
// are executable material streamed into the execution sandbox instead (§6a/§6b).
const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".pl",
  ".php",
  ".ps1",
]);

// Fenced shell blocks in model-readable content = the skill tells the model to
// run commands ⇒ executable capability (§3 Stage 3).
const SHELL_FENCE_PATTERN =
  /```\s*(bash|sh|shell|zsh|console|shell-session)\b/i;

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function titleCase(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function readAllowedTools(
  frontmatter: Record<string, unknown>,
): string[] {
  function invalid(): never {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_INVALID_SKILL",
      "SKILL.md allowed-tools must contain balanced string tool declarations without conflicting aliases",
    );
  }
  function split(value: unknown): string[] {
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((item) => typeof item === "string")) invalid();
    const result: string[] = [];
    for (const item of values as string[]) {
      let depth = 0,
        token = "";
      for (const character of item) {
        if (character === "(") depth++;
        if (character === ")" && --depth < 0) invalid();
        if (depth === 0 && /[\s,]/.test(character)) {
          if (token) result.push(token);
          token = "";
        } else token += character;
      }
      if (depth !== 0) invalid();
      if (token) result.push(token);
    }
    return [...new Set(result)];
  }
  const declarations = ["allowed-tools", "allowedTools", "allowed_tools"]
    .filter((key) => Object.hasOwn(frontmatter, key))
    .map((key) => split(frontmatter[key]));
  const first = declarations[0] ?? [];
  if (
    declarations.some(
      (list) => [...list].sort().join("\0") !== [...first].sort().join("\0"),
    )
  )
    invalid();
  return first;
}

function fileRole(file: {
  bundlePath: string;
  isText: boolean;
}): RegistryFileRole {
  const { bundlePath } = file;
  const ext = path.posix.extname(bundlePath).toLowerCase();
  if (bundlePath === "SKILL.md") {
    return "model-readable";
  }
  // Decided before the script rule: bytes that are not text cannot be read by
  // the model or text-scanned as a script, wherever they sit. Whether such a
  // file is itself code is the scan's question (`binary:executable`).
  if (!file.isText) {
    return "asset";
  }
  if (bundlePath.startsWith("scripts/") || SCRIPT_EXTENSIONS.has(ext)) {
    return "script";
  }
  return "model-readable";
}

/**
 * A script that references a path climbing ABOVE its own bundle directory is the
 * out-of-bundle reference PR-4 flags (§ "import analyzer should warn on
 * out-of-bundle path references"). We resolve each quoted relative path token
 * against the referencing file's bundle dir; anything normalizing to `../…` (or
 * an absolute/home path) has escaped the bundle.
 */
function referencesOutOfBundlePath(
  bundlePath: string,
  contentText: string,
): boolean {
  const fileDir = path.posix.dirname(bundlePath);
  const tokens = contentText.match(/['"`]([^'"`\n]*\/[^'"`\n]*)['"`]/g) ?? [];
  for (const token of tokens) {
    const raw = token.slice(1, -1);
    if (raw.startsWith("/") || raw.startsWith("~")) {
      return true; // absolute / home path — outside the bundle by definition
    }
    if (!raw.includes("../")) {
      continue;
    }
    const resolved = path.posix.normalize(
      path.posix.join(fileDir === "." ? "" : fileDir, raw),
    );
    if (resolved.startsWith("../") || resolved === "..") {
      return true;
    }
  }
  return false;
}

/**
 * Classify + verify capability (§3 Stage 3).
 *
 * `capability` answers one question: **does this bundle ship code we would
 * stage into the sandbox?** That is what the install gate acts on — an
 * `executable` skill installs switched off, because running third-party code is
 * the user's decision. So it is decided by what the bundle CONTAINS: files with
 * `role: "script"`, a compiled binary, or a frontmatter `allowed-tools` that
 * asks for a shell, which is an explicit declaration of executable intent.
 *
 * A fenced shell block in SKILL.md is deliberately NOT part of that answer.
 * Prose is not capability: measured across a 90-skill repository, 64 of the 78
 * it classified as executable shipped nothing but markdown and were caught
 * solely by a one-line `npx skills add …` install snippet in their own docs.
 * An 82% false-positive rate does not make the gate cautious, it makes it
 * noise — the user sees a pile of inexplicably disabled skills and switches
 * them all on, which is strictly worse than not having gated at all.
 *
 * Dangerous INSTRUCTIONS are a real hazard, just a different one, and the scan
 * already owns it: `EGRESS_PATTERNS` flags `curl … | sh`, base64-pipe-to-shell
 * and outbound posts wherever they appear, prose included, and routes the skill
 * to review. The fence adds nothing on top of that — what it uniquely matched
 * here was `npx skills add …` and `make all` — so it raises no flag either.
 * Raising one would be the same mistake wearing a different hat: every flag
 * sets `reviewRequired`, so those 64 skills would go from merely disabled to
 * queued, which the user cannot even switch on.
 *
 * It still feeds `undeclaredScripts`, where it does real work: a bundle that
 * ships scripts while its prose never mentions running anything is exactly the
 * mismatch a reviewer should see.
 */
function classifyCapability(input: {
  roles: RegistryFileRole[];
  shipsExecutableBinary: boolean;
  hasShellFence: boolean;
  hasSensitiveTool: boolean;
}): { capability: "prompt-only" | "executable"; undeclaredScripts: boolean } {
  const shipsScripts = input.roles.includes("script");
  const capability =
    shipsScripts || input.shipsExecutableBinary || input.hasSensitiveTool
      ? "executable"
      : "prompt-only";
  // Ships executable material but nothing in the instructions/tools declares it
  // — the "don't trust the manifest" gate.
  const undeclaredScripts =
    shipsScripts && !input.hasShellFence && !input.hasSensitiveTool;
  return { capability, undeclaredScripts };
}

/**
 * Analyze one discovered skill into frozen, body-free metadata. Throws
 * `RegistrySubmissionError('REGISTRY_SUBMISSION_INVALID_SKILL')` when the
 * frontmatter fails the agentskills.io shape so the caller can skip it.
 */
export function analyzeRegistrySkill(input: {
  owner: string;
  repo: string;
  discovered: DiscoveredSkill;
}): AnalyzedRegistrySkill {
  const { discovered } = input;
  const skillMd = discovered.files.find(
    (file) => file.bundlePath === "SKILL.md",
  );
  if (!skillMd) {
    // read.ts only surfaces dirs with a SKILL.md, so this is defensive.
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_INVALID_SKILL",
      "Skill directory is missing SKILL.md",
    );
  }

  if (!skillMd.isText) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_INVALID_SKILL",
      "SKILL.md must be UTF-8 text",
    );
  }

  const frontmatter = parseSkillFrontmatter(skillMd.contentText);
  if (!frontmatter)
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_INVALID_SKILL",
      "SKILL.md requires YAML frontmatter",
    );
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_INVALID_SKILL",
      `SKILL.md 'name' must be 1-${MAX_NAME_LENGTH} chars of [a-z0-9-]`,
    );
  }
  // The frontmatter `name` is authoritative; the directory it happens to sit in
  // is not required to match. The agentskills.io spec recommends they agree, but
  // real repos routinely differ (a directory suffixed `-skill`, a name
  // describing the technique), and rejecting those loses the whole skill over a
  // cosmetic mismatch. Every consumer in the ecosystem — LobeHub, Continue,
  // goose — reads the frontmatter and ignores the directory, so we do too.
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_INVALID_SKILL",
      "SKILL.md 'description' must be a non-empty string",
    );
  }
  // Overlong descriptions are truncated for display, not rejected — length is
  // a cosmetic concern, not a validity one.
  const normalizedDescription = description
    .trim()
    .slice(0, MAX_DESCRIPTION_LENGTH);

  const allowedTools = readAllowedTools(frontmatter);
  const roles = discovered.files.map((file) => fileRole(file));
  const fileManifest = discovered.files.map((file, index) => ({
    path: file.bundlePath,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    role: roles[index]!,
  }));

  const scanFiles = discovered.files.flatMap((file, index) => {
    const role = roles[index]!;
    return file.isText && role !== "asset"
      ? [{ path: file.bundlePath, contentText: file.contentText, role }]
      : [];
  });
  const binaryFiles = discovered.files
    .filter((file) => !file.isText)
    .map((file) => ({ path: file.bundlePath, bytes: file.bytes }));
  const baseScan = scanRegistrySkill({
    files: scanFiles,
    binaryFiles,
    allowedTools,
  });
  const flags = new Set(baseScan.flags);
  const executableBinaries = binaryFiles.flatMap((file) => {
    const format = detectExecutableBinary(file);
    return format ? [{ path: file.path, format }] : [];
  });

  const hasShellFence = scanFiles.some(
    (file) =>
      file.role === "model-readable" &&
      SHELL_FENCE_PATTERN.test(file.contentText),
  );
  const { capability, undeclaredScripts } = classifyCapability({
    roles,
    shipsExecutableBinary: executableBinaries.length > 0,
    hasShellFence,
    hasSensitiveTool: flags.has("tool:sensitive"),
  });
  if (undeclaredScripts) {
    flags.add("capability:undeclared-scripts");
  }

  for (const file of scanFiles) {
    if (
      file.role === "script" &&
      referencesOutOfBundlePath(file.path, file.contentText)
    ) {
      flags.add("script:out-of-bundle-path");
      break;
    }
  }

  // License name (e.g. "MIT") is captured for catalog display only — the
  // registry is a pointer-only index, so no license gating applies.
  const license = firstString(frontmatter.license);

  const finalFlags = [...flags].sort();
  return {
    slug: deriveRegistrySlug(input.owner, input.repo, name),
    name,
    displayName:
      firstString(frontmatter.displayName, frontmatter.title) ??
      titleCase(name),
    description: normalizedDescription,
    repoSubpath: discovered.repoSubpath,
    capability,
    license,
    scan: { reviewRequired: finalFlags.length > 0, flags: finalFlags },
    fileManifest,
    allowedTools,
    findings: baseScan.findings,
    diagnostics: [
      ...(description.trim().length > MAX_DESCRIPTION_LENGTH
        ? [
            {
              code: "DESCRIPTION_SUMMARIZED",
              severity: "warning" as const,
              message:
                "Catalog description is shortened; the original SKILL.md is preserved.",
              file: "SKILL.md",
              field: "description",
            },
          ]
        : []),
      // The finding names the file; this says what it was taken for, which a
      // finding has no field to carry.
      ...executableBinaries.map((file) => ({
        code: "BINARY_EXECUTABLE",
        severity: "warning" as const,
        message: `Ships executable code (${file.format}) that cannot be scanned as text; the skill is held for review.`,
        file: file.path,
      })),
    ],
  };
}
