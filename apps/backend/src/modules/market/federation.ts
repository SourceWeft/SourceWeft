import { createHash } from "node:crypto";
import {
  marketMcpManifestSchema,
  type MarketMcpAuthMethod,
  type MarketMcpAuthRequirement,
  type MarketMcpManifest,
  type McpTransport,
} from "@sourceweft/market-contracts";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import {
  probeMcpEndpointAuth,
  type McpEndpointAuthProbe,
} from "../../shared/mcp-auth-probe";
import { createControlledFetch } from "../../shared/security/controlled-fetch";
import { applyGithubRegistryToManifest } from "./github-registry/manifest";
import { findStoredGithubRegistryRecords } from "./github-registry/repository";
import { mcpServerVersionId } from "./ingest/plan";
import { findStoredAuthProbes, upsertMarketMcp } from "./ingest/repository";
import { classifyByText } from "./parser/categories";
import { registryServerProvenance } from "./registry-server";

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

type RegistryRemote = { type?: string; url?: string; headers?: unknown[] };
type RegistryServer = {
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  remotes?: RegistryRemote[];
  icons?: unknown[];
  packages?: unknown[];
  repository?: {
    url?: string;
    source?: string;
    id?: string;
    subfolder?: string;
  } | null;
  websiteUrl?: string;
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

// Server names that say only "this is an MCP server" — `com.notion/mcp`.
const GENERIC_SERVER_NAMES = new Set([
  "mcp",
  "server",
  "mcp-server",
  "server-mcp",
  "mcp-remote",
  "remote",
]);

function humanize(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * The brand a reverse-DNS namespace names: the owner of `io.github.<owner>`,
 * otherwise the domain label after the top-level one (`com.notion` →
 * notion).
 */
function namespaceBrand(namespace: string) {
  const labels = namespace.split(".").filter(Boolean);
  if (labels[0] === "io" && labels[1] === "github" && labels[2]) {
    return labels[2];
  }
  return labels[1] ?? labels[0] ?? namespace;
}

/**
 * The name an untitled entry gets when its server name is generic
 * (`com.notion/mcp` would read "Mcp"): the namespace's brand, humanized —
 * "Notion". Undefined when the name is specific. Exported so the GitHub MCP
 * Registry enrichment can tell this fallback from a registry title.
 */
export function genericFallbackName(identifier: string): string | undefined {
  const [namespace = identifier] = identifier.split("/");
  const tail = identifier.split("/").pop() ?? identifier;
  return GENERIC_SERVER_NAMES.has(tail.toLowerCase())
    ? humanize(namespaceBrand(namespace))
    : undefined;
}

/**
 * The registry title, else the server name humanized — or, when that name is
 * generic, the namespace's brand (`genericFallbackName`).
 */
function displayName(server: RegistryServer, identifier: string) {
  if (server.title && server.title.trim()) {
    return server.title.trim();
  }
  const tail = identifier.split("/").pop() ?? identifier;
  return genericFallbackName(identifier) ?? humanize(tail);
}

function registryIconUrl(server: RegistryServer) {
  for (const icon of server.icons ?? []) {
    if (!icon || typeof icon !== "object") continue;
    const src = (icon as { src?: unknown }).src;
    if (typeof src !== "string") continue;
    try {
      const url = new URL(src);
      if (url.protocol === "https:") {
        return url.toString();
      }
    } catch {
      // Ignore malformed upstream icon entries and try the next candidate.
    }
  }
  return undefined;
}

/**
 * The registry's `repository` object, kept in the version's provenance: its
 * `subfolder` is where a monorepo keeps this server, and so the directory
 * whose README the README fetch reads. Only the string fields the registry
 * defines are kept.
 */
export function registryRepositoryProvenance(
  entry: RegistryEntry,
): Record<string, string> | undefined {
  const repository = (entry.server ?? entry).repository;
  if (!repository || typeof repository !== "object") {
    return undefined;
  }
  const kept: Record<string, string> = {};
  for (const key of ["url", "source", "id", "subfolder"] as const) {
    const value = repository[key];
    if (typeof value === "string" && value.trim()) {
      kept[key] = value.trim();
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/** The remote the manifest's endpoint comes from. */
function primaryRemote(server: RegistryServer) {
  return server.remotes?.[0];
}

/**
 * How a federated server is authenticated, from the headers its remote
 * declares and what its endpoint answered an unauthenticated `initialize`
 * (`probe`; undefined when it could not be probed):
 * - an OAuth challenge → "oauth", required; a declared credential header
 *   (`Authorization`, else the first secret one) stays as `headerName`, so
 *   the listing can say "OAuth or API key";
 * - a 401 without one → the declared credential header, required, or
 *   "oauth" when none is declared (the MCP spec's meaning of a bare 401);
 * - otherwise → the declared headers, required only when one is declared
 *   required; none when nothing is.
 * A header that is neither required nor answered by a 401 is optional, which
 * the catalog lists as not required.
 *
 * Alongside, what a member may connect with: `methods` (OAuth first, then the
 * credential header) and `posture` — required when the endpoint or a
 * declared header demands auth, optional when only a credential header is
 * offered. An optional posture keeps `type` "none", so installs never block.
 */
export function registryRemoteAuth(
  remote: RegistryRemote | undefined,
  probe: McpEndpointAuthProbe | undefined,
): MarketMcpAuthRequirement {
  const headers = (remote?.headers ?? []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const header = entry as {
      name?: unknown;
      isRequired?: unknown;
      isSecret?: unknown;
      description?: unknown;
    };
    const name = typeof header.name === "string" ? header.name.trim() : "";
    const description =
      typeof header.description === "string"
        ? header.description.trim().slice(0, 300).trim()
        : "";
    return HEADER_NAME_RE.test(name)
      ? [
          {
            name,
            required: header.isRequired === true,
            secret: header.isSecret === true,
            description: description || undefined,
          },
        ]
      : [];
  });
  // Header names are case-insensitive; the first spelling declared wins.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { name } of headers) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  const credentialHeader =
    names.find((name) => /^authorization$/i.test(name)) ??
    headers.find((header) => header.secret)?.name;
  const oauth =
    probe === "oauth" || (probe === "credential" && names.length === 0);

  const methods: MarketMcpAuthMethod[] = oauth ? [{ type: "oauth" }] : [];
  if (credentialHeader) {
    const description = headers.find(
      (header) => header.name.toLowerCase() === credentialHeader.toLowerCase(),
    )?.description;
    methods.push({
      type: "header",
      name: credentialHeader,
      ...(/^authorization$/i.test(credentialHeader)
        ? { scheme: "bearer" as const }
        : {}),
      ...(description ? { description } : {}),
    });
  }
  const posture =
    probe === "oauth" ||
    probe === "credential" ||
    headers.some((header) => header.required)
      ? "required"
      : credentialHeader
        ? "optional"
        : "none";

  if (oauth) {
    return {
      type: "oauth",
      required: true,
      headerName: credentialHeader,
      allowedHeaderNames: names,
      posture,
      methods,
    };
  }
  const required =
    probe === "credential" || headers.some((header) => header.required);
  if (!required || names.length === 0) {
    return {
      type: "none",
      required: false,
      allowedHeaderNames: [],
      posture,
      methods,
    };
  }
  if (credentialHeader && /^authorization$/i.test(credentialHeader)) {
    return {
      type: "bearer",
      required: true,
      headerName: credentialHeader,
      displayName: "Authorization token",
      allowedHeaderNames: names,
      posture,
      methods,
    };
  }
  const single = names.length === 1 ? names[0] : undefined;
  return {
    type: single ? "api_key_header" : "custom_headers",
    required: true,
    headerName: single,
    displayName: single ?? "Custom headers",
    allowedHeaderNames: names,
    posture,
    methods,
  };
}

/**
 * Map an upstream registry entry to our market manifest. Returns null for
 * entries we can't represent (missing name/version). Registry entries are
 * treated as verified (namespace-checked upstream) but not "official" (that
 * badge is reserved for first-party curation).
 */
export function mapRegistryServerToManifest(
  entry: RegistryEntry,
  options: { verified: boolean; authProbe?: McpEndpointAuthProbe } = {
    verified: false,
  },
): MarketMcpManifest | null {
  const server: RegistryServer = entry.server ?? entry;
  const identifier = server.name?.trim();
  const version = server.version?.trim();
  if (!identifier || !version) {
    return null;
  }

  const remote = primaryRemote(server);
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
    homepageUrl: server.websiteUrl,
    iconUrl: registryIconUrl(server),
    transport,
    endpointUrl: hasRemote ? remote?.url : undefined,
    desktopOnly: !hasRemote,
    webExecutable: hasRemote,
    official: false,
    verified: options.verified,
    auth: registryRemoteAuth(
      hasRemote ? remote : undefined,
      hasRemote ? options.authProbe : undefined,
    ),
    categories,
    tools: [],
    sourceUrl: server.repository?.url ?? undefined,
    repoUrl: server.repository?.url ?? undefined,
  };

  const parsed = marketMcpManifestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// A registry page request that hangs would stall the whole walk: bound it.
const REGISTRY_PAGE_TIMEOUT_MS = 30_000;
// The full registry is thousands of servers across some two hundred pages; a
// single transient network blip late in the walk shouldn't throw away all the
// pages we already ingested, and three quick retries half a second apart did
// not outlast one in production (2026-10-23). Retry a page with exponential
// backoff — 1 s, 2 s, 4 s, 8 s, 16 s — before giving up on it.
const REGISTRY_PAGE_ATTEMPTS = 6;
const REGISTRY_PAGE_RETRY_MAX_DELAY_MS = 30_000;

/** How a failed registry page request is retried. */
export type RegistryPageRetry = {
  attempts: number;
  /** Milliseconds to wait before attempt number `attempt` (2, 3, …). */
  delayMs: (attempt: number) => number;
};

export const DEFAULT_REGISTRY_PAGE_RETRY: RegistryPageRetry = {
  attempts: REGISTRY_PAGE_ATTEMPTS,
  delayMs: (attempt) =>
    Math.min(1000 * 2 ** (attempt - 2), REGISTRY_PAGE_RETRY_MAX_DELAY_MS),
};

function registryPageUrl(
  baseUrl: string,
  cursor: string | undefined,
  limit: number,
) {
  const url = new URL("/v0/servers", baseUrl);
  url.searchParams.set("limit", String(limit));
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  return url;
}

async function fetchRegistryPage(url: URL): Promise<RegistryPage> {
  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REGISTRY_PAGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Registry ${url.origin} responded ${response.status}`);
  }
  return (await response.json()) as RegistryPage;
}

async function fetchRegistryPageWithRetry(
  url: URL,
  retry: RegistryPageRetry = DEFAULT_REGISTRY_PAGE_RETRY,
): Promise<RegistryPage> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      return await fetchRegistryPage(url);
    } catch (error) {
      lastError = error;
      if (attempt < retry.attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, retry.delayMs(attempt + 1)),
        );
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const AUTH_PROBE_RESULTS: readonly McpEndpointAuthProbe[] = [
  "open",
  "credential",
  "oauth",
];
const AUTH_PROBE_CONCURRENCY = 8;
// An endpoint's auth can change without a new registry version.
const AUTH_PROBE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type AuthProbe = { result: McpEndpointAuthProbe; probedAt: Date };

function endpointSha256(endpointUrl: string) {
  return createHash("sha256").update(endpointUrl).digest("hex");
}

/**
 * The probe as kept in the version's provenance. The endpoint is kept by hash
 * only: a registry remote URL can carry a credential in its query, which
 * provenance never stores.
 */
export function authProbeRecord(
  endpointUrl: string,
  result: McpEndpointAuthProbe,
  probedAt: Date,
) {
  return {
    endpointSha256: endpointSha256(endpointUrl),
    result,
    probedAt: probedAt.toISOString(),
  };
}

/**
 * The version's stored probe, when it was of this same endpoint and is under
 * 30 days old at `now`. A record without a probe time is probed again.
 */
export function storedAuthProbe(
  value: unknown,
  endpointUrl: string,
  now: Date,
): AuthProbe | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as {
    endpointSha256?: unknown;
    result?: unknown;
    probedAt?: unknown;
  };
  if (!AUTH_PROBE_RESULTS.includes(stored.result as McpEndpointAuthProbe)) {
    return undefined;
  }
  const result = stored.result as McpEndpointAuthProbe;
  const probedAt = new Date(
    typeof stored.probedAt === "string" ? stored.probedAt : Number.NaN,
  );
  const age = now.getTime() - probedAt.getTime();
  return stored.endpointSha256 === endpointSha256(endpointUrl) &&
    age >= 0 &&
    age < AUTH_PROBE_MAX_AGE_MS
    ? { result, probedAt }
    : undefined;
}

async function probeRegistryEndpoint(
  endpointUrl: string,
): Promise<McpEndpointAuthProbe> {
  // Registry endpoints are third-party input: the same endpoint policy as an
  // install's requests, checked on every connection.
  const requests = createControlledFetch({
    enforceAddressChecks: config.endpointAddressChecksEnabled,
    allowedInternalOrigins: config.mcpAllowedInternalOrigins ?? [],
  });
  try {
    return await probeMcpEndpointAuth(endpointUrl, requests.fetch);
  } catch (error) {
    requests.throwIfDenied();
    throw error;
  } finally {
    await requests.close();
  }
}

/**
 * The endpoint auth probe of each entry with a remote: the one stored for
 * that version when it probed the same endpoint within 30 days of `now`,
 * else a fresh one. A probe that fails is left out (the entry is mapped from
 * its declared headers alone) and retried on the next sync.
 */
async function registryAuthProbes(entries: RegistryEntry[], now: Date) {
  const targets = entries.flatMap((entry) => {
    const server: RegistryServer = entry.server ?? entry;
    const identifier = server.name?.trim();
    const version = server.version?.trim();
    const endpointUrl = primaryRemote(server)?.url;
    return identifier && version && endpointUrl
      ? [
          {
            entry,
            identifier,
            endpointUrl,
            versionId: mcpServerVersionId(identifier, version),
          },
        ]
      : [];
  });
  const stored = await findStoredAuthProbes(
    targets.map((target) => target.versionId),
  );
  const probes = new Map<RegistryEntry, AuthProbe>();
  const pending: typeof targets = [];
  for (const target of targets) {
    const reused = storedAuthProbe(
      stored.get(target.versionId),
      target.endpointUrl,
      now,
    );
    if (reused) probes.set(target.entry, reused);
    else pending.push(target);
  }
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const target = pending[next++]!;
      try {
        probes.set(target.entry, {
          result: await probeRegistryEndpoint(target.endpointUrl),
          probedAt: now,
        });
      } catch (error) {
        failed += 1;
        logger.warn("Registry federation auth probe failed", {
          identifier: target.identifier,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(AUTH_PROBE_CONCURRENCY, pending.length) },
      worker,
    ),
  );
  return { probes, probed: pending.length - failed, failed };
}

type IngestCounters = {
  ingested: number;
  skipped: number;
  authProbed: number;
  authProbeFailed: number;
};

/**
 * Probe, map and upsert one page of registry entries — at most `limit` of
 * them; the non-latest versions among them count as skipped, as does an entry
 * that cannot be mapped or whose upsert fails.
 */
async function ingestRegistryEntries(
  entries: RegistryEntry[],
  input: { source: string; verified: boolean },
  limit: number,
): Promise<IngestCounters> {
  const counters: IngestCounters = {
    ingested: 0,
    skipped: 0,
    authProbed: 0,
    authProbeFailed: 0,
  };
  const latestEntries = entries.filter(isLatestEntry).slice(0, limit);
  const authProbes = await registryAuthProbes(latestEntries, new Date());
  counters.authProbed = authProbes.probed;
  counters.authProbeFailed = authProbes.failed;
  // The GitHub MCP Registry enrichment (`github-registry/`) runs apart from
  // this sync and writes on the version's provenance, which the upsert below
  // replaces whole: its record is carried over, and the manifest changes it
  // earned are applied again.
  const githubRegistryRecords = await findStoredGithubRegistryRecords(
    latestEntries.flatMap((entry) => {
      const server: RegistryServer = entry.server ?? entry;
      const identifier = server.name?.trim();
      const version = server.version?.trim();
      return identifier && version
        ? [mcpServerVersionId(identifier, version)]
        : [];
    }),
  );
  for (const entry of entries) {
    if (counters.ingested >= limit) {
      break;
    }
    if (!isLatestEntry(entry)) {
      counters.skipped += 1;
      continue;
    }
    const authProbe = authProbes.probes.get(entry);
    const mapped = mapRegistryServerToManifest(entry, {
      verified: input.verified,
      authProbe: authProbe?.result,
    });
    if (!mapped) {
      counters.skipped += 1;
      continue;
    }
    const { manifest, record: githubRegistry } = applyGithubRegistryToManifest(
      mapped,
      githubRegistryRecords.get(
        mcpServerVersionId(mapped.identifier, mapped.version),
      ),
      { fallbackName: genericFallbackName(mapped.identifier) },
    );
    try {
      await upsertMarketMcp({
        manifest,
        status: "published",
        visibility: "public",
        origin: "upstream",
        source: input.source,
        owner: manifest.providerName ?? null,
        provenanceJson: {
          source: input.source,
          meta: entry._meta ?? {},
          repository: registryRepositoryProvenance(entry),
          // Packages and remotes, names and flags only: what the AI
          // overview says the server needs to run.
          registryServer: registryServerProvenance(entry.server ?? entry),
          // The endpoint's answer to an unauthenticated initialize and when
          // it was given, kept so syncs within 30 days reuse it instead of
          // probing the version again.
          authProbe:
            authProbe && manifest.endpointUrl
              ? authProbeRecord(
                  manifest.endpointUrl,
                  authProbe.result,
                  authProbe.probedAt,
                )
              : undefined,
          githubRegistry,
        },
      });
      counters.ingested += 1;
    } catch (error) {
      counters.skipped += 1;
      logger.warn("Registry federation upsert failed", {
        identifier: manifest.identifier,
        source: input.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return counters;
}

export type RegistryIngestResult = IngestCounters & {
  source: string;
  /** The walk stopped before the registry's last page. */
  partial: boolean;
  error?: string;
  /**
   * Where a partial walk stopped: the cursor of the page that could not be
   * read, to resume from (`cursor`); undefined when it was the first page.
   */
  nextCursor?: string;
};

/**
 * Pull every server from an upstream registry and upsert it into the catalog as
 * origin=upstream. Returns counts for observability. `maxServers` bounds a run;
 * `cursor` resumes a partial one from where it stopped.
 */
export async function ingestFromRegistry(input: {
  source: string;
  baseUrl: string;
  verified: boolean;
  maxServers?: number;
  pageSize?: number;
  cursor?: string;
  retry?: RegistryPageRetry;
}): Promise<RegistryIngestResult> {
  const pageSize = Math.min(input.pageSize ?? 100, 100);
  const maxServers = input.maxServers ?? Number.POSITIVE_INFINITY;
  let cursor = input.cursor;
  let nextCursor: string | undefined;
  let ingested = 0;
  let skipped = 0;
  let authProbed = 0;
  let authProbeFailed = 0;
  let partial = false;
  let error: string | undefined;

  while (ingested < maxServers) {
    let page: RegistryPage;
    try {
      page = await fetchRegistryPageWithRetry(
        registryPageUrl(input.baseUrl, cursor, pageSize),
        input.retry,
      );
    } catch (pageError) {
      // A page fetch failed even after retries. The rows upserted on earlier
      // pages are already committed, so record what we have and stop rather than
      // throwing away the whole run — the caller resumes the walk from this
      // cursor (`runMarketFederation`), or the next scheduled sync does.
      partial = true;
      nextCursor = cursor;
      error =
        pageError instanceof Error ? pageError.message : String(pageError);
      logger.warn(
        "Registry federation page fetch failed; keeping partial run",
        {
          source: input.source,
          ingested,
          skipped,
          error,
        },
      );
      break;
    }
    const entries = page.servers ?? [];
    if (entries.length === 0) {
      break;
    }
    const counters = await ingestRegistryEntries(
      entries,
      input,
      maxServers - ingested,
    );
    ingested += counters.ingested;
    skipped += counters.skipped;
    authProbed += counters.authProbed;
    authProbeFailed += counters.authProbeFailed;
    cursor = page.metadata?.nextCursor ?? undefined;
    if (!cursor) {
      break;
    }
  }

  logger.info("Registry federation run complete", {
    source: input.source,
    resumed: input.cursor !== undefined,
    ingested,
    skipped,
    authProbed,
    authProbeFailed,
    partial,
  });
  return {
    source: input.source,
    ingested,
    skipped,
    authProbed,
    authProbeFailed,
    partial,
    error,
    nextCursor,
  };
}

/**
 * Federate one registry entry now, outside the scheduled walk: the latest
 * version of `identifier`, read through the registry's search, then probed,
 * mapped and upserted exactly as the walk would. For operators
 * (`dist/market-federate-entry.js`), when a correction must not wait for the
 * walk to reach the entry.
 */
export async function federateRegistryEntry(input: {
  identifier: string;
  source?: RegistrySource;
  retry?: RegistryPageRetry;
}): Promise<IngestCounters & { identifier: string; found: boolean }> {
  const source = input.source ?? DEFAULT_REGISTRY_SOURCES[0]!;
  const identifier = input.identifier.trim();
  const url = new URL("/v0/servers", source.baseUrl);
  url.searchParams.set("search", identifier);
  url.searchParams.set("version", "latest");
  const page = await fetchRegistryPageWithRetry(url, input.retry);
  // The search is a text match: keep the entry with exactly this name.
  const entries = (page.servers ?? []).filter(
    (entry) =>
      (entry.server ?? entry).name?.trim() === identifier &&
      isLatestEntry(entry),
  );
  if (entries.length === 0) {
    return {
      identifier,
      found: false,
      ingested: 0,
      skipped: 0,
      authProbed: 0,
      authProbeFailed: 0,
    };
  }
  const counters = await ingestRegistryEntries(entries.slice(0, 1), source, 1);
  return { identifier, found: true, ...counters };
}

// A partial walk resumes from its last cursor after a pause instead of waiting
// for the next interval and starting over: the registry is some two hundred
// pages, and one failed page used to cost the rest of the walk (six hours).
export const FEDERATION_RESUME_DELAY_MS = 60_000;
export const FEDERATION_MAX_RESUMES = 20;

export type FederationResume = { maxResumes: number; delayMs: number };

export type MarketFederationResult = RegistryIngestResult & {
  /** How many times the walk resumed after a failed page. */
  resumes: number;
};

async function ingestSourceWithResume(
  source: RegistrySource,
  options: { maxServers?: number; retry?: RegistryPageRetry },
  resume: FederationResume,
): Promise<MarketFederationResult> {
  const total: IngestCounters = {
    ingested: 0,
    skipped: 0,
    authProbed: 0,
    authProbeFailed: 0,
  };
  let cursor: string | undefined;
  let resumes = 0;
  for (;;) {
    const run = await ingestFromRegistry({
      source: source.source,
      baseUrl: source.baseUrl,
      verified: source.verified,
      maxServers:
        options.maxServers === undefined
          ? undefined
          : options.maxServers - total.ingested,
      cursor,
      retry: options.retry,
    });
    total.ingested += run.ingested;
    total.skipped += run.skipped;
    total.authProbed += run.authProbed;
    total.authProbeFailed += run.authProbeFailed;
    if (!run.partial || resumes >= resume.maxResumes) {
      return {
        ...total,
        source: source.source,
        partial: run.partial,
        error: run.error,
        nextCursor: run.nextCursor,
        resumes,
      };
    }
    resumes += 1;
    logger.warn("Registry federation resuming after a failed page", {
      source: source.source,
      resumes,
      delayMs: resume.delayMs,
      fromStart: run.nextCursor === undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, resume.delayMs));
    cursor = run.nextCursor;
  }
}

export async function runMarketFederation(
  sources: RegistrySource[] = DEFAULT_REGISTRY_SOURCES,
  options: {
    maxServers?: number;
    retry?: RegistryPageRetry;
    resume?: FederationResume;
  } = {},
): Promise<MarketFederationResult[]> {
  const resume = options.resume ?? {
    maxResumes: FEDERATION_MAX_RESUMES,
    delayMs: FEDERATION_RESUME_DELAY_MS,
  };
  const results: MarketFederationResult[] = [];
  for (const source of sources) {
    try {
      results.push(await ingestSourceWithResume(source, options, resume));
    } catch (error) {
      logger.warn("Registry federation source failed", {
        source: source.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
