import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SkillManifestJson } from "@sourceweft/db";
import {
  cleanupGitHubRepository,
  prepareGitHubRepository,
} from "../../market/parser/github";
import type { SkillBundleFile } from "../builtin";

/**
 * Runtime fetch-on-use for registry (`sourceType='registry_github'`) skills
 * (docs/architecture/skill-registry-index.md §6a, build phase R5).
 *
 * A `storageType='pointer'` version stores ZERO file bodies (invariant 2 —
 * the redistribution tripwire). At resolve time we download the repo tarball
 * at the pinned commit — ONE request instead of one per file — through the
 * same hardened path the submit-time ingest uses (`prepareGitHubRepository`:
 * archive-size / file-count caps, symlink + traversal rejection,
 * `--no-same-owner`), then read exactly the files the ingest-time
 * `fileManifest` declares and verify each against its manifest sha256. Any
 * missing file or digest mismatch rejects the whole skill (tamper).
 *
 * ALL manifest roles are returned — `script` files included. Registry skills
 * thereby match builtin-skill parity: scripts ride the same
 * EnabledSkillDescriptor → /skills staging pipeline into the sandbox, which is
 * what makes an `executable` registry skill actually executable
 * (verified live 2026-08-12: the per-file/model-readable-only predecessor left
 * pptx's 54 scripts behind and executable skills could never run).
 *
 * A download failure, oversize file, or integrity mismatch returns `null` as a
 * precise loader failure signal. Turn preparation treats that signal as fatal
 * for a selected skill; it is never silently removed. No content is ever
 * persisted — the only cache is an ephemeral
 * in-process LRU (legal control: fetch-on-use, no durable cache). Bundles are
 * text-only (`contentText`), mirroring the ingest reader; binary assets are a
 * known non-goal of v1.
 */

type RegistryManifest = NonNullable<SkillManifestJson["registry"]>;
type RegistryFileManifestEntry = RegistryManifest["fileManifest"][number];

/**
 * Hard per-file ceiling, independent of the manifest's declared `sizeBytes`.
 * The manifest is third-party metadata and must never be able to request an
 * unbounded read (mirrors REGISTRY_READ_LIMITS.maxSkillFileBytes).
 */
const MAX_POINTER_FILE_BYTES = 512 * 1024; // 512 KiB
/** Mirrors REGISTRY_READ_LIMITS.maxSkillFilesPerBundle. */
const MAX_POINTER_MANIFEST_FILES = 200;
/**
 * Ephemeral in-process cache only; keyed by the (sha-pinned) storagePointer.
 * Full bundles (scripts included) are larger than the old model-readable-only
 * entries, so the limit is small: 8 × worst-case ~a few MB stays bounded.
 */
const POINTER_LRU_LIMIT = 8;

// Mirrors builtin.ts TEXT_MIME_BY_EXTENSION; anything else serves as plain text.
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export type ParsedPointer = {
  owner: string;
  repo: string;
  /** Full 40-hex commit sha — the immutable pin (§2/§6a). */
  sha: string;
  /** Skill directory within the repo; "" when the skill is at the repo root. */
  subpath: string;
};

// github:<owner>/<repo>@<sha>#<path> — <path> optional (skill at repo root).
const POINTER_PATTERN =
  /^github:(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)@(?<sha>[a-f0-9]{40})(?:#(?<subpath>.*))?$/i;

function cleanSubpath(value: string | undefined): string | null {
  if (value === undefined || value === "") {
    return "";
  }
  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

export function parsePointer(storagePointer: string): ParsedPointer | null {
  const match = storagePointer.trim().match(POINTER_PATTERN);
  const groups = match?.groups;
  if (!groups?.owner || !groups.repo || !groups.sha) {
    return null;
  }
  const subpath = cleanSubpath(groups.subpath);
  if (subpath === null) {
    return null;
  }
  const repo = groups.repo.endsWith(".git")
    ? groups.repo.slice(0, -".git".length)
    : groups.repo;
  if (repo.length === 0) {
    return null;
  }
  return {
    owner: groups.owner,
    repo,
    sha: groups.sha.toLowerCase(),
    subpath,
  };
}

/** Bundle-relative manifest paths only: no absolute, no traversal. */
function safeManifestPath(filePath: string): boolean {
  if (filePath.length === 0 || filePath.startsWith("/")) {
    return false;
  }
  const normalized = path.posix.normalize(filePath);
  return (
    !normalized.startsWith("..") &&
    !normalized.includes("../") &&
    normalized !== ".."
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Simple insertion-ordered LRU (mirrors sandbox-assets.ts zipCache): re-set on
// hit to mark most-recent; evict the oldest key when over the limit.
const pointerBundleCache = new Map<string, SkillBundleFile[]>();

function cacheGet(key: string): SkillBundleFile[] | undefined {
  const hit = pointerBundleCache.get(key);
  if (hit) {
    pointerBundleCache.delete(key);
    pointerBundleCache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: SkillBundleFile[]): void {
  if (pointerBundleCache.has(key)) {
    pointerBundleCache.delete(key);
  } else if (pointerBundleCache.size >= POINTER_LRU_LIMIT) {
    const oldest = pointerBundleCache.keys().next().value;
    if (oldest !== undefined) {
      pointerBundleCache.delete(oldest);
    }
  }
  pointerBundleCache.set(key, value);
}

/** Test-only: reset the in-process LRU between cases. */
export function __clearPointerBundleCache(): void {
  pointerBundleCache.clear();
}

export type LoadPointerSkillBundleOptions = {
  /**
   * Injectable repository preparer (tests). Defaults to the hardened
   * market-parser download+extract. Must resolve the tarball at the pinned
   * commit into a temp dir and report `rootDir` + `tempRoot`.
   */
  prepareRepository?: typeof prepareGitHubRepository;
  /** Injectable cleanup counterpart (tests). */
  cleanupRepository?: typeof cleanupGitHubRepository;
};

/**
 * Resolve a registry skill's full bundle: one hardened tarball download at the
 * pinned commit, then read + sha256-verify every `fileManifest` entry (all
 * roles). Returns the verified `SkillBundleFile[]` (same shape the
 * `repo_builtin`/`db_text` branches produce), or `null` when loading or
 * integrity verification fails.
 */
export async function loadPointerSkillBundle(
  storagePointer: string,
  contentHash: string,
  registry: RegistryManifest | undefined,
  options: LoadPointerSkillBundleOptions = {},
): Promise<SkillBundleFile[] | null> {
  const cached = cacheGet(storagePointer);
  if (cached) {
    return cached;
  }

  const pointer = parsePointer(storagePointer);
  if (!pointer) {
    return null;
  }
  const manifest = registry?.fileManifest;
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return null;
  }
  if (manifest.length > MAX_POINTER_MANIFEST_FILES) {
    return null;
  }
  for (const entry of manifest) {
    if (!safeManifestPath(entry.path)) {
      return null;
    }
    // A declared size over the hard cap can never verify to a matching hash.
    if (
      typeof entry.sizeBytes === "number" &&
      entry.sizeBytes > MAX_POINTER_FILE_BYTES
    ) {
      return null;
    }
  }

  const prepare = options.prepareRepository ?? prepareGitHubRepository;
  const cleanup = options.cleanupRepository ?? cleanupGitHubRepository;

  // /tree/<sha> pins the tarball to the immutable commit; the prepared
  // result's commitSha must agree or something upstream is lying.
  const treeUrl = `https://github.com/${pointer.owner}/${pointer.repo}/tree/${pointer.sha}`;
  let repository: Awaited<ReturnType<typeof prepareGitHubRepository>>;
  try {
    repository = await prepare(treeUrl);
  } catch {
    return null;
  }

  try {
    if (repository.commitSha?.toLowerCase() !== pointer.sha) {
      return null;
    }
    const skillRoot = pointer.subpath
      ? path.join(repository.rootDir, pointer.subpath)
      : repository.rootDir;
    // The extracted tree is ours (hardened extract rejects traversal), but the
    // joined skill root must still sit inside it.
    const relativeRoot = path.relative(repository.rootDir, skillRoot);
    if (relativeRoot.startsWith("..")) {
      return null;
    }

    const files: SkillBundleFile[] = [];
    for (const entry of manifest as RegistryFileManifestEntry[]) {
      const filePath = path.join(skillRoot, entry.path);
      let size: number;
      try {
        const info = await stat(filePath);
        if (!info.isFile()) {
          return null;
        }
        size = info.size;
      } catch {
        // Manifest promises a file the pinned tarball doesn't have → tamper
        // or ingest drift; reject the whole skill.
        return null;
      }
      if (size > MAX_POINTER_FILE_BYTES) {
        return null;
      }
      const buffer = await readFile(filePath);
      const digest = sha256(buffer);
      if (digest !== entry.sha256.toLowerCase()) {
        return null;
      }
      // Ties the version's contentHash (sha256 of the analyzed SKILL.md) to
      // the extracted SKILL.md — defense-in-depth beyond per-file integrity.
      if (entry.path === "SKILL.md" && digest !== contentHash.toLowerCase()) {
        return null;
      }
      const ext = path.posix.extname(entry.path).toLowerCase();
      files.push({
        path: entry.path,
        contentText: buffer.toString("utf8"),
        mimeType: TEXT_MIME_BY_EXTENSION[ext] ?? "text/plain",
        sizeBytes: buffer.byteLength,
        contentHash: digest,
      });
    }

    cacheSet(storagePointer, files);
    return files;
  } finally {
    await cleanup(repository);
  }
}
