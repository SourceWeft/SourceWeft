import { sha256 } from "../hash";
import { SKILL_STORAGE_LIMITS } from "../storage";
import { RegistrySubmissionError } from "./errors";
import {
  downloadRepoZip,
  GitHubArchiveError,
  listZipEntries,
  readZipEntries,
  resolvePinnedGitHubSource,
  type PinnedGitHubSource,
} from "../../market/parser/github-zip";
import type { GitHubRequestOptions } from "../../market/parser/github";

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
 * What one skill bundle may carry is `SKILL_STORAGE_LIMITS` — the same numbers
 * the object store and the sandbox staging run under, so a skill that can be
 * indexed can always be stored and staged. The archive-level caps (compressed
 * size, entry count, cumulative uncompressed size) live in `github-zip.ts`.
 * What is left here is the one bound that is about the catalog, not bytes.
 */
export const REGISTRY_READ_LIMITS = Object.freeze({
  /**
   * An anti-spam bound on the SHARED catalog, not a resource bound — bytes are
   * already capped in `github-zip.ts`, and a 90-skill repository measured only
   * 309 files and 2.7 MiB against a 64 MiB budget. What a count protects is
   * `skill_definitions`: slugs are globally unique and cross-workspace, so one
   * submission of thousands of tiny SKILL.md files would flood the catalog for
   * everyone while sailing past every byte ceiling.
   *
   * Observed real repositories run 1, 13, 14, 17, 20, 25, 90 skills, so 200
   * leaves room for the largest curated sets. Crossing it is not a dead end:
   * the error points at the `/tree/<ref>/<subpath>` deep link, which narrows a
   * submission to one subtree — the same one-skill-per-submission shape LobeHub
   * and Dify use as their ONLY intake, kept here as the fallback.
   */
  maxSkillsPerRepo: 200,
});

/** Directories that are never skill content (mirrors builtin.ts denylist). */
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);
/** Containers under which per-skill subdirectories live (§3 Stage 2). */
const SKILL_CONTAINERS = ["skills", ".claude/skills", ".agents/skills"];

/** Mirrors builtin.ts TEXT_MIME_BY_EXTENSION; any other text serves as plain. */
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

/**
 * What skills actually ship next to their text: fonts (anthropics/skills
 * carries 56 `.ttf` under `canvas-design/`), images, document templates. The
 * type is recorded on the manifest row and set on the stored blob; a binary
 * with no entry here is an opaque octet stream.
 */
const BINARY_MIME_BY_EXTENSION: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".dotx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xltx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".potx":
    "application/vnd.openxmlformats-officedocument.presentationml.template",
};

/**
 * Whether the bytes are text a reader can be handed as a string: valid UTF-8
 * with no NUL. Decided by round-trip, not by extension — a lossy decode would
 * produce a string whose bytes no longer match the file's sha256. Everything
 * else is carried as the bytes it is; nothing is dropped for being binary.
 */
function isUtf8Text(bytes: Buffer, decoded: string): boolean {
  return !decoded.includes("\0") && Buffer.from(decoded, "utf8").equals(bytes);
}

function mimeTypeFor(bundlePath: string, isText: boolean): string {
  const dot = bundlePath.lastIndexOf(".");
  const ext = dot < 0 ? "" : bundlePath.slice(dot).toLowerCase();
  return isText
    ? (TEXT_MIME_BY_EXTENSION[ext] ?? "text/plain")
    : (BINARY_MIME_BY_EXTENSION[ext] ?? "application/octet-stream");
}

export type DiscoveredSkillFile = {
  /** Path relative to the skill BUNDLE root (e.g. `SKILL.md`, `scripts/run.py`). */
  bundlePath: string;
  /** sha256 over the raw file bytes. */
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  /** The file exactly as the archive held it — what is stored and bundled. */
  bytes: Uint8Array;
} & (
  | {
      isText: true;
      /**
       * `bytes` decoded, for the consumers that read text: the safety scan,
       * frontmatter parsing, logo metadata. Never what gets stored.
       */
      contentText: string;
    }
  | { isText: false; contentText: null }
);

/** Build a `DiscoveredSkillFile` from raw bytes; the one place `isText` is decided. */
export function discoveredSkillFile(
  bundlePath: string,
  raw: Uint8Array,
): DiscoveredSkillFile {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const decoded = bytes.toString("utf8");
  const isText = isUtf8Text(bytes, decoded);
  const base = {
    bundlePath,
    // sha256 is over the raw bytes, so integrity stays byte-exact.
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mimeType: mimeTypeFor(bundlePath, isText),
    bytes,
  };
  return isText
    ? { ...base, isText: true, contentText: decoded }
    : { ...base, isText: false, contentText: null };
}

export type DiscoveredSkill = {
  /**
   * Skill directory relative to the REPO ROOT. Empty string when the skill sits
   * at the repo root.
   */
  repoSubpath: string;
  /** Last path segment of the skill dir. */
  dirName: string;
  files: DiscoveredSkillFile[];
  /**
   * Set when the bundle is over a storage limit. None of its files were read,
   * and analysis reports this as the skill's own failure — so one oversized
   * skill does not cost a repository its other skills, and a skill is never
   * indexed with part of its bundle missing.
   */
  rejection?: RegistrySubmissionError;
};

export type ReadRegistryResult = {
  source: PinnedGitHubSource;
  /** Immutable 40-hex commit the submission is pinned to. */
  commitSha: string;
  /**
   * Committer date of `commitSha` (ISO 8601). Orders this submission against
   * other commits of the same skill when deciding which version is current, so
   * a submission without one is refused (`requireCommittedAt`).
   */
  committedAt: string;
  skills: DiscoveredSkill[];
};

/**
 * Every registry version is ordered by its commit's age, so an undated one
 * cannot be placed: it would either never become current or always do. GitHub
 * only fails to supply the date when the source named a full sha and the commit
 * metadata read failed — a later attempt can succeed, which is why the ingest
 * treats this code as transient.
 */
export function requireCommittedAt(source: PinnedGitHubSource): string {
  const ms = source.committedAt ? Date.parse(source.committedAt) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_UNDATED",
      `Could not read the commit date of ${source.commitSha.slice(0, 12)} from GitHub, and a skill version cannot be ordered without it. Try again shortly.`,
    );
  }
  return source.committedAt!;
}

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

/**
 * The three bundle limits, against whatever sizes are known. Run twice: on the
 * archive's DECLARED sizes before anything is inflated, and again on the actual
 * bytes, because declared sizes are attacker-controlled.
 */
function bundleLimitViolation(
  skillDir: string,
  files: ReadonlyArray<{ path: string; sizeBytes: number }>,
): RegistrySubmissionError | null {
  const label =
    skillDir === ""
      ? "The skill at the repository root"
      : `Skill '${skillDir}'`;
  const limits = SKILL_STORAGE_LIMITS;
  if (files.length > limits.maxFiles) {
    return new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_TOO_LARGE",
      `${label} has ${files.length} files, more than the ${limits.maxFiles}-file limit for one skill`,
    );
  }
  const oversize = files.find((file) => file.sizeBytes > limits.maxFileBytes);
  if (oversize) {
    return new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_TOO_LARGE",
      `${label}: file '${oversize.path}' is ${formatMiB(oversize.sizeBytes)}, more than the ${formatMiB(limits.maxFileBytes)} limit for one file`,
    );
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (total > limits.maxBundleBytes) {
    return new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_TOO_LARGE",
      `${label} is ${formatMiB(total)} in total, more than the ${formatMiB(limits.maxBundleBytes)} limit for one skill`,
    );
  }
  return null;
}

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
 * Locate every skill directory — any directory holding a `SKILL.md`.
 *
 * Where it looks depends on how the repo was submitted:
 *
 * - **Whole repo** (no subpath): the repo root, plus anything at any depth
 *   beneath `skills/`, `.claude/skills/`, `.agents/skills/`. Depth is unbounded
 *   because requiring exactly one level was an assumption about layout, not a
 *   rule anyone follows — repos shipping more than a handful group them by
 *   topic (`skills/1-brand-marketing/seo-brief-writer/`), and the old check made
 *   a 90-skill repository discover zero. The containers still scope the scan, so
 *   a `SKILL.md` sitting in `docs/` as sample content is not mistaken for a
 *   skill.
 * - **A `/tree/<ref>/<subpath>` deep link**: that subtree, and nothing else. An
 *   explicit subpath IS the statement of where to look, so the container names
 *   no longer apply — insisting on them here is what made deep links fail
 *   entirely, since scoping into `skills/1-brand-marketing/` strips the very
 *   `skills/` prefix the check was looking for. This is the escape hatch for a
 *   repository too large to index whole.
 *
 * Exported for tests: this is a pure function of the archive's path list, and
 * it decides whether a repository is importable at all.
 */
export function discoverSkillDirectories(
  entryPaths: string[],
  subpath = "",
): string[] {
  const scope = subpath ? `${subpath}/` : "";
  const dirs: string[] = [];
  for (const entryPath of entryPaths) {
    // The basename must be exactly SKILL.md — `endsWith` alone would also
    // match `NOT-SKILL.md` or `MY-SKILL.md` and index their directory.
    if (lastSegment(entryPath) !== "SKILL.md") {
      continue;
    }
    const dir = dirNameOf(entryPath);
    if (scope) {
      if (dir === subpath || dir.startsWith(scope)) {
        dirs.push(dir);
      }
      continue;
    }
    if (dir === "") {
      dirs.push("");
      continue;
    }
    if (SKILL_CONTAINERS.some((container) => dir.startsWith(`${container}/`))) {
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
 * Map the shared reader's transport/size failures onto submission errors; it
 * deliberately knows nothing about this module's error taxonomy. Anything else
 * is returned untouched for the caller to rethrow.
 */
export function mapRegistryArchiveError(error: unknown): unknown {
  if (!(error instanceof GitHubArchiveError)) {
    return error;
  }
  return new RegistrySubmissionError(
    error.code === "ARCHIVE_TOO_LARGE"
      ? "REGISTRY_SUBMISSION_TOO_LARGE"
      : error.code === "ARCHIVE_UNPINNED"
        ? "REGISTRY_SUBMISSION_UNPINNED"
        : error.code === "ARCHIVE_TIMEOUT"
          ? "REGISTRY_SUBMISSION_TIMEOUT"
          : "REGISTRY_SUBMISSION_NOT_SKILL",
    error.message,
  );
}

/**
 * Fetch a submitted GitHub repo as an in-memory zipball and return every
 * discovered skill bundle with per-file digests. The commit is pinned to an
 * immutable 40-hex sha (rejected otherwise — the record must be frozen, §2/§5).
 *
 * The asynchronous ingest runs the same three steps as separate stages
 * (`resolvePinnedGitHubSource` → `downloadRepoZip` →
 * `readRegistrySkillsFromArchive`) so it can report progress between them.
 */
export async function readRegistrySkillsFromGitHub(
  repoUrl: string,
  options?: GitHubRequestOptions,
): Promise<ReadRegistryResult> {
  try {
    const source = await resolvePinnedGitHubSource(repoUrl, options);
    // Before the download: an undated commit is refused whatever it contains.
    requireCommittedAt(source);
    const zip = await downloadRepoZip(source, options);
    return await readRegistrySkillsFromArchive(zip, source);
  } catch (error) {
    throw mapRegistryArchiveError(error);
  }
}

/** Locate and read every skill bundle in an already-downloaded zipball. */
export async function readRegistrySkillsFromArchive(
  zip: Buffer,
  source: PinnedGitHubSource,
): Promise<ReadRegistryResult> {
  const committedAt = requireCommittedAt(source);
  const entries = await listZipEntries(zip);
  const entryPaths = entries.map((entry) => entry.path);
  const skillDirs = discoverSkillDirectories(entryPaths, source.subpath);

  if (skillDirs.length === 0) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_NOT_SKILL",
      "No SKILL.md found at the repo root or under skills/, .claude/skills/, .agents/skills/",
    );
  }
  if (skillDirs.length > REGISTRY_READ_LIMITS.maxSkillsPerRepo) {
    throw new RegistrySubmissionError(
      "REGISTRY_SUBMISSION_TOO_LARGE",
      `Repository ships ${skillDirs.length} skills, more than the ${REGISTRY_READ_LIMITS.maxSkillsPerRepo}-skill limit for a single submission. Submit a subdirectory instead — a URL like https://github.com/owner/repo/tree/<branch>/skills/<group> indexes only that subtree.`,
    );
  }

  // A file belongs to the innermost skill that contains it: the longest
  // matching skill dir wins, so a nested skill's files are not also counted
  // against (or bundled into) the skill above it.
  const ownerOf = new Map<string, string>();
  for (const skillDir of skillDirs) {
    for (const entryPath of entryPaths) {
      if (!isBundleFile(skillDir, entryPath)) {
        continue;
      }
      const current = ownerOf.get(entryPath);
      if (current === undefined || skillDir.length > current.length) {
        ownerOf.set(entryPath, skillDir);
      }
    }
  }

  const skills: DiscoveredSkill[] = skillDirs.map((skillDir) => ({
    repoSubpath: skillDir,
    dirName: skillDir === "" ? "" : lastSegment(skillDir),
    files: [],
  }));
  const byDir = new Map(skills.map((skill) => [skill.repoSubpath, skill]));
  const bundlePathOf = (entryPath: string, skillDir: string) =>
    entryPath.slice(skillDir === "" ? 0 : skillDir.length + 1);

  // First gate, on declared sizes: an over-limit skill is refused before a
  // byte of it is inflated, and its files are left out of the read.
  const declared = new Map<
    string,
    Array<{ path: string; sizeBytes: number }>
  >();
  for (const entry of entries) {
    const skillDir = ownerOf.get(entry.path);
    if (skillDir === undefined) {
      continue;
    }
    const list = declared.get(skillDir) ?? [];
    list.push({
      path: bundlePathOf(entry.path, skillDir),
      sizeBytes: entry.declaredSize,
    });
    declared.set(skillDir, list);
  }
  for (const skill of skills) {
    const rejection = bundleLimitViolation(
      skill.repoSubpath,
      declared.get(skill.repoSubpath) ?? [],
    );
    if (rejection) {
      skill.rejection = rejection;
    }
  }

  const wanted = new Map(
    [...ownerOf].filter(([, skillDir]) => !byDir.get(skillDir)!.rejection),
  );
  const files = await readZipEntries(
    zip,
    (entryPath) => wanted.has(entryPath),
    // Fonts, images and templates are bundle content: the per-file ceiling for
    // a skill is the storage limit, not the reader's manifest-sized default.
    { maxFileBytes: SKILL_STORAGE_LIMITS.maxFileBytes },
  );

  for (const [entryPath, skillDir] of wanted) {
    const bytes = files.get(entryPath);
    if (!bytes)
      throw new RegistrySubmissionError(
        "REGISTRY_READ_FAILED",
        "A requested archive file could not be read",
      );
    byDir
      .get(skillDir)!
      .files.push(
        discoveredSkillFile(bundlePathOf(entryPath, skillDir), bytes),
      );
  }
  // Second gate, on what was actually inflated.
  for (const skill of skills) {
    const rejection = bundleLimitViolation(
      skill.repoSubpath,
      skill.files.map((file) => ({
        path: file.bundlePath,
        sizeBytes: file.sizeBytes,
      })),
    );
    if (rejection) {
      skill.rejection = rejection;
      skill.files = [];
    }
  }
  for (const skill of skills) {
    skill.files.sort((left, right) =>
      left.bundlePath.localeCompare(right.bundlePath),
    );
  }

  return { source, commitSha: source.commitSha, committedAt, skills };
}
