import { unzip } from "fflate";
import {
  GITHUB_ARCHIVE_LIMITS,
  GITHUB_REQUEST_TIMEOUTS,
  GitHubArchiveError,
  githubDownloadHeaders,
  githubFetch,
  githubTimeoutError,
  isGitHubTimeoutError,
  normalizeGitHubSource,
  resolveCommit,
  resolveDefaultBranch,
  type GitHubRequestOptions,
} from "./github";
import type { NormalizedGitHubSource } from "../types";

// Declared next to `githubFetch`, which raises the timeout; re-exported so this
// module stays the one import site for archive readers.
export { GitHubArchiveError, type GitHubArchiveErrorCode } from "./github";

/**
 * In-memory zipball reader for GitHub repository ingest.
 *
 * The host reads a submitted repository **without ever materialising a
 * filesystem tree**: one bounded zipball download, then `fflate` decompresses
 * only the entries we ask for, straight into buffers. Nothing is written to
 * disk, no archive path is ever joined onto a host directory, and no `tar`
 * subprocess runs — so extraction-time path traversal, symlink escape and
 * `--same-owner` restoration are not defended against here, they are absent.
 * (This is why neither the skills registry nor the MCP market uses
 * `github.ts`'s `prepareGitHubRepository`, which does download + `tar -xzf` to
 * `os.tmpdir()`. Its URL/API half — source normalisation and commit pinning —
 * is reused, because that half only ever touches strings.)
 *
 * The compressed-archive cap alone does not bound a decompression bomb, so the
 * reader enforces three more limits, all of them *before* any byte is
 * decompressed: a per-entry declared-size cap, an entry-count cap, and a
 * cumulative declared-size cap. Declared sizes come from the zip central
 * directory and are attacker-controlled, so the actual decompressed bytes are
 * re-checked afterwards — a lying `originalSize` fails the second gate.
 */

export const GITHUB_ZIP_LIMITS = Object.freeze({
  /** Compressed zipball ceiling — mirrors the MCP-market archive cap. */
  maxArchiveBytes: GITHUB_ARCHIVE_LIMITS.maxArchiveBytes,
  /** Entries considered across the whole repo (dirs excluded). */
  maxEntries: GITHUB_ARCHIVE_LIMITS.maxEntries,
  /** Per-file ceiling, applied to declared and actual size alike. */
  maxFileBytes: 512 * 1024,
  /** Cumulative uncompressed ceiling across every entry we decompress. */
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
});

const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

export type PinnedGitHubSource = NormalizedGitHubSource & {
  /** Immutable 40-hex commit every read and every stored pointer is pinned to. */
  commitSha: string;
  /**
   * Committer date of `commitSha` (ISO 8601). Undefined when the source named a
   * full sha and GitHub's commit metadata could not be read.
   */
  committedAt?: string;
};

/**
 * Resolve a submitted repo reference to an immutable commit. Only the repo URL
 * string and GitHub's JSON metadata are touched here; no archive bytes.
 */
export async function resolvePinnedGitHubSource(
  repoUrl: string,
  options?: GitHubRequestOptions,
): Promise<PinnedGitHubSource> {
  let source: NormalizedGitHubSource;
  try {
    source = normalizeGitHubSource(repoUrl);
  } catch (error) {
    throw new GitHubArchiveError(
      "ARCHIVE_UNAVAILABLE",
      error instanceof Error ? error.message : String(error),
    );
  }

  let ref = source.ref;
  if (!ref) {
    try {
      ref = await resolveDefaultBranch(source, options);
    } catch (error) {
      // A missing or private repository fails here first, with a plain Error
      // that no caller maps — it used to surface as an HTTP 500 instead of
      // "this repository is not available". Timeouts and caller aborts keep
      // their own error.
      if (error instanceof GitHubArchiveError || options?.signal?.aborted) {
        throw error;
      }
      throw new GitHubArchiveError(
        "ARCHIVE_UNAVAILABLE",
        `Could not read ${source.repoUrl}: it does not exist, is private, or GitHub is unreachable`,
      );
    }
  }
  const commit = await resolveCommit(source, ref, options);
  const commitSha = commit?.sha.toLowerCase();
  if (!commitSha || !COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new GitHubArchiveError(
      "ARCHIVE_UNPINNED",
      "Could not resolve an immutable commit SHA to pin this source",
    );
  }

  return {
    ...source,
    commitSha,
    ...(commit?.committedAt ? { committedAt: commit.committedAt } : {}),
  };
}

/**
 * Download the repository zipball at the pinned commit, bounded on both the
 * advertised and the observed body size so a hostile or runaway response cannot
 * exhaust host memory.
 */
export async function downloadRepoZip(
  source: PinnedGitHubSource,
  options: GitHubRequestOptions = {},
): Promise<Buffer> {
  const url = `https://codeload.github.com/${source.owner}/${source.repo}/zip/${source.commitSha}`;
  const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUTS.archiveMs;
  const response = await githubFetch(url, githubDownloadHeaders(), {
    ...options,
    timeoutMs,
  });
  if (!response.ok || !response.body) {
    throw new GitHubArchiveError(
      "ARCHIVE_UNAVAILABLE",
      `GitHub zipball download failed ${response.status}`,
    );
  }

  const advertised = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(advertised) &&
    advertised > GITHUB_ZIP_LIMITS.maxArchiveBytes
  ) {
    throw new GitHubArchiveError(
      "ARCHIVE_TOO_LARGE",
      "Repository archive exceeds the maximum allowed size",
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > GITHUB_ZIP_LIMITS.maxArchiveBytes) {
        throw new GitHubArchiveError(
          "ARCHIVE_TOO_LARGE",
          "Repository archive exceeds the maximum allowed size",
        );
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    // The deadline `githubFetch` set also covers the body: headers can arrive
    // promptly and the stream still stall, which surfaces here, not there.
    if (isGitHubTimeoutError(error) && !options.signal?.aborted) {
      throw githubTimeoutError(url, timeoutMs);
    }
    throw error;
  }
  return Buffer.concat(chunks, total);
}

/**
 * GitHub zipballs nest everything under a single `<repo>-<sha>/` directory.
 * Strip it so callers work in repo-root-relative paths. Returns `null` for the
 * root entry itself and for anything that does not sit under a root segment.
 */
function toRepoRelativePath(entryName: string): string | null {
  const slash = entryName.indexOf("/");
  if (slash < 0) {
    return null;
  }
  const rest = entryName.slice(slash + 1);
  return rest.length > 0 ? rest : null;
}

export type ZipEntryInfo = {
  /** Repo-root-relative path, `/`-separated. */
  path: string;
  /** Uncompressed size as declared by the archive (attacker-controlled). */
  declaredSize: number;
};

/**
 * Enumerate every file entry without decompressing any of them.
 *
 * `fflate`'s filter runs against the central directory for each entry and gets
 * the declared sizes, so returning `false` throughout yields the listing at the
 * cost of zero inflation.
 */
export async function listZipEntries(zip: Buffer): Promise<ZipEntryInfo[]> {
  const entries: ZipEntryInfo[] = [];
  await new Promise<void>((resolve, reject) => {
    unzip(
      zip,
      {
        filter: (file) => {
          const path = toRepoRelativePath(file.name);
          if (path && !path.endsWith("/")) {
            entries.push({ path, declaredSize: file.originalSize });
          }
          return false;
        },
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });

  if (entries.length > GITHUB_ZIP_LIMITS.maxEntries) {
    throw new GitHubArchiveError(
      "ARCHIVE_TOO_LARGE",
      `Repository archive exceeds the maximum allowed ${GITHUB_ZIP_LIMITS.maxEntries} files`,
    );
  }
  return entries;
}

/**
 * Decompress exactly the entries `keep` selects, enforcing the size ceilings.
 *
 * Both gates matter: the declared-size checks run inside the filter so an
 * oversized or bomb-shaped entry is never inflated at all, and the actual-size
 * check afterwards catches an archive that under-declares to slip past them.
 */
export type ReadZipEntriesOptions = {
  /**
   * What to do with an entry over `maxFileBytes`.
   *
   * `reject` (default) fails the whole read — right when the entry set IS the
   * deliverable, as for a skill bundle whose fileManifest promises every file.
   * `skip` drops it and keeps going — right when the caller is prospecting a
   * whole repository and a single large asset should not sink the ingest.
   */
  oversize?: "reject" | "skip";
};

export async function readZipEntries(
  zip: Buffer,
  keep: (path: string) => boolean,
  options: ReadZipEntriesOptions = {},
): Promise<Map<string, Buffer>> {
  const oversize = options.oversize ?? "reject";
  let declaredTotal = 0;
  let rejection: GitHubArchiveError | null = null;

  const unzipped = await new Promise<Record<string, Uint8Array>>(
    (resolve, reject) => {
      unzip(
        zip,
        {
          filter: (file) => {
            if (rejection) {
              return false;
            }
            const path = toRepoRelativePath(file.name);
            if (!path || path.endsWith("/") || !keep(path)) {
              return false;
            }
            if (file.originalSize > GITHUB_ZIP_LIMITS.maxFileBytes) {
              if (oversize === "skip") {
                return false;
              }
              rejection = new GitHubArchiveError(
                "ARCHIVE_TOO_LARGE",
                `File '${path}' exceeds the per-file size limit`,
              );
              return false;
            }
            declaredTotal += file.originalSize;
            if (declaredTotal > GITHUB_ZIP_LIMITS.maxTotalUncompressedBytes) {
              rejection = new GitHubArchiveError(
                "ARCHIVE_TOO_LARGE",
                "Repository archive expands beyond the maximum allowed size",
              );
              return false;
            }
            return true;
          },
        },
        (error, out) => (error ? reject(error) : resolve(out)),
      );
    },
  );

  if (rejection) {
    throw rejection;
  }

  const files = new Map<string, Buffer>();
  let actualTotal = 0;
  for (const [entryName, bytes] of Object.entries(unzipped)) {
    const path = toRepoRelativePath(entryName);
    if (!path) {
      continue;
    }
    if (bytes.byteLength > GITHUB_ZIP_LIMITS.maxFileBytes) {
      if (oversize === "skip") {
        continue;
      }
      throw new GitHubArchiveError(
        "ARCHIVE_TOO_LARGE",
        `File '${path}' exceeds the per-file size limit`,
      );
    }
    actualTotal += bytes.byteLength;
    if (actualTotal > GITHUB_ZIP_LIMITS.maxTotalUncompressedBytes) {
      throw new GitHubArchiveError(
        "ARCHIVE_TOO_LARGE",
        "Repository archive expands beyond the maximum allowed size",
      );
    }
    files.set(path, Buffer.from(bytes));
  }
  return files;
}
