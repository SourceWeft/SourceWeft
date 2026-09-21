import {
  readSkillArchive,
  type ReadSkillArchiveOptions,
} from "@sourceweft/skill-format";

/**
 * Fetches a skill's bytes from GitHub at a pinned commit.
 *
 * The registry only indexes a skill — where it lives and what its files hash
 * to — so the bytes always come from the upstream repository. Pinning to a full
 * commit sha makes the download immutable: the same URL yields the same
 * archive, which is what lets the caller verify it against the indexed hashes.
 */

const CODELOAD = "https://codeload.github.com";
/** Hosts a redirect may lead to; a token is never sent anywhere else. */
const TRUSTED_HOSTS = new Set(["codeload.github.com", "github.com"]);
const MAX_REDIRECTS = 3;

/** Compressed zipball ceiling — same bound the registry applies at ingest. */
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;

export type GitHubSourceErrorCode =
  "INVALID_SOURCE" | "NOT_FOUND" | "RATE_LIMITED" | "UNAVAILABLE" | "TOO_LARGE";

export class GitHubSourceError extends Error {
  readonly code: GitHubSourceErrorCode;

  constructor(code: GitHubSourceErrorCode, message: string) {
    super(message);
    this.name = "GitHubSourceError";
    this.code = code;
  }
}

export type PinnedRepo = {
  owner: string;
  repo: string;
  /** Full 40-hex commit sha; a branch or tag is not accepted. */
  commitSha: string;
};

export type DownloadOptions = {
  /** Sent as a bearer token to GitHub hosts only. Optional; raises rate limits. */
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Override for tests. */
  baseUrl?: string;
};

export function assertPinnedRepo(source: PinnedRepo): void {
  if (!OWNER_PATTERN.test(source.owner) || !REPO_PATTERN.test(source.repo)) {
    throw new GitHubSourceError(
      "INVALID_SOURCE",
      `'${source.owner}/${source.repo}' is not a valid GitHub repository`,
    );
  }
  if (source.repo === "." || source.repo === "..") {
    throw new GitHubSourceError("INVALID_SOURCE", "Invalid repository name");
  }
  if (!COMMIT_SHA_PATTERN.test(source.commitSha)) {
    throw new GitHubSourceError(
      "INVALID_SOURCE",
      "A skill must be pinned to a full 40-character commit sha",
    );
  }
}

export function codeloadUrl(source: PinnedRepo, baseUrl = CODELOAD): string {
  return `${baseUrl}/${source.owner}/${source.repo}/zip/${source.commitSha}`;
}

function isTrusted(url: URL, baseUrl: string): boolean {
  return (
    TRUSTED_HOSTS.has(url.hostname) || url.origin === new URL(baseUrl).origin
  );
}

/**
 * Downloads the zipball, bounded on both the advertised and the observed size.
 * Redirects are followed by hand so a token only ever reaches a GitHub host.
 */
export async function downloadRepoZip(
  source: PinnedRepo,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  assertPinnedRepo(source);
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? CODELOAD;
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);

  let url = new URL(codeloadUrl(source, baseUrl));
  let response: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = { accept: "application/zip" };
    if (options.token && isTrusted(url, baseUrl)) {
      headers.authorization = `Bearer ${options.token}`;
    }
    try {
      response = await fetchImpl(url, { headers, redirect: "manual", signal });
    } catch (error) {
      throw new GitHubSourceError(
        "UNAVAILABLE",
        `Could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status < 300 || response.status >= 400) {
      break;
    }
    const location = response.headers.get("location");
    const next = location ? new URL(location, url) : null;
    if (
      !next ||
      !isTrusted(next, baseUrl) ||
      (next.protocol !== "https:" && next.origin !== new URL(baseUrl).origin)
    ) {
      throw new GitHubSourceError(
        "UNAVAILABLE",
        "GitHub redirected to an untrusted location",
      );
    }
    url = next;
    response = undefined;
  }

  if (!response) {
    throw new GitHubSourceError(
      "UNAVAILABLE",
      "Too many redirects from GitHub",
    );
  }
  if (response.status === 404) {
    throw new GitHubSourceError(
      "NOT_FOUND",
      `${source.owner}/${source.repo}@${source.commitSha.slice(0, 7)} was not found. The repository may have been deleted or made private.`,
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new GitHubSourceError(
      "RATE_LIMITED",
      "GitHub refused the download (rate limit). Try again later.",
    );
  }
  if (!response.ok || !response.body) {
    throw new GitHubSourceError(
      "UNAVAILABLE",
      `GitHub download failed (${response.status})`,
    );
  }

  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_ARCHIVE_BYTES) {
    throw new GitHubSourceError(
      "TOO_LARGE",
      "Repository archive exceeds the maximum allowed size",
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        throw new GitHubSourceError(
          "TOO_LARGE",
          "Repository archive exceeds the maximum allowed size",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof GitHubSourceError) {
      throw error;
    }
    throw new GitHubSourceError(
      "UNAVAILABLE",
      `GitHub download was interrupted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const zip = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    zip.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return zip;
}

/** Downloads the repository at `source` and reads one skill's files out of it. */
export async function fetchSkillFiles(
  source: PinnedRepo,
  archive: ReadSkillArchiveOptions,
  options: DownloadOptions = {},
): Promise<Map<string, Uint8Array>> {
  return readSkillArchive(await downloadRepoZip(source, options), archive);
}
