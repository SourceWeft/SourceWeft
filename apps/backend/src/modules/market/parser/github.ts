import { createHash } from "node:crypto";
import type { NormalizedGitHubSource } from "../types";

const githubUserAgent = "SourceWeft-MCP-Ingest/1.0";
const shaRefPattern = /^[a-f0-9]{40}$/i;

/**
 * DoS bounds shared by every GitHub archive read. Enforced by `github-zip.ts`,
 * which reads archives in memory — there is no longer any code path that
 * extracts a third-party archive onto the app host, so the symlink /
 * path-traversal / `--no-same-owner` hardening that used to live here has no
 * subject left to guard and is gone with it.
 */
export const GITHUB_ARCHIVE_LIMITS = Object.freeze({
  /** Hard cap on the downloaded (compressed) archive. */
  maxArchiveBytes: 100 * 1024 * 1024,
  /** Hard cap on the number of file entries inside the archive. */
  maxEntries: 20_000,
});

/**
 * Failure modes a caller has to distinguish. Kept as a code rather than
 * per-caller error classes so this module stays free of any one consumer's
 * error taxonomy — the skills registry and the MCP market each map these onto
 * their own submission errors.
 *
 * Defined here rather than in `github-zip.ts` (which re-exports it) because
 * `githubFetch` raises the timeout, and `github-zip.ts` already imports this
 * module.
 */
export type GitHubArchiveErrorCode =
  | "ARCHIVE_UNAVAILABLE"
  | "ARCHIVE_TOO_LARGE"
  | "ARCHIVE_UNPINNED"
  | "ARCHIVE_TIMEOUT";

export class GitHubArchiveError extends Error {
  constructor(
    readonly code: GitHubArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitHubArchiveError";
  }
}

/**
 * Per-request deadlines. `fetch` has none of its own, so a GitHub response that
 * stalls mid-flight would otherwise pin the submitting HTTP request for minutes.
 * The deadline covers the response BODY too (the signal stays attached to the
 * stream), which is why the archive download gets a longer one than the small
 * JSON metadata calls.
 */
export const GITHUB_REQUEST_TIMEOUTS = Object.freeze({
  metadataMs: 30_000,
  archiveMs: 120_000,
});

export type GitHubRequestOptions = {
  /** Deadline for each attempt, body included. Defaults to `metadataMs`. */
  timeoutMs?: number;
  /** Caller cancellation, combined with the deadline. */
  signal?: AbortSignal;
};

function stripGitSuffix(value: string) {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function cleanSubpath(segments: string[]) {
  return segments
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function sourceUrlFor(input: {
  owner: string;
  ref?: string;
  repo: string;
  subpath: string;
}) {
  const repoUrl = `https://github.com/${input.owner}/${input.repo}`;
  if (!input.ref) {
    return input.subpath ? `${repoUrl}/tree/HEAD/${input.subpath}` : repoUrl;
  }
  return input.subpath
    ? `${repoUrl}/tree/${input.ref}/${input.subpath}`
    : `${repoUrl}/tree/${input.ref}`;
}

export function normalizeGitHubSource(input: string): NormalizedGitHubSource {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("GitHub source is required");
  }

  const ownerRepoMatch = trimmed.match(
    /^(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)$/,
  );
  const ownerRepoGroups = ownerRepoMatch?.groups;
  if (ownerRepoGroups?.owner && ownerRepoGroups.repo) {
    const owner = ownerRepoGroups.owner;
    const repo = stripGitSuffix(ownerRepoGroups.repo);
    return {
      owner,
      repo,
      subpath: "",
      repoUrl: `https://github.com/${owner}/${repo}`,
      sourceUrl: sourceUrlFor({ owner, repo, subpath: "" }),
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Unsupported GitHub source: ${input}`);
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error(`Only github.com URLs are supported: ${input}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repoSegment = segments[1];
  if (!owner || !repoSegment) {
    throw new Error(`GitHub URL must include owner and repo: ${input}`);
  }

  const repo = stripGitSuffix(repoSegment);
  let ref: string | undefined;
  let subpath = "";
  if (segments[2] === "tree" || segments[2] === "blob") {
    const rest = segments.slice(3);
    if (rest.length > 0) {
      if (shaRefPattern.test(rest[0] ?? "")) {
        ref = rest[0];
        subpath = cleanSubpath(rest.slice(1));
      } else {
        ref = rest[0];
        subpath = cleanSubpath(rest.slice(1));
      }
    }
  }

  return {
    owner,
    repo,
    ref,
    subpath,
    repoUrl: `https://github.com/${owner}/${repo}`,
    sourceUrl: sourceUrlFor({ owner, ref, repo, subpath }),
  };
}

/** Headers for a GitHub archive download (see `githubFetch`). */
export function githubDownloadHeaders(): Record<string, string> {
  return {
    "User-Agent": githubUserAgent,
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  };
}

function githubHeaders() {
  const headers: Record<string, string> = {
    "User-Agent": githubUserAgent,
    Accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

const githubMaxRetries = 4;
const githubBaseBackoffMs = 500;
const githubMaxTotalWaitMs = 60_000;

function isRetryableGitHubResponse(response: Response) {
  const { status } = response;
  if (status === 429 || status >= 500) {
    return true;
  }
  // GitHub signals rate limiting with 403; only retry those, not genuine
  // permission-denied 403s.
  if (status === 403) {
    return (
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after")
    );
  }
  return false;
}

function githubRetryDelayMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const parsedDate = Date.parse(retryAfter);
    if (!Number.isNaN(parsedDate)) {
      return Math.max(0, parsedDate - Date.now());
    }
  }
  if (
    response.headers.get("x-ratelimit-remaining") === "0" &&
    response.headers.get("x-ratelimit-reset")
  ) {
    const resetMs = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    if (Number.isFinite(resetMs)) {
      return Math.max(0, resetMs - Date.now());
    }
  }
  // Exponential backoff with full jitter.
  const backoff = githubBaseBackoffMs * 2 ** attempt;
  return backoff + Math.floor(Math.random() * backoff);
}

/**
 * True when `error` is what an aborted `AbortSignal.timeout` rejects with —
 * whether it surfaced from `fetch` itself or from reading the response body.
 */
export function isGitHubTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export function githubTimeoutError(url: string, timeoutMs: number) {
  return new GitHubArchiveError(
    "ARCHIVE_TIMEOUT",
    `GitHub did not respond within ${Math.round(timeoutMs / 1000)}s: ${url}`,
  );
}

/**
 * Retry/backoff-aware GitHub fetch. Exported alongside `githubDownloadHeaders`
 * so `github-zip.ts` reuses the same rate-limit handling and token plumbing
 * instead of re-implementing them.
 *
 * Every attempt runs under its own deadline. The deadline signal is handed to
 * `fetch`, so it also bounds a caller streaming the returned body; a caller
 * that reads the body maps that late abort with `isGitHubTimeoutError`.
 */
export async function githubFetch(
  url: string,
  headers: Record<string, string>,
  options: GitHubRequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUTS.metadataMs;
  let totalWaited = 0;
  for (let attempt = 0; ; attempt += 1) {
    options.signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: options.signal
          ? AbortSignal.any([deadline, options.signal])
          : deadline,
      });
    } catch (error) {
      // A caller's own cancellation is theirs to interpret; only our deadline
      // becomes the module's error type. A timeout is not retried: the request
      // already spent its whole budget.
      if (isGitHubTimeoutError(error) && !options.signal?.aborted) {
        throw githubTimeoutError(url, timeoutMs);
      }
      throw error;
    }
    if (
      response.ok ||
      attempt >= githubMaxRetries ||
      !isRetryableGitHubResponse(response)
    ) {
      return response;
    }
    const delay = Math.min(
      githubRetryDelayMs(response, attempt),
      githubMaxTotalWaitMs - totalWaited,
    );
    if (delay <= 0) {
      return response;
    }
    totalWaited += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function fetchJson<T>(
  url: string,
  options?: GitHubRequestOptions,
): Promise<T> {
  const response = await githubFetch(url, githubHeaders(), options);
  if (!response.ok) {
    throw new Error(`GitHub request failed ${response.status}: ${url}`);
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (isGitHubTimeoutError(error) && !options?.signal?.aborted) {
      throw githubTimeoutError(
        url,
        options?.timeoutMs ?? GITHUB_REQUEST_TIMEOUTS.metadataMs,
      );
    }
    throw error;
  }
}

/**
 * The URL/API half of GitHub source resolution — no archive bytes are touched
 * here, only a repo URL string and JSON metadata.
 */
export async function resolveDefaultBranch(
  source: NormalizedGitHubSource,
  options?: GitHubRequestOptions,
) {
  const data = await fetchJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${source.owner}/${source.repo}`,
    options,
  );
  return data.default_branch || "main";
}

export type ResolvedGitHubCommit = {
  sha: string;
  /**
   * Committer date, ISO 8601. Unknown when the ref was already a full sha and
   * GitHub's commit metadata could not be read.
   */
  committedAt?: string;
};

/**
 * Resolve a ref to its commit, with the committer date the same response
 * already carries — so ordering two commits of one repo costs no extra call.
 * See `resolveDefaultBranch` for why this is exported.
 */
export async function resolveCommit(
  source: NormalizedGitHubSource,
  ref: string,
  options?: GitHubRequestOptions,
): Promise<ResolvedGitHubCommit | undefined> {
  try {
    const data = await fetchJson<{
      sha?: string;
      commit?: { committer?: { date?: string } | null };
    }>(
      `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`,
      options,
    );
    if (!data.sha) {
      return undefined;
    }
    const date = data.commit?.committer?.date;
    // Normalised so stored values compare consistently; a malformed date is
    // dropped rather than stored, and the version then ranks as undated.
    const parsed = typeof date === "string" ? Date.parse(date) : Number.NaN;
    return {
      sha: data.sha,
      ...(Number.isNaN(parsed)
        ? {}
        : { committedAt: new Date(parsed).toISOString() }),
    };
  } catch (error) {
    if (shaRefPattern.test(ref)) {
      return { sha: ref };
    }
    // Without a sha to fall back on, a stalled GitHub must read as a timeout,
    // not as "this ref cannot be pinned".
    if (error instanceof GitHubArchiveError) {
      throw error;
    }
    return undefined;
  }
}
