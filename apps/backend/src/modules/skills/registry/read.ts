import { sha256 } from "../hash";
import { RegistrySubmissionError } from "./errors";
import {
  downloadRepoZip,
  GitHubArchiveError,
  GITHUB_ZIP_LIMITS,
  listZipEntries,
  readZipEntries,
  resolvePinnedGitHubSource,
  type PinnedGitHubSource,
} from "../../market/parser/github-zip";

/**
 * Stage 2 — Read (fetch + locate SKILL.md).
 * docs/architecture/skill-registry-index.md §3 Stage 2 / build phase R2.
 *
 * The repository is read as an in-memory zipball (`market/parser/github-zip.ts`): one bounded
 * download, then only the entries belonging to a discovered skill are
 * decompressed. Nothing is extracted to the host filesystem, so there is no
 * temp directory to clean up and no archive path is ever joined onto a host
 * directory — the traversal / symlink / `tar` hazards that
 * `prepareGitHubRepository` has to guard against do not arise on this path.
 */

/**
 * DoS bounds on the ANALYZED skill bundles. The archive-level caps (compressed
 * size, entry count, per-file and cumulative uncompressed size) live in
 * `github-zip.ts`; `maxSkillFileBytes` mirrors its per-file ceiling so a file we
 * index is always re-readable within the same cap.
 */
export const REGISTRY_READ_LIMITS = Object.freeze({
  maxSkillFileBytes: GITHUB_ZIP_LIMITS.maxFileBytes,
  maxSkillFilesPerBundle: 200,
  maxSkillsPerRepo: 25,
});

/** Directories that are never skill content (mirrors builtin.ts denylist). */
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
/** Containers under which per-skill subdirectories live (§3 Stage 2). */
const SKILL_CONTAINERS = ["skills", ".claude/skills", ".agents/skills"];

/** Mirrors builtin.ts TEXT_MIME_BY_EXTENSION; anything else serves as text. */
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

/**
 * A skill bundle is text — SKILL.md, references, scripts. Real repos also ship
 * binary assets alongside them (anthropics/skills ships 56 `.ttf` fonts under
 * `canvas-design/`), and those cannot be carried: `contentText` is a Postgres
 * `text` column, so invalid UTF-8 is rejected at insert time, and a lossy
 * decode would store mojibake whose sha256 no longer matches the source. They
 * are dropped from the bundle rather than mangled — binary assets are a known
 * non-goal — which also keeps `fileManifest` an honest description of what we
 * actually carry.
 */
function isUtf8Text(bytes: Buffer, decoded: string): boolean {
  return Buffer.byteLength(decoded, "utf8") === bytes.byteLength;
}

function mimeTypeFor(bundlePath: string): string {
  const dot = bundlePath.lastIndexOf(".");
  const ext = dot < 0 ? "" : bundlePath.slice(dot).toLowerCase();
  return TEXT_MIME_BY_EXTENSION[ext] ?? "text/plain";
}

export type DiscoveredSkillFile = {
  /** Path relative to the skill BUNDLE root (e.g. `SKILL.md`, `scripts/run.py`). */
  bundlePath: string;
  /** sha256 over the raw file bytes. */
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  contentText: string;
};

export type DiscoveredSkill = {
  /**
   * Skill directory relative to the REPO ROOT. Empty string when the skill sits
   * at the repo root.
   */
  repoSubpath: string;
  /** Last path segment of the skill dir. */
  dirName: string;
  files: DiscoveredSkillFile[];
};

export type ReadRegistryResult = {
  source: PinnedGitHubSource;
  /** Immutable 40-hex commit the submission is pinned to. */
  commitSha: string;
  skills: DiscoveredSkill[];
};

/** `a/b/c.md` → `a/b`; a root-level path → `""`. */
function dirNameOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash < 0 ? "" : filePath.slice(0, slash);
}

function lastSegment(dirPath: string): string {
  const slash = dirPath.lastIndexOf("/");
  return slash < 0 ? dirPath : dirPath.slice(slash + 1);
}

/**
 * Locate every skill directory (one containing a `SKILL.md`): the repo root
 * itself, plus one level under `skills/`, `.claude/skills/`, `.agents/skills/`.
 * A repo may ship multiple skills (§3 Stage 2).
 */
function discoverSkillDirectories(entryPaths: string[]): string[] {
  const dirs: string[] = [];
  for (const entryPath of entryPaths) {
    if (!entryPath.endsWith("SKILL.md")) {
      continue;
    }
    const dir = dirNameOf(entryPath);
    if (dir === "") {
      dirs.push("");
      continue;
    }
    const container = dirNameOf(dir);
    if (SKILL_CONTAINERS.includes(container)) {
      dirs.push(dir);
    }
  }
  return [...new Set(dirs)].sort();
}

/** Bundle membership: under the skill dir, minus build/vcs noise. */
function isBundleFile(skillDir: string, entryPath: string): boolean {
  const prefix = skillDir === "" ? "" : `${skillDir}/`;
  if (!entryPath.startsWith(prefix)) {
    return false;
  }
  const relative = entryPath.slice(prefix.length);
  if (!relative) {
    return false;
  }
  const segments = relative.split("/");
  // Only the directory segments are checked: a file literally named `dist` is
  // content, a `dist/` directory is build output.
  return !segments.slice(0, -1).some((segment) => SKIP_DIR_NAMES.has(segment));
}

/**
 * Fetch a submitted GitHub repo as an in-memory zipball and return every
 * discovered skill bundle with per-file digests. The commit is pinned to an
 * immutable 40-hex sha (rejected otherwise — the record must be frozen, §2/§5).
 */
export async function readRegistrySkillsFromGitHub(
  repoUrl: string,
): Promise<ReadRegistryResult> {
  try {
    return await readSkills(repoUrl);
  } catch (error) {
    // Map the shared reader's transport/size failures onto submission errors;
    // it deliberately knows nothing about this module's error taxonomy.
    if (error instanceof GitHubArchiveError) {
      throw new RegistrySubmissionError(
        error.code === "ARCHIVE_TOO_LARGE"
          ? "REGISTRY_SUBMISSION_TOO_LARGE"
          : error.code === "ARCHIVE_UNPINNED"
            ? "REGISTRY_SUBMISSION_UNPINNED"
            : "REGISTRY_SUBMISSION_NOT_SKILL",
        error.message,
      );
    }
    throw error;
  }
}

async function readSkills(repoUrl: string): Promise<ReadRegistryResult> {
  const source = await resolvePinnedGitHubSource(repoUrl);
  const zip = await downloadRepoZip(source);

  const entries = await listZipEntries(zip);
  const entryPaths = entries.map((entry) => entry.path);

  // A `/tree/<ref>/<subpath>` submission scopes discovery to that subtree.
  const scope = source.subpath ? `${source.subpath}/` : "";
  const scopedPaths = scope
    ? entryPaths.filter((entryPath) => entryPath.startsWith(scope))
    : entryPaths;

  const skillDirs = discoverSkillDirectories(
    scope
      ? scopedPaths.map((entryPath) => entryPath.slice(scope.length))
      : scopedPaths,
  ).map((dir) => (scope ? `${scope}${dir}`.replace(/\/$/, "") : dir));

  if (skillDirs.length === 0) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_NOT_SKILL",
      "No SKILL.md found at the repo root or under skills/, .claude/skills/, .agents/skills/",
    );
  }
  if (skillDirs.length > REGISTRY_READ_LIMITS.maxSkillsPerRepo) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_TOO_LARGE",
      `Repository ships more than the ${REGISTRY_READ_LIMITS.maxSkillsPerRepo}-skill limit`,
    );
  }

  const wanted = new Map<string, string>();
  for (const skillDir of skillDirs) {
    const bundlePaths = entryPaths.filter((entryPath) =>
      isBundleFile(skillDir, entryPath),
    );
    if (bundlePaths.length > REGISTRY_READ_LIMITS.maxSkillFilesPerBundle) {
      throw new RegistrySubmissionError(
        "REGISTRY_SUBMISSION_TOO_LARGE",
        `Skill bundle exceeds the ${REGISTRY_READ_LIMITS.maxSkillFilesPerBundle}-file limit`,
      );
    }
    for (const bundlePath of bundlePaths) {
      // A nested skill dir belongs to the innermost skill that owns it; the
      // longest matching prefix wins.
      const current = wanted.get(bundlePath);
      if (!current || skillDir.length > current.length) {
        wanted.set(bundlePath, skillDir);
      }
    }
  }

  const files = await readZipEntries(zip, (entryPath) => wanted.has(entryPath));

  const skills: DiscoveredSkill[] = skillDirs.map((skillDir) => ({
    repoSubpath: skillDir,
    dirName: skillDir === "" ? "" : lastSegment(skillDir),
    files: [],
  }));
  const byDir = new Map(skills.map((skill) => [skill.repoSubpath, skill]));

  for (const [entryPath, skillDir] of wanted) {
    const bytes = files.get(entryPath);
    if (!bytes) {
      continue;
    }
    const contentText = bytes.toString("utf8");
    if (!isUtf8Text(bytes, contentText)) {
      continue;
    }
    const prefix = skillDir === "" ? "" : `${skillDir}/`;
    const bundlePath = entryPath.slice(prefix.length);
    byDir.get(skillDir)?.files.push({
      bundlePath,
      // sha256 is over the raw bytes, so integrity stays byte-exact.
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mimeType: mimeTypeFor(bundlePath),
      contentText,
    });
  }
  for (const skill of skills) {
    skill.files.sort((left, right) =>
      left.bundlePath.localeCompare(right.bundlePath),
    );
  }

  return { source, commitSha: source.commitSha, skills };
}
