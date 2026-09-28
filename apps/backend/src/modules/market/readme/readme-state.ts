import { createHash } from "node:crypto";
import type {
  MarketMcpReadme,
  McpReadmeStatus,
} from "@sourceweft/market-contracts";
import { MAX_README_BYTES, README_PATH } from "../../../shared/catalog-readme";
import {
  githubReadmeLinkBases,
  parseGitHubRepoRef,
  type GitHubReadmeResult,
} from "./github-readme";

/**
 * The README state of an MCP server version: how each fetch outcome moves it,
 * what a submission stores, and what the detail API shows. Pure — the fetch
 * job and the submission path write what these return.
 *
 * `readme_status` says what the version's README IS (`ok`, `not_found`, …). A
 * failed refresh does not unsay it: `readme_attempts` and `readme_error` say
 * the refresh is failing, and a README already shown stays shown. Only a
 * version that never had an answer turns `error`.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A README that was read (or confirmed unchanged) is read again after this. */
export const MCP_README_REFRESH_MS = 7 * DAY_MS;
/** No README to show (none, too large, not on GitHub): asked again after this. */
export const MCP_README_ABSENT_REFRESH_MS = 30 * DAY_MS;
/** The first retry after a failed fetch; each further failure doubles it. */
export const MCP_README_ERROR_BACKOFF_MS = HOUR_MS;
export const MCP_README_ERROR_BACKOFF_MAX_MS = 7 * DAY_MS;
/**
 * Failed fetches in a row before the job stops asking (no next fetch) until a
 * market admin asks for the README again.
 */
export const MCP_README_MAX_ATTEMPTS = 5;

/**
 * The `readme_*` columns (and `readme_md`) a transition writes. A key left
 * undefined keeps the stored value.
 */
export type McpReadmeColumns = {
  readmeStatus?: McpReadmeStatus;
  readmeMd?: string | null;
  readmePath?: string | null;
  readmeRef?: string | null;
  readmeSha256?: string | null;
  readmeFetchedAt?: Date | null;
  readmeNextFetchAt?: Date | null;
  readmeAttempts?: number;
  readmeError?: string | null;
};

/** What a transition needs to know about the stored row. */
export type McpReadmeCurrent = {
  readmeStatus: McpReadmeStatus;
  readmeAttempts: number;
};

/** The repository cannot be asked for a README: not a GitHub repository. */
export type McpReadmeUnsupportedHost = {
  status: "unsupported_host";
  message: string;
};

/** A failure the README client did not report as an outcome (it threw). */
export type McpReadmeUnexpectedError = { status: "error"; message: string };

/** The README read is exactly the one stored: only the fetch times move. */
export type McpReadmeNotModified = { status: "not_modified" };

/**
 * What one fetch did for a version. A refused token is not among them: it
 * stops the batch before anything is written (see `fetchMcpReadmeBatch`).
 */
export type McpReadmeFetchOutcome =
  | Exclude<GitHubReadmeResult, { status: "unauthorized" }>
  | McpReadmeNotModified
  | McpReadmeUnsupportedHost
  | McpReadmeUnexpectedError;

const after = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** Delay before retrying after the `attempts`-th failure in a row (1-based). */
export function mcpReadmeErrorBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    MCP_README_ERROR_BACKOFF_MS * 2 ** exponent,
    MCP_README_ERROR_BACKOFF_MAX_MS,
  );
}

/**
 * Whether a fresh read found exactly the README already stored — same file,
 * same bytes — so the version keeps its text and the commit it was pinned to,
 * and only its fetch times move.
 */
export function mcpReadmeUnchanged(
  current: {
    readmeStatus: McpReadmeStatus;
    readmeSha256: string | null;
    readmePath: string | null;
  },
  result: GitHubReadmeResult,
): boolean {
  return (
    result.status === "ok" &&
    current.readmeStatus === "ok" &&
    current.readmeSha256 === result.sha256 &&
    current.readmePath === result.path
  );
}

function refreshIntervalFor(status: McpReadmeStatus) {
  return status === "ok" ? MCP_README_REFRESH_MS : MCP_README_ABSENT_REFRESH_MS;
}

/**
 * The columns one fetch outcome writes.
 *
 * - `ok`: the README and its source; the failure streak ends.
 * - `not_modified`: still what is stored; only the fetch times move.
 * - `not_found` / `unsupported_host`: there is no README to show, so a stale
 *   one is cleared. `too_large` keeps whatever text was stored (it is not
 *   shown) and points at the file.
 * - `rate_limited`: not the README's fault — no attempt is counted; the next
 *   fetch waits for GitHub's reset.
 * - `error`: one more attempt, retried with exponential backoff, and after
 *   {@link MCP_README_MAX_ATTEMPTS} no next fetch at all.
 */
export function mcpReadmeTransition(
  current: McpReadmeCurrent,
  outcome: McpReadmeFetchOutcome,
  now: Date,
): McpReadmeColumns {
  const settled = {
    readmeFetchedAt: now,
    readmeAttempts: 0,
    readmeError: null,
  } as const;
  switch (outcome.status) {
    case "ok":
      return {
        ...settled,
        readmeStatus: "ok",
        readmeMd: outcome.markdown,
        readmePath: outcome.path,
        readmeRef: outcome.ref,
        readmeSha256: outcome.sha256,
        readmeNextFetchAt: after(now, MCP_README_REFRESH_MS),
      };
    case "not_modified":
      return {
        ...settled,
        readmeNextFetchAt: after(now, refreshIntervalFor(current.readmeStatus)),
      };
    case "not_found": {
      const file = outcome.reason === "missing" ? null : outcome;
      return {
        ...settled,
        readmeStatus: "not_found",
        readmeMd: null,
        readmeSha256: null,
        readmeRef: null,
        readmePath: file?.path ?? null,
        readmeNextFetchAt: after(now, MCP_README_ABSENT_REFRESH_MS),
      };
    }
    case "too_large":
      return {
        ...settled,
        readmeStatus: "too_large",
        readmePath: outcome.path,
        // The fetch pins no commit for a README it does not store; the file's
        // links then name the default branch.
        readmeRef: null,
        readmeNextFetchAt: after(now, MCP_README_ABSENT_REFRESH_MS),
      };
    case "unsupported_host":
      return {
        readmeStatus: "unsupported_host",
        readmeMd: null,
        readmeSha256: null,
        readmeRef: null,
        readmePath: null,
        readmeFetchedAt: now,
        readmeAttempts: 0,
        readmeError: outcome.message,
        readmeNextFetchAt: after(now, MCP_README_ABSENT_REFRESH_MS),
      };
    case "rate_limited":
      return { readmeNextFetchAt: outcome.resetAt };
    case "error": {
      const attempts = current.readmeAttempts + 1;
      return {
        // A version with an answer keeps it; one without says it failed.
        ...(current.readmeStatus === "pending"
          ? { readmeStatus: "error" }
          : {}),
        readmeAttempts: attempts,
        readmeError: outcome.message,
        readmeNextFetchAt:
          attempts >= MCP_README_MAX_ATTEMPTS
            ? null
            : after(now, mcpReadmeErrorBackoffMs(attempts)),
      };
    }
  }
}

/** UTF-8 text without NULs, or null — the bar the README fetch applies. */
function decodeReadmeText(bytes: Uint8Array): string | null {
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
 * What a submission stores for the README its parse read, by the same rule
 * the fetch applies: a Markdown README under {@link MAX_README_BYTES} is `ok`,
 * a bigger one `too_large`, one that is not Markdown (or is blank)
 * `not_found`. Null leaves the version to the fetch job: bytes that are not
 * UTF-8 text are the fetch's call to make.
 *
 * @param input.path Repository-relative README path.
 * @param input.ref The commit the submission was parsed at.
 */
export function submittedReadmeColumns(
  input: { path: string; bytes: Uint8Array; ref: string },
  now: Date,
): McpReadmeColumns | null {
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const read = {
    readmePath: input.path,
    readmeFetchedAt: now,
    readmeAttempts: 0,
    readmeError: null,
  } as const;
  const absent = {
    ...read,
    readmeMd: null,
    readmeSha256: null,
    readmeNextFetchAt: after(now, MCP_README_ABSENT_REFRESH_MS),
  } as const;
  if (!README_PATH.test(name)) {
    return { ...absent, readmeStatus: "not_found", readmeRef: null };
  }
  if (input.bytes.byteLength > MAX_README_BYTES) {
    return { ...absent, readmeStatus: "too_large", readmeRef: input.ref };
  }
  const markdown = decodeReadmeText(input.bytes);
  if (markdown === null) {
    return null;
  }
  if (!markdown.trim()) {
    return { ...absent, readmeStatus: "not_found", readmeRef: null };
  }
  return {
    ...read,
    readmeStatus: "ok",
    readmeMd: markdown,
    readmeRef: input.ref,
    readmeSha256: createHash("sha256").update(input.bytes).digest("hex"),
    readmeNextFetchAt: after(now, MCP_README_REFRESH_MS),
  };
}

/**
 * The README file's own addresses at `ref` — `blob` for the page on
 * github.com, `raw` for its bytes — built from the directory bases
 * {@link githubReadmeLinkBases} gives. A relative link in the README resolves
 * against the file's address the way a browser resolves it on that page.
 */
export function githubReadmeFileUrls(input: {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}) {
  const bases = githubReadmeLinkBases(input);
  const name = input.path.split("/").filter(Boolean).at(-1) ?? "";
  const file = encodeURIComponent(name);
  return {
    blobUrl: `${bases.blobBase}${file}`,
    rawUrl: `${bases.rawBase}${file}`,
  };
}

/**
 * The `readme` field of the MCP detail APIs, from a version's stored columns
 * and its server's repository URL. The text is included only for `ok`; the
 * source only when a README file is known on a GitHub repository.
 */
export function mcpReadmeView(input: {
  repoUrl: string | null;
  readmeStatus: McpReadmeStatus;
  readmeMd: string | null;
  readmePath: string | null;
  readmeRef: string | null;
}): MarketMcpReadme {
  const repository = parseGitHubRepoRef(input.repoUrl);
  const source =
    input.readmePath && !("unsupported" in repository)
      ? {
          repoUrl: `https://github.com/${repository.owner}/${repository.repo}`,
          ref: input.readmeRef,
          path: input.readmePath,
          ...githubReadmeFileUrls({
            owner: repository.owner,
            repo: repository.repo,
            ref: input.readmeRef ?? "HEAD",
            path: input.readmePath,
          }),
        }
      : null;
  return {
    status: input.readmeStatus,
    ...(input.readmeStatus === "ok" && input.readmeMd !== null
      ? { markdown: input.readmeMd }
      : {}),
    source,
  };
}

/**
 * The directory the fetch asks GitHub for the README of. A version whose
 * README is known keeps being read where it was found — the registry's
 * subfolder, or wherever the submission found it. Before that, the
 * `repository.subfolder` its provenance records ("" for the root).
 */
export function mcpReadmeSubfolder(input: {
  readmePath: string | null;
  provenanceJson: Record<string, unknown> | null;
}): string {
  if (input.readmePath) {
    return input.readmePath.split("/").filter(Boolean).slice(0, -1).join("/");
  }
  const repository = input.provenanceJson?.repository;
  const subfolder =
    repository && typeof repository === "object"
      ? (repository as { subfolder?: unknown }).subfolder
      : undefined;
  return typeof subfolder === "string" ? subfolder : "";
}
