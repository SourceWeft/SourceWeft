import { createHash } from "node:crypto";
import {
  byReadmePreference,
  MAX_README_BYTES,
  README_PATH,
} from "../../../shared/catalog-readme";
import {
  GitHubRateLimitedError,
  githubGraphql,
  normalizeGitHubSource,
  type GitHubGraphqlError,
} from "../parser/github";
import type { NormalizedGitHubSource } from "../types";

/**
 * An MCP server's README, read from GitHub — the file GitHub shows for the
 * repository, or for one directory of it, on the default branch — through
 * the GraphQL API, many directories per query.
 *
 * GitHub's GraphQL API is the only source. When it cannot answer (rate limit,
 * outage, a token it does not accept) the caller is told which, and decides
 * when to ask again; nothing here falls back to the REST API,
 * raw.githubusercontent.com, a clone or an archive. No database access
 * either: the caller stores what comes back.
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

/** A directory whose README is wanted: `subfolder` "" is the repository's own. */
export type GitHubReadmeTarget = GitHubRepoRef;

export type GitHubReadmeResult =
  | {
      status: "ok";
      markdown: string;
      /** Repository-relative path, e.g. `README.md` or `mcp/README.md`. */
      path: string;
      /** The default branch's commit the README was read at. */
      ref: string;
      /** Hex sha256 of the README bytes. */
      sha256: string;
      byteSize: number;
    }
  /** No README there: no such repository or directory, or no README in it. */
  | { status: "not_found"; reason: "missing" }
  /** A README that is not one to show: not Markdown (`README.rst`), or blank. */
  | { status: "not_found"; reason: "not_markdown" | "empty"; path: string }
  | { status: "too_large"; path: string; byteSize: number }
  /** GitHub's rate limit is spent; ask again after `resetAt`. */
  | { status: "rate_limited"; resetAt: Date }
  /** GitHub did not accept `GITHUB_TOKEN`, or there is none: nothing was read. */
  | { status: "unauthorized"; message: string }
  | { status: "error"; message: string };

export type GitHubReadmeBatch = {
  /** One result per target, in the targets' order. */
  results: GitHubReadmeResult[];
  /** GraphQL points the queries cost. */
  cost: number;
  /** Points GitHub says are left in the hour, and when they reset; null before any answer. */
  remaining: number | null;
  resetAt: Date | null;
};

/**
 * Directories per probe query. Measured against the catalog in September
 * 2026, 25 answered in 4–8 seconds and 50 in up to 8 — against GitHub's hard
 * 10-second limit — so 20 leaves room for a slow repository.
 */
export const GITHUB_README_QUERY_SIZE = 20;

/**
 * Directories per follow-up query. Follow-ups are rare (a README under
 * another name, a symlinked one) and a listing can be large.
 */
const GITHUB_README_FOLLOW_UP_SIZE = 5;

/**
 * README names asked for directly, in every directory: the canonical name
 * and the casings of it that occur. A README by any other name (a variant
 * like `README.zh-CN.md`, a rarer casing, `README.rst`) costs a listing of
 * the directory, as GitHub's own README lookup is case-insensitive.
 */
const README_NAMES = [
  "README.md",
  "readme.md",
  "Readme.md",
  "README.MD",
  "ReadMe.md",
] as const;

/** A README file by name, Markdown or not (`README`, `README.rst`, …). */
const ANY_README_NAME = /^readme(?:\.[^/]*)?$/i;

/** Git's file mode for a symbolic link (0o120000). */
const SYMLINK_MODE = 40960;

/** A tree entry's fields a README read uses; `object` only when asked for. */
type TreeEntry = {
  name: string;
  type: string;
  mode: number;
  oid: string;
  object?: {
    byteSize?: number;
    isBinary?: boolean | null;
    isTruncated?: boolean;
    text?: string | null;
  } | null;
};

const ENTRY_WITH_BLOB =
  "name type mode oid object { ... on Blob { byteSize isBinary isTruncated text } }";

type RateLimitField = {
  rateLimit?: { cost?: number; remaining?: number; resetAt?: string } | null;
};

/** One distinct directory asked about, and the targets that asked for it. */
type Directory = {
  owner: string;
  repo: string;
  /** Path segments below the repository root; empty for the root. */
  dir: string[];
  targets: number[];
};

/** A file still to read at `commit`: a directory's pick, or a symlink's target. */
type FileRead = {
  directory: Directory;
  commit: string;
  path: string;
  /** The path the result names: a symlinked README keeps its own path. */
  reportPath: string;
  /** Symlinks already followed to reach `path`. */
  hops: number;
};

type Listing = { directory: Directory; commit: string };

const joinPath = (dir: readonly string[], name: string) =>
  [...dir, name].join("/");

/** Git's object id for a blob with these bytes. */
function gitBlobId(bytes: Uint8Array) {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The README's bytes, rebuilt from GitHub's `text` and checked against the
 * blob id — so a README whose bytes are not UTF-8 (GitHub then substitutes
 * characters) is caught, not stored altered. A byte-order mark GitHub leaves
 * out of `text` is put back for the check.
 */
function verifiedBytes(text: string, oid: string): Buffer | null {
  const bytes = Buffer.from(text, "utf8");
  if (gitBlobId(bytes) === oid) {
    return bytes;
  }
  const withBom = Buffer.concat([UTF8_BOM, bytes]);
  return gitBlobId(withBom) === oid ? withBom : null;
}

/** The result for a README file GitHub returned with its blob. */
function readmeFromEntry(
  entry: TreeEntry,
  path: string,
  ref: string,
): GitHubReadmeResult {
  const blob = entry.object;
  if (entry.type !== "blob" || !blob || typeof blob.byteSize !== "number") {
    return { status: "error", message: `GitHub README is not a file: ${path}` };
  }
  if (blob.byteSize > MAX_README_BYTES) {
    return { status: "too_large", path, byteSize: blob.byteSize };
  }
  if (blob.isTruncated) {
    return {
      status: "error",
      message: `GitHub returned the README truncated: ${path}`,
    };
  }
  const bytes =
    !blob.isBinary && typeof blob.text === "string"
      ? verifiedBytes(blob.text, entry.oid)
      : null;
  if (!bytes || bytes.includes(0)) {
    return {
      status: "error",
      message: `GitHub README is not UTF-8 text: ${path}`,
    };
  }
  // The same text a fatal UTF-8 decode of the bytes gives, BOM dropped.
  const markdown = bytes
    .subarray(bytes.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0)
    .toString("utf8");
  if (!markdown.trim()) {
    return { status: "not_found", reason: "empty", path };
  }
  return {
    status: "ok",
    markdown,
    path,
    ref,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
  };
}

/**
 * Where a symlink in `dir` points, as a repository path, or null when it
 * leaves the repository (an absolute target, or one that climbs out).
 */
function resolveLink(dir: readonly string[], target: string): string | null {
  if (!target || target.startsWith("/")) {
    return null;
  }
  const segments = [...dir];
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join("/") : null;
}

/**
 * The query's errors by the root alias they belong to. A file or commit that
 * is not there is reported as a `NOT_FOUND` error on its own field, which is
 * then null: that is an answer, not a failure, and is left to the field.
 */
function errorsByAlias(errors: readonly GitHubGraphqlError[]) {
  const byAlias = new Map<string, GitHubGraphqlError>();
  for (const error of errors) {
    const [alias, ...field] = error.path ?? [];
    if (typeof alias !== "string" || byAlias.has(alias)) continue;
    if (field.length > 0 && error.type === "NOT_FOUND") continue;
    byAlias.set(alias, error);
  }
  return byAlias;
}

/** An alias's own error: a repository GitHub does not have is no README. */
function aliasErrorResult(error: GitHubGraphqlError): GitHubReadmeResult {
  return error.type === "NOT_FOUND"
    ? { status: "not_found", reason: "missing" }
    : { status: "error", message: `GitHub: ${error.message}` };
}

type Query = { query: string; variables: Record<string, unknown> };

/**
 * Builds a query of one aliased `repository` field per item (`r0`, `r1`, …)
 * plus the rate limit. Every name and path is a variable: nothing a registry
 * entry says is spliced into the query text.
 */
function repositoryQuery<Item extends { directory: Directory }>(
  items: readonly Item[],
  body: (
    item: Item,
    index: number,
    variable: (name: string, type: string, value: unknown) => string,
  ) => string,
): Query {
  const params: string[] = [];
  const variables: Record<string, unknown> = {};
  const fields = items.map((item, index) => {
    const variable = (name: string, type: string, value: unknown) => {
      const key = `${name}${index}`;
      params.push(`$${key}: ${type}`);
      variables[key] = value;
      return `$${key}`;
    };
    const owner = variable("o", "String!", item.directory.owner);
    const repo = variable("n", "String!", item.directory.repo);
    return `r${index}: repository(owner: ${owner}, name: ${repo}) { ${body(item, index, variable)} }`;
  });
  return {
    query: `query(${params.join(", ")}) { rateLimit { cost remaining resetAt } ${fields.join(" ")} }`,
    variables,
  };
}

/**
 * Reads the README of each target directory, on its repository's default
 * branch, in as few GraphQL queries as it takes:
 *
 * 1. One probe query per {@link GITHUB_README_QUERY_SIZE} directories asks
 *    for each of {@link README_NAMES} there, with its text, and for the
 *    default branch's commit — so a README comes back pinned to the commit it
 *    was read at, in one request.
 * 2. A directory where none of those names exists is listed, at that commit,
 *    and its README picked by the rule skills use (`README_PATH`,
 *    `byReadmePreference`); another README file is `not_markdown`.
 * 3. A symlinked README is followed once, within the repository; its result
 *    keeps the link's path, as GitHub shows it.
 *
 * Targets naming the same directory are asked about once. A query GitHub
 * could not answer (a timeout) is asked again as two halves, down to a single
 * directory, which then alone is an error. A spent rate limit or a refused
 * token ends the reading: every target not yet answered gets that result.
 */
export async function fetchGitHubReadmes(
  targets: readonly GitHubReadmeTarget[],
  options: { signal?: AbortSignal } = {},
): Promise<GitHubReadmeBatch> {
  const results: Array<GitHubReadmeResult | undefined> = targets.map(
    () => undefined,
  );
  const batch = {
    cost: 0,
    remaining: null as number | null,
    resetAt: null as Date | null,
  };
  /** Set once GitHub stops answering: the result every unanswered target gets. */
  const halt: { stopped: GitHubReadmeResult | null } = { stopped: null };

  const settle = (directory: Directory, result: GitHubReadmeResult) => {
    for (const index of directory.targets) {
      results[index] = result;
    }
  };

  // Distinct directories; owner and repository names are case-insensitive on
  // GitHub, paths are not.
  const directories = new Map<string, Directory>();
  targets.forEach((target, index) => {
    const dir = subfolderSegments(target.subfolder);
    if (!isGitHubName(target.owner) || !isGitHubName(target.repo) || !dir) {
      results[index] = {
        status: "error",
        message: `Not a GitHub repository directory: ${target.owner}/${target.repo}/${target.subfolder}`,
      };
      return;
    }
    const key = [
      target.owner.toLowerCase(),
      target.repo.toLowerCase(),
      ...dir,
    ].join("/");
    const directory = directories.get(key) ?? {
      owner: target.owner,
      repo: target.repo,
      dir,
      targets: [],
    };
    directory.targets.push(index);
    directories.set(key, directory);
  });

  /**
   * Asks `items` in queries of `size`, halving a query GitHub did not answer
   * as a whole; `read` gets each answered item's data (or its own error).
   */
  async function ask<Item extends { directory: Directory }, Data>(
    items: readonly Item[],
    size: number,
    build: (items: readonly Item[]) => Query,
    read: (
      item: Item,
      data: Data | null,
      error: GitHubGraphqlError | undefined,
    ) => void,
  ): Promise<void> {
    for (let start = 0; start < items.length; start += size) {
      await askPart(items.slice(start, start + size), build, read);
    }
  }

  async function askPart<Item extends { directory: Directory }, Data>(
    items: readonly Item[],
    build: (items: readonly Item[]) => Query,
    read: (
      item: Item,
      data: Data | null,
      error: GitHubGraphqlError | undefined,
    ) => void,
  ): Promise<void> {
    if (halt.stopped || items.length === 0) {
      return;
    }
    const { query, variables } = build(items);
    let answer;
    try {
      answer = await githubGraphql<
        Record<string, Data | null> & RateLimitField
      >(query, variables, options.signal ? { signal: options.signal } : {});
    } catch (error) {
      if (error instanceof GitHubRateLimitedError && !options.signal?.aborted) {
        halt.stopped = { status: "rate_limited", resetAt: error.resetAt };
        return;
      }
      throw error;
    }
    if (answer.status === "unauthorized") {
      halt.stopped = { status: "unauthorized", message: answer.message };
      return;
    }
    if (answer.status === "failed") {
      if (items.length === 1) {
        settle(items[0]!.directory, {
          status: "error",
          message: answer.message,
        });
        return;
      }
      const half = Math.ceil(items.length / 2);
      await askPart(items.slice(0, half), build, read);
      await askPart(items.slice(half), build, read);
      return;
    }
    const rateLimit = answer.data.rateLimit;
    batch.cost += rateLimit?.cost ?? 0;
    if (typeof rateLimit?.remaining === "number") {
      batch.remaining = rateLimit.remaining;
    }
    if (rateLimit?.resetAt) {
      batch.resetAt = new Date(rateLimit.resetAt);
    }
    const errors = errorsByAlias(answer.errors);
    items.forEach((item, index) => {
      read(item, answer.data[`r${index}`] ?? null, errors.get(`r${index}`));
    });
  }

  const listings: Listing[] = [];
  let reads: FileRead[] = [];

  // 1. Probe every directory for the usual README names.
  type ProbeCommit = { oid?: string } & Record<
    string,
    TreeEntry | null | string | undefined
  >;
  type Probe = { defaultBranchRef: { target: ProbeCommit | null } | null };
  await ask<{ directory: Directory }, Probe>(
    [...directories.values()].map((directory) => ({ directory })),
    GITHUB_README_QUERY_SIZE,
    (items) =>
      repositoryQuery(items, ({ directory }, _index, variable) => {
        const files = README_NAMES.map(
          (name, k) =>
            `f${k}: file(path: ${variable(`p${k}_`, "String!", joinPath(directory.dir, name))}) { ${ENTRY_WITH_BLOB} }`,
        );
        return `defaultBranchRef { target { ... on Commit { oid ${files.join(" ")} } } }`;
      }),
    ({ directory }, data, error) => {
      if (error || !data) {
        settle(
          directory,
          error
            ? aliasErrorResult(error)
            : { status: "not_found", reason: "missing" },
        );
        return;
      }
      const commit = data.defaultBranchRef?.target;
      if (!data.defaultBranchRef) {
        // An empty repository has no default branch, and so no README.
        settle(directory, { status: "not_found", reason: "missing" });
        return;
      }
      if (!commit || typeof commit.oid !== "string") {
        settle(directory, {
          status: "error",
          message: `GitHub did not resolve the default branch of ${directory.owner}/${directory.repo} to a commit`,
        });
        return;
      }
      const found = README_NAMES.map((_, k) => commit[`f${k}`])
        .filter((entry): entry is TreeEntry =>
          Boolean(entry && typeof entry === "object" && entry.type === "blob"),
        )
        .sort((a, b) => byReadmePreference({ path: a.name }, { path: b.name }));
      const pick = found[0];
      if (!pick) {
        listings.push({ directory, commit: commit.oid });
        return;
      }
      const path = joinPath(directory.dir, pick.name);
      if (pick.mode === SYMLINK_MODE) {
        const target = resolveLink(directory.dir, pick.object?.text ?? "");
        if (!target) {
          settle(directory, { status: "not_found", reason: "missing" });
          return;
        }
        reads.push({
          directory,
          commit: commit.oid,
          path: target,
          reportPath: path,
          hops: 1,
        });
        return;
      }
      settle(directory, readmeFromEntry(pick, path, commit.oid));
    },
  );

  // 2. List the directories where no usual name was found.
  type ListedTree = { entries?: TreeEntry[] | null };
  type ListingCommit = {
    object: {
      tree?: ListedTree | null;
      file?: { type: string; object: ListedTree | null } | null;
    } | null;
  };
  await ask<Listing, ListingCommit>(
    listings,
    GITHUB_README_FOLLOW_UP_SIZE,
    (items) =>
      repositoryQuery(items, ({ directory, commit }, _index, variable) => {
        const at = variable("c", "GitObjectID!", commit);
        const entries = "entries { name type mode oid }";
        return directory.dir.length === 0
          ? `object(oid: ${at}) { ... on Commit { tree { ${entries} } } }`
          : `object(oid: ${at}) { ... on Commit { file(path: ${variable("p", "String!", directory.dir.join("/"))}) { type object { ... on Tree { ${entries} } } } } }`;
      }),
    ({ directory, commit }, data, error) => {
      if (error) {
        settle(directory, aliasErrorResult(error));
        return;
      }
      if (!data?.object) {
        settle(directory, {
          status: "error",
          message: `GitHub no longer has commit ${commit} of ${directory.owner}/${directory.repo}`,
        });
        return;
      }
      const tree =
        directory.dir.length === 0
          ? data.object.tree
          : data.object.file?.type === "tree"
            ? data.object.file.object
            : null;
      const files = (tree?.entries ?? []).filter(
        (entry) => entry.type === "blob",
      );
      const markdown = files
        .filter((entry) => README_PATH.test(entry.name))
        .sort((a, b) =>
          byReadmePreference({ path: a.name }, { path: b.name }),
        )[0];
      if (markdown) {
        const path = joinPath(directory.dir, markdown.name);
        reads.push({ directory, commit, path, reportPath: path, hops: 0 });
        return;
      }
      const other = files
        .filter((entry) => ANY_README_NAME.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, "en"))[0];
      settle(
        directory,
        other
          ? {
              status: "not_found",
              reason: "not_markdown",
              path: joinPath(directory.dir, other.name),
            }
          : { status: "not_found", reason: "missing" },
      );
    },
  );

  // 3. Read the files the listings picked and the symlinks point at.
  type ReadCommit = { object: { file?: TreeEntry | null } | null };
  while (reads.length > 0 && !halt.stopped) {
    const pending = reads;
    reads = [];
    await ask<FileRead, ReadCommit>(
      pending,
      GITHUB_README_FOLLOW_UP_SIZE,
      (items) =>
        repositoryQuery(
          items,
          ({ commit, path }, _index, variable) =>
            `object(oid: ${variable("c", "GitObjectID!", commit)}) { ... on Commit { file(path: ${variable("p", "String!", path)}) { ${ENTRY_WITH_BLOB} } } }`,
        ),
      (read, data, error) => {
        const { directory } = read;
        if (error) {
          settle(directory, aliasErrorResult(error));
          return;
        }
        const entry = data?.object?.file;
        if (!entry || entry.type !== "blob") {
          settle(directory, { status: "not_found", reason: "missing" });
          return;
        }
        if (entry.mode === SYMLINK_MODE) {
          const target =
            read.hops < 1
              ? resolveLink(
                  read.path.split("/").slice(0, -1),
                  entry.object?.text ?? "",
                )
              : null;
          if (!target) {
            settle(directory, { status: "not_found", reason: "missing" });
            return;
          }
          reads.push({ ...read, path: target, hops: read.hops + 1 });
          return;
        }
        settle(directory, readmeFromEntry(entry, read.reportPath, read.commit));
      },
    );
  }

  const unanswered: GitHubReadmeResult = halt.stopped ?? {
    status: "error",
    message: "GitHub left the README unanswered",
  };
  return {
    results: results.map((result) => result ?? unanswered),
    cost: batch.cost,
    remaining: batch.remaining,
    resetAt: batch.resetAt,
  };
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
