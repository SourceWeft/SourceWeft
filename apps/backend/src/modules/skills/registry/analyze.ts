import path from "node:path";
import type { SkillManifestJson } from "@sourceweft/db";
import { parseSkillFrontmatter } from "../frontmatter";
import { deriveRegistrySlug } from "./contracts";
import type { DiscoveredSkill } from "./read";
import { RegistrySubmissionError } from "./errors";
import { scanRegistrySkill } from "./scan";

/**
 * Stage 3 — Analyze (parse + safety), STATIC ONLY — never executes the skill.
 * docs/architecture/skill-registry-index.md §3 Stage 3 / build phase R2.
 *
 * Produces the frozen metadata that Stage 5 persists behind a pointer: validated
 * frontmatter, the injection/safety scan verdict, the `capability`
 * classification (with the "don't trust the manifest" mismatch check), the
 * `contentSha256` digest, and the bundle-relative `fileManifest` the runtime
 * uses to fetch individual files. No file body ever leaves this stage.
 */

type RegistryFileManifest = NonNullable<
  SkillManifestJson["registry"]
>["fileManifest"];
type RegistryFileRole = RegistryFileManifest[number]["role"];

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
  /** sha256 of the analyzed SKILL.md bytes (§3 Stage 3). */
  contentSha256: string;
  scan: { reviewRequired: boolean; flags: string[] };
  fileManifest: RegistryFileManifest;
  allowedTools: string[];
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

function readAllowedTools(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter["allowed-tools"] ?? frontmatter.allowedTools;
  if (Array.isArray(raw)) {
    return raw.filter((tool): tool is string => typeof tool === "string");
  }
  if (typeof raw === "string") {
    // agentskills.io allows a comma-separated string form.
    return raw
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);
  }
  return [];
}

function fileRole(bundlePath: string): RegistryFileRole {
  const ext = path.posix.extname(bundlePath).toLowerCase();
  if (bundlePath === "SKILL.md") {
    return "model-readable";
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
 * Classify + verify capability (§3 Stage 3). `executable` when the bundle ships
 * scripts, model-readable content contains fenced shell blocks, or `allowed-tools`
 * implies execution. The mismatch flag is the "don't trust the manifest" gate: a
 * skill that reads prompt-only yet ships scripts is flagged for review.
 */
function classifyCapability(input: {
  files: AnalyzedRegistrySkill["fileManifest"];
  hasShellFence: boolean;
  hasSensitiveTool: boolean;
}): { capability: "prompt-only" | "executable"; undeclaredScripts: boolean } {
  const shipsScripts = input.files.some((file) => file.role === "script");
  const readsExecutable = input.hasShellFence || input.hasSensitiveTool;
  const capability =
    shipsScripts || readsExecutable ? "executable" : "prompt-only";
  // Ships executable material but nothing in the instructions/tools declares it.
  const undeclaredScripts = shipsScripts && !readsExecutable;
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

  const frontmatter = parseSkillFrontmatter(skillMd.contentText);
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
  const fileManifest: RegistryFileManifest = discovered.files.map((file) => ({
    path: file.bundlePath,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    role: fileRole(file.bundlePath),
  }));

  const scanFiles = discovered.files.map((file) => ({
    path: file.bundlePath,
    contentText: file.contentText,
    role: fileRole(file.bundlePath),
  }));
  const baseScan = scanRegistrySkill({ files: scanFiles, allowedTools });
  const flags = new Set(baseScan.flags);

  const hasShellFence = discovered.files.some(
    (file) =>
      fileRole(file.bundlePath) === "model-readable" &&
      SHELL_FENCE_PATTERN.test(file.contentText),
  );
  const { capability, undeclaredScripts } = classifyCapability({
    files: fileManifest,
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
    contentSha256: skillMd.sha256,
    scan: { reviewRequired: finalFlags.length > 0, flags: finalFlags },
    fileManifest,
    allowedTools,
  };
}
