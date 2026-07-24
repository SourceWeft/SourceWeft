import {
  marketMcpManifestSchema,
  type MarketMcpManifest,
  type McpTransport,
} from "@sourceweft/market-contracts";
import { logger } from "../../shared/logger";
import { upsertMarketMcp } from "./ingest/repository";
import { classifyByText } from "./parser/categories";

/**
 * Upstream MCP registries we federate from. Both conform to the official MCP
 * Registry OpenAPI spec (GET /v0/servers with cursor pagination), so a single
 * client shape works for all of them. We are a downstream discovery catalog:
 * these entries are already namespace-verified upstream.
 */
export type RegistrySource = {
  source: string;
  baseUrl: string;
  // Whether entries from this source are namespace-verified upstream. Only a
  // source we trust to verify ownership should mint verified=true rows.
  verified: boolean;
};

export const DEFAULT_REGISTRY_SOURCES: RegistrySource[] = [
  {
    source: "registry.modelcontextprotocol.io",
    baseUrl: "https://registry.modelcontextprotocol.io",
    verified: true,
  },
];

type RegistryRemote = { type?: string; url?: string };
type RegistryServer = {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  remotes?: RegistryRemote[];
  packages?: unknown[];
  repository?: { url?: string; source?: string } | null;
  _meta?: Record<string, unknown>;
};
type RegistryEntry = {
  server?: RegistryServer;
  _meta?: Record<string, unknown>;
} & RegistryServer;
type RegistryPage = {
  servers?: RegistryEntry[];
  metadata?: { nextCursor?: string | null; count?: number };
};

// The registry returns every published version of a server. We only catalog the
// latest, so the item's "latest" is unambiguous (federated rows would otherwise
// share a publishedAt). Entries without the marker are kept (default include).
function isLatestEntry(entry: RegistryEntry) {
  const meta = (entry._meta ?? entry.server?._meta) as
    | Record<string, unknown>
    | undefined;
  const official = meta?.["io.modelcontextprotocol.registry/official"] as
    | { isLatest?: boolean }
    | undefined;
  return official?.isLatest !== false;
}

function transportFromRemote(remote: RegistryRemote | undefined): McpTransport {
  if (remote?.type === "sse") {
    return "sse";
  }
  return "streamable_http"; // "streamable-http" and anything else default here
}

function providerFromIdentifier(identifier: string) {
  // Reverse-DNS names look like "ac.inference.sh/mcp" or "io.github.owner/name".
  const namespace = identifier.split("/")[0] ?? identifier;
  return namespace;
}

function displayName(server: RegistryServer, identifier: string) {
  if (server.title && server.title.trim()) {
    return server.title.trim();
  }
  const tail = identifier.split("/").pop() ?? identifier;
  return tail
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Map an upstream registry entry to our market manifest. Returns null for
 * entries we can't represent (missing name/version). Registry entries are
 * treated as verified (namespace-checked upstream) but not "official" (that
 * badge is reserved for first-party curation).
 */
export function mapRegistryServerToManifest(
  entry: RegistryEntry,
  options: { verified: boolean } = { verified: false },
): MarketMcpManifest | null {
  const server: RegistryServer = entry.server ?? entry;
  const identifier = server.name?.trim();
  const version = server.version?.trim();
  if (!identifier || !version) {
    return null;
  }

  const remote = server.remotes?.[0];
  const hasRemote = Boolean(remote?.url);
  const transport: McpTransport = hasRemote
    ? transportFromRemote(remote)
    : "stdio";
  const summary =
    server.description?.trim() ||
    `MCP server ${identifier} from the MCP registry.`;

  // The official registry has no category field, so classify from the text it
  // does give us (name/title/description/provider). Keeps federated entries
  // browsable by category instead of landing uncategorized.
  // Classify from human text only. The reverse-DNS identifier/namespace is
  // deliberately excluded: nearly every registry entry is io.github.*, and the
  // "github" keyword match was mis-tagging the whole catalog as
  // developer-tools regardless of function.
  const categories = classifyByText(
    [server.title, server.description].filter(Boolean).join(" "),
  );

  const candidate = {
    schemaVersion: 1 as const,
    identifier,
    version,
    name: displayName(server, identifier),
    summary: summary.slice(0, 500),
    description: server.description?.trim() || undefined,
    providerName: providerFromIdentifier(identifier),
    transport,
    endpointUrl: hasRemote ? remote?.url : undefined,
    desktopOnly: !hasRemote,
    webExecutable: hasRemote,
    official: false,
    verified: options.verified,
    auth: { type: "none" as const, required: false, allowedHeaderNames: [] },
    categories,
    tools: [],
    sourceUrl: server.repository?.url ?? undefined,
    repoUrl: server.repository?.url ?? undefined,
  };

  const parsed = marketMcpManifestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

async function fetchRegistryPage(
  baseUrl: string,
  cursor: string | undefined,
  limit: number,
): Promise<RegistryPage> {
  const url = new URL("/v0/servers", baseUrl);
  url.searchParams.set("limit", String(limit));
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Registry ${baseUrl} responded ${response.status}`);
  }
  return (await response.json()) as RegistryPage;
}

// The full registry is thousands of servers across dozens of pages; a single
// transient network blip late in the walk shouldn't throw away all the pages we
// already ingested. Retry a page a few times before giving up on it.
async function fetchRegistryPageWithRetry(
  baseUrl: string,
  cursor: string | undefined,
  limit: number,
  attempts = 3,
): Promise<RegistryPage> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchRegistryPage(baseUrl, cursor, limit);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Pull every server from an upstream registry and upsert it into the catalog as
 * origin=upstream. Returns counts for observability. `maxServers` bounds a run.
 */
export async function ingestFromRegistry(input: {
  source: string;
  baseUrl: string;
  verified: boolean;
  maxServers?: number;
  pageSize?: number;
}) {
  const pageSize = Math.min(input.pageSize ?? 100, 100);
  const maxServers = input.maxServers ?? Number.POSITIVE_INFINITY;
  let cursor: string | undefined;
  let ingested = 0;
  let skipped = 0;
  let partial = false;
  let error: string | undefined;

  while (ingested < maxServers) {
    let page: RegistryPage;
    try {
      page = await fetchRegistryPageWithRetry(input.baseUrl, cursor, pageSize);
    } catch (pageError) {
      // A page fetch failed even after retries. The rows upserted on earlier
      // pages are already committed, so record what we have and stop rather than
      // throwing away the whole run — the next scheduled sync resumes the walk.
      partial = true;
      error = pageError instanceof Error ? pageError.message : String(pageError);
      logger.warn("Registry federation page fetch failed; keeping partial run", {
        source: input.source,
        ingested,
        skipped,
        error,
      });
      break;
    }
    const entries = page.servers ?? [];
    if (entries.length === 0) {
      break;
    }
    for (const entry of entries) {
      if (ingested >= maxServers) {
        break;
      }
      if (!isLatestEntry(entry)) {
        skipped += 1;
        continue;
      }
      const manifest = mapRegistryServerToManifest(entry, { verified: input.verified });
      if (!manifest) {
        skipped += 1;
        continue;
      }
      try {
        await upsertMarketMcp({
          manifest,
          status: "published",
          visibility: "public",
          origin: "upstream",
          source: input.source,
          owner: manifest.providerName ?? null,
          provenanceJson: { source: input.source, meta: entry._meta ?? {} },
        });
        ingested += 1;
      } catch (error) {
        skipped += 1;
        logger.warn("Registry federation upsert failed", {
          identifier: manifest.identifier,
          source: input.source,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    cursor = page.metadata?.nextCursor ?? undefined;
    if (!cursor) {
      break;
    }
  }

  logger.info("Registry federation run complete", {
    source: input.source,
    ingested,
    skipped,
    partial,
  });
  return { source: input.source, ingested, skipped, partial, error };
}

export async function runMarketFederation(
  sources: RegistrySource[] = DEFAULT_REGISTRY_SOURCES,
  options: { maxServers?: number } = {},
) {
  const results = [];
  for (const source of sources) {
    try {
      results.push(
        await ingestFromRegistry({
          source: source.source,
          baseUrl: source.baseUrl,
          verified: source.verified,
          maxServers: options.maxServers,
        }),
      );
    } catch (error) {
      logger.warn("Registry federation source failed", {
        source: source.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
