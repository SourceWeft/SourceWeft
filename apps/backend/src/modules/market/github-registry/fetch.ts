import { logger } from "../../../shared/logger";

/**
 * The GitHub MCP Registry (`api.mcp.github.com`): a second registry that
 * lists mostly the same servers as the official one, under the same
 * reverse-DNS names, plus a few brand servers under `owner/repo` names, and
 * carries GitHub repository facts the official registry has no field for
 * (`_meta["io.modelcontextprotocol.registry/publisher-provided"].github`).
 *
 * This client only READS it, anonymously, page by page, and hands back the
 * handful of fields the enrichment keeps. The row's `readme` is dropped at
 * parse time: it is the repository's README, which for a hosted server often
 * describes a different (self-hosted) product, and the catalog has its own
 * README fetch. Nothing here creates catalog listings.
 */

export const GITHUB_MCP_REGISTRY_URL =
  "https://api.mcp.github.com/v0.1/servers";

/** The largest page the API serves (`per_page`); 7 pages covered the 604 rows of 2026-10-23. */
export const GITHUB_REGISTRY_PAGE_SIZE = 100;

/**
 * Pages read per pass at most: three times the registry's size when this was
 * written, so a walk that never ends (a cursor loop) stays bounded.
 */
export const GITHUB_REGISTRY_MAX_PAGES = 20;

/**
 * Largest page body read. A 100-row page with READMEs measured about 3 MB;
 * anything past this is cut off and the pass stops at the rows it has.
 */
export const GITHUB_REGISTRY_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Per request, headers and body together. */
export const GITHUB_REGISTRY_REQUEST_TIMEOUT_MS = 10_000;

const LIMITS = {
  name: 200,
  text: 1000,
  license: 120,
  url: 2000,
} as const;

/** One row of the registry, reduced to what the enrichment reads. */
export type GithubRegistryRow = {
  name: string;
  title?: string;
  description?: string;
  /** The first remote's URL as given; may be a template, not a URL. */
  remoteUrl?: string;
  github: {
    displayName?: string;
    ownerAvatarUrl?: string;
    isInOrganization: boolean;
    stars?: number;
    license?: string;
    nameWithOwner?: string;
  };
};

export type GithubRegistryFetchStop =
  "max_pages" | "rate_limited" | "too_large" | "error";

export type GithubRegistryFetchResult = {
  rows: GithubRegistryRow[];
  pages: number;
  /** Null when the walk reached the last page; else why it stopped early. */
  stoppedBy: GithubRegistryFetchStop | null;
  error?: string;
};

export type FetchGithubRegistryOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  maxPages?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max).trim();
  return trimmed || undefined;
}

/** An https URL, or undefined. Credentials are never kept. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > LIMITS.url) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** The `publisher-provided.github` block of an entry, from either `_meta`. */
function githubMeta(
  entry: Record<string, unknown>,
  server: Record<string, unknown>,
) {
  for (const meta of [server._meta, entry._meta]) {
    if (!isRecord(meta)) continue;
    const provided =
      meta["io.modelcontextprotocol.registry/publisher-provided"];
    if (isRecord(provided) && isRecord(provided.github)) {
      return provided.github;
    }
  }
  return undefined;
}

/** The row an entry describes, or undefined when it has no name. */
export function parseGithubRegistryEntry(
  entry: unknown,
): GithubRegistryRow | undefined {
  if (!isRecord(entry)) return undefined;
  const server = isRecord(entry.server) ? entry.server : entry;
  const name = text(server.name, LIMITS.name);
  if (!name) return undefined;
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const firstRemote = remotes.find(isRecord);
  const github = githubMeta(entry, server) ?? {};
  return {
    name,
    title: text(server.title, LIMITS.name),
    description: text(server.description, LIMITS.text),
    remoteUrl: text(firstRemote?.url, LIMITS.url),
    github: {
      displayName: text(github.displayName, LIMITS.name),
      ownerAvatarUrl: httpsUrl(github.ownerAvatarUrl),
      isInOrganization: github.isInOrganization === true,
      stars: count(github.stargazerCount),
      license: text(github.license, LIMITS.license),
      nameWithOwner: text(github.nameWithOwner, LIMITS.name),
    },
  };
}

function pageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * The rows of one page body and where the next page is, if there is one.
 * The API paginates two ways: by cursor (`metadata.nextCursor`, what it
 * does at its default page size) and by page number (`metadata.page` of
 * `metadata.total_pages`, what it does when `per_page` is given). Either
 * is honored; a cursor first.
 */
export function parseGithubRegistryPage(body: unknown): {
  rows: GithubRegistryRow[];
  next: { cursor: string } | { page: number } | undefined;
} {
  if (!isRecord(body)) {
    throw new Error("The registry page is not a JSON object");
  }
  const servers = Array.isArray(body.servers) ? body.servers : [];
  const rows = servers.flatMap((entry) => {
    const row = parseGithubRegistryEntry(entry);
    return row ? [row] : [];
  });
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const nextCursor = text(metadata.nextCursor, LIMITS.url);
  if (nextCursor) return { rows, next: { cursor: nextCursor } };
  const page = pageNumber(metadata.page);
  const totalPages = pageNumber(metadata.total_pages);
  if (page !== undefined && totalPages !== undefined && page < totalPages) {
    return { rows, next: { page: page + 1 } };
  }
  return { rows, next: undefined };
}

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`The registry page body is over ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** The response body as text, or a `BodyTooLargeError` past `maxBytes`. */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(maxBytes);
  }
  if (!response.body) {
    const whole = await response.text();
    if (whole.length > maxBytes) throw new BodyTooLargeError(maxBytes);
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Walk the registry from its first page, anonymously, and return every row
 * read. The walk stops early, keeping the rows it has, at `maxPages`, at a
 * page body over `maxBodyBytes`, at a 429 (the anonymous rate limit is a few
 * requests an hour), or at any other failed request; `stoppedBy` says which.
 * A pass that reads nothing has an empty `rows` and a `stoppedBy`.
 */
export async function fetchGithubRegistryServers(
  options: FetchGithubRegistryOptions = {},
): Promise<GithubRegistryFetchResult> {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? GITHUB_MCP_REGISTRY_URL;
  const maxPages = options.maxPages ?? GITHUB_REGISTRY_MAX_PAGES;
  const maxBodyBytes = options.maxBodyBytes ?? GITHUB_REGISTRY_MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? GITHUB_REGISTRY_REQUEST_TIMEOUT_MS;

  const rows: GithubRegistryRow[] = [];
  let next: { cursor: string } | { page: number } | undefined;
  let pages = 0;
  for (;;) {
    if (pages >= maxPages) {
      return { rows, pages, stoppedBy: "max_pages" };
    }
    const url = new URL(baseUrl);
    url.searchParams.set("per_page", String(GITHUB_REGISTRY_PAGE_SIZE));
    if (next && "cursor" in next) url.searchParams.set("cursor", next.cursor);
    if (next && "page" in next) url.searchParams.set("page", String(next.page));
    pages += 1;
    try {
      const response = await doFetch(url.toString(), {
        headers: {
          accept: "application/json",
          "user-agent": "sourceweft-market-catalog",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        return {
          rows,
          pages,
          stoppedBy: "rate_limited",
          error: "The registry answered 429",
        };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return {
          rows,
          pages,
          stoppedBy: "error",
          error: `The registry answered ${response.status}`,
        };
      }
      const body = await readBoundedBody(response, maxBodyBytes);
      const page = parseGithubRegistryPage(JSON.parse(body));
      rows.push(...page.rows);
      if (!page.next || page.rows.length === 0) {
        return { rows, pages, stoppedBy: null };
      }
      next = page.next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("GitHub MCP Registry page fetch failed", {
        page: pages,
        rows: rows.length,
        error: message,
      });
      return {
        rows,
        pages,
        stoppedBy: error instanceof BodyTooLargeError ? "too_large" : "error",
        error: message,
      };
    }
  }
}
