import { createHash } from "node:crypto";
import path from "node:path";
import type { SkillManifestJson } from "@sourceweft/db";
import type { SkillBundleFile } from "../builtin";

/**
 * Runtime fetch-on-use for registry (`sourceType='registry_github'`) skills
 * (docs/architecture/skill-registry-index.md §6a, build phase R5).
 *
 * A `storageType='pointer'` version stores ZERO file bodies (invariant 2 —
 * the redistribution tripwire). At resolve time we fetch each declared file
 * **individually by path** from GitHub raw at the pinned commit, using the
 * `fileManifest` captured at ingest. There is no tarball, no `tar`, no
 * extraction on the host, so the archive-bomb / symlink / dropped-executable
 * class never exists at runtime. Every fetched file is verified against its
 * manifest sha256; any mismatch rejects the whole skill (tamper/corruption).
 *
 * Failure is graceful: a transient fetch failure, timeout, oversize file, or
 * integrity mismatch returns `null` so the caller can SKIP the skill without
 * failing the turn (§6a). No content is ever persisted — the only cache is an
 * ephemeral in-process LRU (legal control: fetch-on-use, no durable cache).
 */

type RegistryManifest = NonNullable<SkillManifestJson["registry"]>;
type RegistryFileManifestEntry = RegistryManifest["fileManifest"][number];

/**
 * Hard per-file ceiling, independent of the manifest's declared `sizeBytes`.
 * The manifest is third-party metadata and must never be able to request an
 * unbounded fetch, so a file whose declared size exceeds this is rejected up
 * front and the read is aborted if the wire exceeds it anyway.
 */
const MAX_POINTER_FILE_BYTES = 512 * 1024; // 512 KiB
const POINTER_FETCH_TIMEOUT_MS = 10_000;
const POINTER_FETCH_MAX_RETRIES = 3;
const POINTER_FETCH_BASE_BACKOFF_MS = 300;
const POINTER_FETCH_MAX_TOTAL_WAIT_MS = 30_000;
/** Ephemeral in-process cache only; keyed by the (sha-pinned) storagePointer. */
const POINTER_LRU_LIMIT = 32;

const RAW_HOST = "https://raw.githubusercontent.com";
const USER_AGENT = "SourceWeft-Skill-Registry/1.0";

// Mirrors builtin.ts TEXT_MIME_BY_EXTENSION — model-readable resources are text.
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
  if (!value) {
    return "";
  }
  const segments = value.split("/").filter((segment) => segment.length > 0);
  // Reject traversal — the subpath names a directory inside the pinned repo.
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
    ? groups.repo.slice(0, -4)
    : groups.repo;
  return {
    owner: groups.owner,
    repo,
    sha: groups.sha.toLowerCase(),
    subpath,
  };
}

/**
 * A bundle-relative manifest path (e.g. `SKILL.md`, `scripts/run.py`) is safe
 * to fetch only if it stays inside the skill directory. Reject anything that
 * could escape the pinned subpath or hit an absolute/host path.
 */
function safeManifestPath(filePath: string): boolean {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\0")) {
    return false;
  }
  const normalized = path.posix.normalize(filePath);
  return (
    normalized === filePath &&
    !normalized.startsWith("../") &&
    normalized !== ".." &&
    !normalized.includes("/../")
  );
}

function rawFileUrl(pointer: ParsedPointer, filePath: string): string {
  const repoPath = pointer.subpath
    ? `${pointer.subpath}/${filePath}`
    : filePath;
  const encoded = repoPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${RAW_HOST}/${pointer.owner}/${pointer.repo}/${pointer.sha}/${encoded}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Fetch one raw file with bounded retries + per-attempt timeout, mirroring the
 * retry/rate-limit posture of market/parser/github.ts `githubFetch` but with an
 * injectable fetch (for tests) and a size cap. Returns `null` on any terminal
 * failure — the caller turns that into a skip.
 */
async function fetchRawFile(input: {
  url: string;
  maxBytes: number;
  fetchImpl: typeof fetch;
}): Promise<Buffer | null> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let totalWaited = 0;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await input.fetchImpl(input.url, {
        headers,
        signal: AbortSignal.timeout(POINTER_FETCH_TIMEOUT_MS),
      });
    } catch {
      // Network error / timeout — retry within budget, else give up (skip).
      if (attempt >= POINTER_FETCH_MAX_RETRIES) {
        return null;
      }
      const delay = POINTER_FETCH_BASE_BACKOFF_MS * 2 ** attempt;
      if (totalWaited + delay > POINTER_FETCH_MAX_TOTAL_WAIT_MS) {
        return null;
      }
      totalWaited += delay;
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (response.ok) {
      // Reject early if the server advertises a body over the cap.
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > input.maxBytes) {
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > input.maxBytes) {
        return null;
      }
      return buffer;
    }

    if (
      attempt >= POINTER_FETCH_MAX_RETRIES ||
      !isRetryableStatus(response.status)
    ) {
      return null;
    }
    const delay = POINTER_FETCH_BASE_BACKOFF_MS * 2 ** attempt;
    if (totalWaited + delay > POINTER_FETCH_MAX_TOTAL_WAIT_MS) {
      return null;
    }
    totalWaited += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
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
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Resolve a registry skill's model-readable files by fetching each declared
 * `model-readable` file from GitHub raw at the pinned commit and verifying it
 * against the manifest sha256. Returns the verified `SkillBundleFile[]` (same
 * shape the `repo_builtin`/`db_text` branches produce), or `null` so the caller
 * skips the skill without failing the turn.
 *
 * `script`-role files are intentionally NOT fetched here: they are opaque bytes
 * that must be streamed straight into the execution sandbox, never opened on the
 * host (docs/architecture/skill-registry-index.md §6b execution sandbox). The
 * downstream /skills staging pipeline handles script execution once the
 * model-readable bundle is mounted, so no SelectedSkillsBackend change is
 * needed here.
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
  if (!registry || !Array.isArray(registry.fileManifest)) {
    return null;
  }

  const modelReadable = registry.fileManifest.filter(
    (entry): entry is RegistryFileManifestEntry =>
      entry.role === "model-readable",
  );
  if (modelReadable.length === 0) {
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const files: SkillBundleFile[] = [];
  for (const entry of modelReadable) {
    if (!safeManifestPath(entry.path)) {
      return null;
    }
    // A declared size over the hard cap can never fetch to a matching hash.
    if (
      typeof entry.sizeBytes === "number" &&
      entry.sizeBytes > MAX_POINTER_FILE_BYTES
    ) {
      return null;
    }
    const buffer = await fetchRawFile({
      url: rawFileUrl(pointer, entry.path),
      maxBytes: MAX_POINTER_FILE_BYTES,
      fetchImpl,
    });
    if (!buffer) {
      return null;
    }
    const digest = sha256(buffer);
    if (digest !== entry.sha256.toLowerCase()) {
      return null;
    }
    // Ties the version's contentHash (sha256 of the analyzed SKILL.md) to the
    // fetched SKILL.md — a defense-in-depth check beyond per-file integrity.
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
}
