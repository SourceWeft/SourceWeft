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
  | "ARCHIVE_TIMEOUT"
  // The commit exists in the repository's fork network but is not on its
  // default branch — see `assertCommitOnDefaultBranch`.
  | "ARCHIVE_NOT_IN_REPOSITORY"
  // GitHub's rate limit is spent — see `GitHubRateLimitedError`.
  | "ARCHIVE_RATE_LIMITED";

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
 * GitHub refused a request because the token's (or the IP's) rate limit is
 * spent, and it will not be lifted within the few seconds `githubFetch` waits
 * on its own. `resetAt` is when GitHub says requests are accepted again: the
 * primary limit's `x-ratelimit-reset`, or a secondary limit's `retry-after`.
 *
 * A `GitHubArchiveError` so that every layer which already passes those through
 * untouched (the source resolver, the commit lookup) carries it up as it is —
 * a caller that can wait (the ingest queue) reschedules, one that runs again
 * anyway (the market upkeep) stops asking for this round.
 */
export class GitHubRateLimitedError extends GitHubArchiveError {
  constructor(
    readonly resetAt: Date,
    url: string,
  ) {
    super(
      "ARCHIVE_RATE_LIMITED",
      `GitHub's rate limit is spent until ${resetAt.toISOString()}: ${url}`,
    );
    this.name = "GitHubRateLimitedError";
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

/**
 * GitHub's rate limit answer: a 403 or 429 that says the primary limit is
 * spent (`x-ratelimit-remaining: 0`) or asks for a pause (`retry-after`, a
 * secondary limit). A plain 403 is a real "forbidden" and a bare 429 is
 * treated like a 5xx.
 */
export function isGitHubRateLimitResponse(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) {
    return false;
  }
  return (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  );
}

/** Fallback when a rate limit answer names no time: GitHub's own advice is a minute. */
const githubRateLimitDefaultWaitMs = 60_000;

/** When a rate-limited response says requests are accepted again. */
export function githubRateLimitResetAt(
  response: Response,
  now = Date.now(),
): Date {
  const retryAfter = retryAfterMs(response, now);
  if (retryAfter !== null) {
    return new Date(now + retryAfter);
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.has("x-ratelimit-reset") && Number.isFinite(reset)) {
    return new Date(Math.max(now, reset * 1000));
  }
  return new Date(now + githubRateLimitDefaultWaitMs);
}

function retryAfterMs(response: Response, now: number): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return null;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const parsedDate = Date.parse(retryAfter);
  return Number.isNaN(parsedDate) ? null : Math.max(0, parsedDate - now);
}

function isRetryableGitHubResponse(response: Response) {
  const { status } = response;
  return status === 429 || status >= 500 || isGitHubRateLimitResponse(response);
}

function githubRetryDelayMs(response: Response, attempt: number) {
  if (isGitHubRateLimitResponse(response)) {
    return Math.max(0, githubRateLimitResetAt(response).getTime() - Date.now());
  }
  const retryAfter = retryAfterMs(response, Date.now());
  if (retryAfter !== null) {
    return retryAfter;
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
 * A rate limit that outlasts the retry budget throws `GitHubRateLimitedError`
 * instead of answering with the 403/429.
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
    if (response.ok || !isRetryableGitHubResponse(response)) {
      return response;
    }
    const wanted = githubRetryDelayMs(response, attempt);
    const budget = githubMaxTotalWaitMs - totalWaited;
    if (isGitHubRateLimitResponse(response)) {
      // A limit that lifts within what is left of the budget is waited out
      // here; one that does not (the primary limit resets hourly) is the
      // caller's to schedule around, so it is raised rather than returned as
      // one more 403 to misread as "forbidden".
      if (attempt >= githubMaxRetries || wanted > budget) {
        void response.body?.cancel().catch(() => undefined);
        throw new GitHubRateLimitedError(githubRateLimitResetAt(response), url);
      }
    } else if (attempt >= githubMaxRetries) {
      return response;
    }
    const delay = Math.min(wanted, budget);
    if (delay <= 0) {
      // A reset already past: ask again straight away (bounded by the retries).
      if (isGitHubRateLimitResponse(response)) continue;
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
    // A sha-shaped ref used to be trusted as-is when this read failed. It must
    // not be: an unread sha is an unverified one, and the commit's place in the
    // repository is exactly what has to be checked (`assertCommitOnDefaultBranch`).
    // A stalled GitHub reads as a timeout, a 429/5xx as a failure worth
    // retrying, and only a plain "no such commit" as unpinnable.
    if (error instanceof GitHubArchiveError) {
      throw error;
    }
    if (error instanceof Error && /\bfailed (404|422)\b/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Where `head` stands relative to `base` in this repository, as GitHub's
 * compare API says: `ahead` (head descends from base), `behind`, `identical`
 * or `diverged`. Null when GitHub knows no such commit pair here.
 */
export async function compareCommits(
  source: Pick<NormalizedGitHubSource, "owner" | "repo">,
  base: string,
  head: string,
  options?: GitHubRequestOptions,
): Promise<"ahead" | "behind" | "identical" | "diverged" | null> {
  // `per_page=1`: only the status is wanted, not the commit list in between.
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`;
  const response = await githubFetch(url, githubHeaders(), options);
  if (response.status === 404 || response.status === 422) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub request failed ${response.status}: ${url}`);
  }
  const data = (await response.json()) as { status?: string };
  return data.status === "ahead" ||
    data.status === "behind" ||
    data.status === "identical" ||
    data.status === "diverged"
    ? data.status
    : null;
}

/**
 * Refuses a commit that is not on the repository's default branch.
 *
 * GitHub shares git objects across a fork network, so a commit that exists
 * only in SOMEONE ELSE'S FORK is served under the upstream's own URLs — both
 * `repos/<owner>/<repo>/commits/<sha>` and `codeload.github.com/<owner>/<repo>/zip/<sha>`
 * answer for it. Pinned by sha, a fork's content would be indexed under the
 * upstream's name, author and avatar. Requiring the commit to be in the default
 * branch's history means only the repository's own writers could have put it
 * there. (Verified 2026-09-21 against a real fork of obra/superpowers.)
 */
export async function assertCommitOnDefaultBranch(
  source: Pick<NormalizedGitHubSource, "owner" | "repo" | "repoUrl">,
  commitSha: string,
  defaultBranch: string,
  options?: GitHubRequestOptions,
): Promise<void> {
  const status = await compareCommits(
    source,
    commitSha,
    defaultBranch,
    options,
  );
  // base=commit, head=branch: `ahead` / `identical` mean the branch contains it.
  if (status === "ahead" || status === "identical") {
    return;
  }
  throw new GitHubArchiveError(
    "ARCHIVE_NOT_IN_REPOSITORY",
    `Commit ${commitSha.slice(0, 12)} is not on ${source.repoUrl}'s default branch (${defaultBranch}). It may come from a fork; import from the default branch or a commit on it.`,
  );
}
