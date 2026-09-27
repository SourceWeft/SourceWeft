import { createHash } from "node:crypto";
import { MAX_README_BYTES, README_PATH } from "../../../shared/catalog-readme";
import {
  GITHUB_REQUEST_TIMEOUTS,
  GitHubRateLimitedError,
  githubFetch,
  githubHeaders,
  githubTimeoutError,
  hasGitHubToken,
  isGitHubTimeoutError,
  normalizeGitHubSource,
  resolveCommit,
} from "../parser/github";
import type { NormalizedGitHubSource } from "../types";

/**
 * An MCP server's README, read through GitHub's README API — the same file
 * GitHub shows for the repository, or for one directory of it.
 *
 * The API is the only source. When it cannot answer (rate limit, outage, a
 * refused request) the caller is told which, and decides when to ask again;
 * nothing here falls back to raw.githubusercontent.com, a clone or an archive.
 * No database access either: the caller stores what comes back.
 */

/** Owner and repository names as GitHub allows them. */
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

function isGitHubName(value: string) {
  return GITHUB_NAME.test(value) && value !== "." && value !== "..";
}

/**
 * A repository subfolder as clean path segments (empty and `.` segments
 * dropped, so `./mcp/` is `mcp`), or null when it climbs with `..`. Encoding
 * does not make `..` safe: a URL resolver still reads it, and `%2e%2e`, as a
 * step up — here, out of `/readme` and into another API path.
 */
function subfolderSegments(
  subfolder: string | null | undefined,
): string[] | null {
  const segments = (subfolder ?? "")
    .trim()
    .split("/")
    .filter((segment) => segment && segment !== ".");
  return segments.includes("..") ? null : segments;
}

function encodePath(segments: readonly string[]) {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

// ---------------------------------------------------------------------------
// Repository reference
// ---------------------------------------------------------------------------

export type GitHubRepoRef = {
  owner: string;
  repo: string;
  /** The server's directory inside the repository, `/`-separated; "" for the root. */
  subfolder: string;
};

export type GitHubRepoRefResult =
  | GitHubRepoRef
  | {
      unsupported: true;
      /**
       * `not_github`: no URL, or one on another host — there is no GitHub
       * README to ask for. `invalid_path`: a github.com URL (or subfolder)
       * that names no repository directory.
       */
      reason: "not_github" | "invalid_path";
    };

const unsupported = (reason: "not_github" | "invalid_path") =>
  ({ unsupported: true, reason }) as const;

/**
 * Where a catalog entry's README lives on GitHub, from its repository URL and
 * the registry's `repository.subfolder`. An explicit subfolder wins over one
 * the URL itself points into (`…/tree/<ref>/<dir>`). Only absolute github.com
 * URLs are GitHub repositories: an `owner/repo` shorthand is not a registry
 * repository URL, and is not guessed at.
 */
export function parseGitHubRepoRef(
  repoUrl: string | null | undefined,
  subfolder?: string | null,
): GitHubRepoRefResult {
  let url: URL;
  try {
    url = new URL(repoUrl?.trim() ?? "");
  } catch {
    return unsupported("not_github");
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return unsupported("not_github");
  }

  let source: NormalizedGitHubSource;
  try {
    source = normalizeGitHubSource(url.href);
  } catch {
    return unsupported("invalid_path");
  }
  if (!isGitHubName(source.owner) || !isGitHubName(source.repo)) {
    return unsupported("invalid_path");
  }

  const explicit = subfolderSegments(subfolder);
  if (explicit === null) {
    return unsupported("invalid_path");
  }
  if (explicit.length > 0) {
    return {
      owner: source.owner,
      repo: source.repo,
      subfolder: explicit.join("/"),
    };
  }
  // A path taken from the URL is still percent-encoded; the fetch encodes it
  // again, so it is decoded here once.
  let fromUrl: string[] | null;
  try {
    fromUrl = subfolderSegments(
      source.subpath.split("/").map(decodeURIComponent).join("/"),
    );
  } catch {
    return unsupported("invalid_path");
  }
  if (fromUrl === null) {
    return unsupported("invalid_path");
  }
  return {
    owner: source.owner,
    repo: source.repo,
    subfolder: fromUrl.join("/"),
  };
}

// ---------------------------------------------------------------------------
// README fetch
// ---------------------------------------------------------------------------

export type FetchGitHubReadmeInput = {
  owner: string;
  repo: string;
  /** Directory whose README is wanted; omitted or "" for the repository's own. */
  subfolder?: string | null;
  /** The ETag stored with the last README; an unchanged one then answers 304. */
  etag?: string | null;
  /** Caller cancellation. It is re-thrown, never reported as a result. */
  signal?: AbortSignal;
};

type GitHubReadmeOutcome =
  | {
      status: "ok";
      markdown: string;
      /** Repository-relative path, e.g. `README.md` or `mcp/README.md`. */
      path: string;
      /** The default branch's commit the README was pinned to. */
      ref: string;
      /** Hex sha256 of the README bytes. */
      sha256: string;
      etag: string | null;
      byteSize: number;
    }
  /** Unchanged since `etag`: keep what was stored. */
  | { status: "not_modified" }
  /** GitHub has no README there. */
  | { status: "not_found"; reason: "missing" }
  /**
   * GitHub's README there is not one to show: not Markdown (`README.rst`,
   * `README`), or blank. `etag` lets the next ask be a cheap 304.
   */
  | {
      status: "not_found";
      reason: "not_markdown" | "empty";
      path: string;
      etag: string | null;
    }
  | { status: "too_large"; path: string; byteSize: number; etag: string | null }
  /** GitHub's rate limit is spent; ask again after `resetAt`. */
  | { status: "rate_limited"; resetAt: Date }
  | { status: "error"; message: string };

/**
 * `tokenPresent` rides on every outcome: without `GITHUB_TOKEN` reads still
 * work, anonymously and under a far smaller rate limit, and the caller is the
 * one to report that.
 */
export type GitHubReadmeResult = GitHubReadmeOutcome & {
  tokenPresent: boolean;
};

/** The fields of GitHub's contents response this module reads. */
type GitHubReadmeBody = {
  type?: unknown;
  path?: unknown;
  size?: unknown;
  encoding?: unknown;
  content?: unknown;
};

function githubReadmeApiUrl(owner: string, repo: string, subfolder: string[]) {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`;
  return subfolder.length > 0 ? `${base}/${encodePath(subfolder)}` : base;
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  // `fetch` reports every network failure as "fetch failed"; the cause says which.
  const cause = error.cause instanceof Error ? error.cause.message : null;
  return cause ? `${error.message} (${cause})` : error.message;
}

/** UTF-8 text without NULs, or null — the same bar a skill README file meets. */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads the README of a GitHub repository, or of one directory of it, with
 * `GET /repos/{owner}/{repo}/readme/{subfolder}`.
 *
 * A fresh README is pinned to the default branch's current commit with one
 * more call; a 304 or a README that is not shown costs no second call. The
 * README comes from the default branch's head and the commit is read just
 * after, so a push landing between the two pins a commit one newer than the
 * text — close enough for resolving the README's relative links.
 */
export async function fetchGitHubReadme(
  input: FetchGitHubReadmeInput,
): Promise<GitHubReadmeResult> {
  const tokenPresent = hasGitHubToken();
  const done = (outcome: GitHubReadmeOutcome): GitHubReadmeResult => ({
    ...outcome,
    tokenPresent,
  });

  const subfolder = subfolderSegments(input.subfolder);
  if (
    !isGitHubName(input.owner) ||
    !isGitHubName(input.repo) ||
    subfolder === null
  ) {
    return done({
      status: "error",
      message: `Not a GitHub repository directory: ${input.owner}/${input.repo}/${input.subfolder ?? ""}`,
    });
  }

  const url = githubReadmeApiUrl(input.owner, input.repo, subfolder);
  const headers = githubHeaders();
  if (input.etag) {
    headers["If-None-Match"] = input.etag;
  }
  const options = input.signal ? { signal: input.signal } : {};

  try {
    const response = await githubFetch(url, headers, options);
    if (response.status === 304 || response.status === 404) {
      void response.body?.cancel().catch(() => undefined);
      return done(
        response.status === 304
          ? { status: "not_modified" }
          : { status: "not_found", reason: "missing" },
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return done({
        status: "error",
        message: `GitHub README request failed ${response.status}: ${url}`,
      });
    }

    const etag = response.headers.get("etag");
    const body = (await response.json()) as GitHubReadmeBody;
    if (
      body.type !== "file" ||
      typeof body.path !== "string" ||
      typeof body.size !== "number"
    ) {
      return done({
        status: "error",
        message: `GitHub README response is not a file: ${url}`,
      });
    }
    const path = body.path;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!README_PATH.test(name)) {
      return done({ status: "not_found", reason: "not_markdown", path, etag });
    }
    if (body.size > MAX_README_BYTES) {
      return done({ status: "too_large", path, byteSize: body.size, etag });
    }
    if (body.encoding !== "base64" || typeof body.content !== "string") {
      return done({
        status: "error",
        message: `GitHub README content is not base64: ${url}`,
      });
    }
    const bytes = Buffer.from(body.content, "base64");
    if (bytes.byteLength > MAX_README_BYTES) {
      return done({
        status: "too_large",
        path,
        byteSize: bytes.byteLength,
        etag,
      });
    }
    if (bytes.byteLength !== body.size) {
      return done({
        status: "error",
        message: `GitHub README content is ${bytes.byteLength} bytes, not the declared ${body.size}: ${url}`,
      });
    }
    const markdown = decodeText(bytes);
    if (markdown === null) {
      return done({
        status: "error",
        message: `GitHub README is not UTF-8 text: ${url}`,
      });
    }
    if (!markdown.trim()) {
      return done({ status: "not_found", reason: "empty", path, etag });
    }

    const repoUrl = `https://github.com/${input.owner}/${input.repo}`;
    const commit = await resolveCommit(
      {
        owner: input.owner,
        repo: input.repo,
        subpath: "",
        repoUrl,
        sourceUrl: repoUrl,
      },
      "HEAD",
      options,
    );
    if (!commit) {
      return done({
        status: "error",
        message: `GitHub did not resolve the default branch of ${repoUrl} to a commit`,
      });
    }

    return done({
      status: "ok",
      markdown,
      path,
      ref: commit.sha,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      etag,
      byteSize: bytes.byteLength,
    });
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    if (error instanceof GitHubRateLimitedError) {
      return done({ status: "rate_limited", resetAt: error.resetAt });
    }
    if (isGitHubTimeoutError(error)) {
      // The deadline struck while the body was being read.
      return done({
        status: "error",
        message: githubTimeoutError(url, GITHUB_REQUEST_TIMEOUTS.metadataMs)
          .message,
      });
    }
    return done({ status: "error", message: describeError(error) });
  }
}

// ---------------------------------------------------------------------------
// Relative links
// ---------------------------------------------------------------------------

/**
 * Bases for resolving a README's relative links against the commit it was
 * pinned to (`new URL(href, blobBase)`): `blobBase` for pages on github.com,
 * `rawBase` for a file's bytes. Both end in the README's own directory, as a
 * relative link in it means. Only URLs are built here; nothing is fetched.
 */
export function githubReadmeLinkBases(input: {
  owner: string;
  repo: string;
  /** Commit sha the README was read at. */
  ref: string;
  /** Repository-relative README path, e.g. `mcp/README.md`. */
  path: string;
}) {
  const directory = input.path.split("/").filter(Boolean).slice(0, -1);
  const repoPath = encodePath([input.owner, input.repo]);
  const tail = `${encodePath([input.ref, ...directory])}/`;
  return {
    blobBase: `https://github.com/${repoPath}/blob/${tail}`,
    rawBase: `https://raw.githubusercontent.com/${repoPath}/${tail}`,
  };
}
