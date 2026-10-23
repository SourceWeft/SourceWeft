import { createHash } from "node:crypto";
import {
  marketMcpAuthMetadataSchema,
  marketMcpManifestSchema,
  marketMcpSelfDescriptionSchema,
  marketMcpToolManifestSchema,
  type MarketMcpAuthMetadata,
  type MarketMcpAuthMethod,
  type MarketMcpAuthRequirement,
  type MarketMcpManifest,
  type MarketMcpSelfDescription,
  type MarketMcpToolManifest,
  type McpTransport,
} from "@sourceweft/market-contracts";
import { z } from "zod";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import {
  probeMcpEndpointAuth,
  type McpEndpointAuthProbe,
  type McpEndpointProbe,
} from "../../shared/mcp-auth-probe";
import { createControlledFetch } from "../../shared/security/controlled-fetch";
import { mcpServerVersionId } from "./ingest/plan";
import {
  findStoredEndpointProbes,
  upsertMarketMcp,
  type StoredEndpointProbe,
} from "./ingest/repository";
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
    Record<string, unknown> | undefined;
  const official = meta?.["io.modelcontextprotocol.registry/official"] as
    { isLatest?: boolean } | undefined;
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
 * The registry title, else the server name humanized — or, when that name is
 * generic (`com.notion/mcp` would read "Mcp"), the namespace's brand.
 */
function displayName(server: RegistryServer, identifier: string) {
  if (server.title && server.title.trim()) {
    return server.title.trim();
  }
  const [namespace = identifier] = identifier.split("/");
  const tail = identifier.split("/").pop() ?? identifier;
  return humanize(
    GENERIC_SERVER_NAMES.has(tail.toLowerCase())
      ? namespaceBrand(namespace)
      : tail,
  );
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
 * badge is reserved for first-party curation). `tools` are what the
 * endpoint's own `tools/list` answered the probe (Issue #367); the registry
 * itself lists none.
 */
export function mapRegistryServerToManifest(
  entry: RegistryEntry,
  options: {
    verified: boolean;
    authProbe?: McpEndpointAuthProbe;
    tools?: MarketMcpToolManifest[];
  } = {
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
    tools: options.tools ?? [],
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

const AUTH_PROBE_RESULTS: readonly McpEndpointAuthProbe[] = [
  "open",
  "credential",
  "oauth",
];
const AUTH_PROBE_CONCURRENCY = 8;
// An endpoint's auth can change without a new registry version.
const AUTH_PROBE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What one probe of an endpoint gives the catalog, fresh or reused from the
 * version's stored one: the auth classification, the manifest's tools (what
 * `tools/list` answered; `[]` when it failed, was not tried or listed none)
 * and the provenance's self-description fields of the W1 data contract.
 * `validatedAt` is set only when `initialize` and `tools/list` both
 * succeeded.
 */
type EndpointProbe = {
  result: McpEndpointAuthProbe;
  probedAt: Date;
  tools: MarketMcpToolManifest[];
  selfDescription?: MarketMcpSelfDescription;
  validatedAt?: string;
  authMetadata?: MarketMcpAuthMetadata;
  serverCard?: Record<string, unknown>;
};

const SELF_DESCRIPTION_SOURCE = "remote-probe";
const storedToolsSchema = z.array(marketMcpToolManifestSchema);

function definedEntries<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/**
 * A fresh probe as the catalog keeps it. Tools take the manifest's tool
 * shape with their risk `unknown`: the HITL gate trusts a verified
 * install's catalog risk, and registry entries are verified, so a risk
 * derived from an unauthenticated server's own hints or names would let
 * that server choose which of its tools run without approval. The server's
 * annotations are kept as it sent them, for display only. `validatedAt` is
 * set only for a tool list that is complete.
 */
export function endpointProbeRecord(
  probe: McpEndpointProbe,
  probedAt: Date,
): EndpointProbe {
  const tools = (probe.tools ?? []).flatMap((tool) => {
    const parsed = marketMcpToolManifestSchema.safeParse({
      ...tool,
      risk: "unknown",
    });
    return parsed.success ? [parsed.data] : [];
  });
  return definedEntries({
    result: probe.result,
    probedAt,
    tools,
    selfDescription: probe.selfDescription
      ? {
          source: SELF_DESCRIPTION_SOURCE,
          recordedAt: probedAt.toISOString(),
          ...probe.selfDescription,
        }
      : undefined,
    validatedAt:
      probe.selfDescription && probe.tools && !probe.toolsTruncated
        ? probedAt.toISOString()
        : undefined,
    authMetadata: probe.authMetadata,
    serverCard: probe.serverCard,
  });
}

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
 * `maxAgeMs` (30 days) old at `now`, with what the probe stored alongside it
 * (the self-description it recorded itself, the tools, the auth metadata and
 * the server card; each piece only when well-formed — a tool list that is
 * not takes `validatedAt` with it). A record without a probe time is probed
 * again.
 */
export function storedAuthProbe(
  value: StoredEndpointProbe | undefined,
  endpointUrl: string,
  now: Date,
  maxAgeMs = AUTH_PROBE_MAX_AGE_MS,
): EndpointProbe | undefined {
  if (!value?.authProbe || typeof value.authProbe !== "object") {
    return undefined;
  }
  const stored = value.authProbe as {
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
  if (
    stored.endpointSha256 !== endpointSha256(endpointUrl) ||
    !(age >= 0 && age < maxAgeMs)
  ) {
    return undefined;
  }
  const selfDescription = marketMcpSelfDescriptionSchema.safeParse(
    value.selfDescription,
  );
  const tools = storedToolsSchema.safeParse(value.tools);
  const authMetadata = marketMcpAuthMetadataSchema.safeParse(
    value.authMetadata,
  );
  return definedEntries({
    result,
    probedAt,
    tools: tools.success ? tools.data : [],
    selfDescription:
      selfDescription.success &&
      selfDescription.data.source === SELF_DESCRIPTION_SOURCE
        ? selfDescription.data
        : undefined,
    validatedAt:
      tools.success && typeof value.validatedAt === "string"
        ? value.validatedAt
        : undefined,
    authMetadata: authMetadata.success ? authMetadata.data : undefined,
    serverCard:
      value.serverCard &&
      typeof value.serverCard === "object" &&
      !Array.isArray(value.serverCard)
        ? (value.serverCard as Record<string, unknown>)
        : undefined,
  });
}

async function probeRegistryEndpoint(
  endpointUrl: string,
): Promise<McpEndpointProbe> {
  // Registry endpoints are third-party input: the same endpoint policy as an
  // install's requests, checked on every connection.
  const requests = createControlledFetch({
    enforceAddressChecks: config.endpointAddressChecksEnabled,
    allowedInternalOrigins: config.mcpAllowedInternalOrigins ?? [],
  });
  try {
    const probe = await probeMcpEndpointAuth(endpointUrl, requests.fetch);
    // The probe swallows failures of its follow-up requests; a policy denial
    // among them fails the probe as a whole.
    requests.throwIfDenied();
    return probe;
  } catch (error) {
    requests.throwIfDenied();
    throw error;
  } finally {
    await requests.close();
  }
}

/**
 * The endpoint probe of each entry with a remote: the one stored for that
 * version when it probed the same endpoint within 30 days of `now`, else a
 * fresh one — so the server's self-description and tools refresh with its
 * auth classification. A probe that fails keeps the version's stored one
 * whatever its age (so a transient failure does not empty the entry's
 * tools and flip its overview), or, without one, is left out (the entry is
 * mapped from its declared headers alone, with no tools); either way it is
 * retried on the next sync.
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
  const stored = await findStoredEndpointProbes(
    targets.map((target) => target.versionId),
  );
  const probes = new Map<RegistryEntry, EndpointProbe>();
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
        probes.set(
          target.entry,
          endpointProbeRecord(
            await probeRegistryEndpoint(target.endpointUrl),
            now,
          ),
        );
      } catch (error) {
        failed += 1;
        const previous = storedAuthProbe(
          stored.get(target.versionId),
          target.endpointUrl,
          now,
          Number.POSITIVE_INFINITY,
        );
        if (previous) probes.set(target.entry, previous);
        logger.warn("Registry federation auth probe failed", {
          identifier: target.identifier,
          keptStoredProbe: Boolean(previous),
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
  let authProbed = 0;
  let authProbeFailed = 0;
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
    const authProbes = await registryAuthProbes(
      entries.filter(isLatestEntry).slice(0, maxServers - ingested),
      new Date(),
    );
    authProbed += authProbes.probed;
    authProbeFailed += authProbes.failed;
    for (const entry of entries) {
      if (ingested >= maxServers) {
        break;
      }
      if (!isLatestEntry(entry)) {
        skipped += 1;
        continue;
      }
      const authProbe = authProbes.probes.get(entry);
      const manifest = mapRegistryServerToManifest(entry, {
        verified: input.verified,
        authProbe: authProbe?.result,
        tools: authProbe?.tools,
      });
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
            // What the endpoint said about itself while being probed (Issue
            // #367 W1): kept with the probe, so it refreshes with it.
            selfDescription: authProbe?.selfDescription,
            validatedAt: authProbe?.validatedAt,
            authMetadata: authProbe?.authMetadata,
            serverCard: authProbe?.serverCard,
          },
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
  };
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
