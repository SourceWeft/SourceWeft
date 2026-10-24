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
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import {
  probeMcpEndpointAuth,
  type McpEndpointAuthProbe,
  type McpEndpointProbe,
} from "../../shared/mcp-auth-probe";
import {
  boundedMcpListedTools,
  listMcpEndpointTools,
} from "../../shared/mcp-tool-listing";
import { createControlledFetch } from "../../shared/security/controlled-fetch";
import { applyGithubRegistryToManifest } from "./github-registry/manifest";
import { findStoredGithubRegistryRecords } from "./github-registry/repository";
import { firstHttpsIconSrc, type ResolvedIcon } from "./icons/chain";
import { registryIconDryRun } from "./icons/federation-step";
import {
  addIconDryRunCounts,
  emptyIconDryRunCounts,
  type IconDryRunCounts,
} from "./icons/icon-dry-run";
import { registryIcons, type IconTarget } from "./icons/registry-icons";
import { mcpServerVersionId } from "./ingest/plan";
import {
  findStoredEndpointProbes,
  findStoredIconProvenance,
  upsertMarketMcp,
  type StoredEndpointProbes,
} from "./ingest/repository";
import { classifyByText } from "./parser/categories";
import { publisherFromRegistryName } from "./publisher";
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

/** The registry's first usable icon: the same rule as the logo chain's step 1. */
function registryIconUrl(server: RegistryServer) {
  return firstHttpsIconSrc(server.icons);
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
  options: {
    verified: boolean;
    authProbe?: McpEndpointAuthProbe;
    // The logo chain's answer for this entry (`icons/`); without it the
    // manifest keeps the registry icon alone and no source.
    icon?: ResolvedIcon;
    /** What the endpoint listed to an anonymous client; none when unlisted. */
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
    iconUrl: options.icon ? options.icon.iconUrl : registryIconUrl(server),
    iconSource: options.icon?.iconSource,
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
    tools: hasRemote ? (options.tools ?? []) : [],
    sourceUrl: server.repository?.url ?? undefined,
    repoUrl: server.repository?.url ?? undefined,
    // The publisher's domain is only as trustworthy as the registry that
    // verified the namespace: a source we do not trust mints none.
    publisher: options.verified
      ? publisherFromRegistryName(identifier, hasRemote ? remote?.url : undefined)
      : undefined,
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

/**
 * One probe of an endpoint as the catalog keeps it, fresh or reused from the
 * version's stored one: the auth classification and, with it, what the
 * endpoint gave away while being classified (Issue #367 W1) — the
 * `selfDescription` its `initialize` answered, the 401 path's `authMetadata`
 * and the origin's `serverCard`. The tools it lists are the tool listing's.
 */
type AuthProbe = {
  result: McpEndpointAuthProbe;
  probedAt: Date;
  selfDescription?: MarketMcpSelfDescription;
  authMetadata?: MarketMcpAuthMetadata;
  serverCard?: Record<string, unknown>;
};

const SELF_DESCRIPTION_SOURCE = "remote-probe";

function definedEntries<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

/** A fresh probe as the catalog keeps it. */
export function endpointProbeRecord(
  probe: McpEndpointProbe,
  probedAt: Date,
): AuthProbe {
  return definedEntries({
    result: probe.result,
    probedAt,
    selfDescription: probe.selfDescription
      ? {
          source: SELF_DESCRIPTION_SOURCE,
          recordedAt: probedAt.toISOString(),
          ...probe.selfDescription,
        }
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
 * 30 days old at `now`. A record without a probe time is probed again.
 */
export function storedAuthProbe(
  value: unknown,
  endpointUrl: string,
  now: Date,
  maxAgeMs = AUTH_PROBE_MAX_AGE_MS,
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
    age < maxAgeMs
    ? { result, probedAt }
    : undefined;
}

/**
 * What the version's stored probe kept besides its classification, each
 * piece only when well-formed and the remote probe's own (a
 * `selfDescription` another source wrote is not reused here).
 */
export function storedProbePieces(
  stored: StoredEndpointProbes | undefined,
): Pick<AuthProbe, "selfDescription" | "authMetadata" | "serverCard"> {
  const selfDescription = marketMcpSelfDescriptionSchema.safeParse(
    stored?.selfDescription,
  );
  const authMetadata = marketMcpAuthMetadataSchema.safeParse(
    stored?.authMetadata,
  );
  const card = stored?.serverCard;
  return definedEntries({
    selfDescription:
      selfDescription.success &&
      selfDescription.data.source === SELF_DESCRIPTION_SOURCE
        ? selfDescription.data
        : undefined,
    authMetadata: authMetadata.success ? authMetadata.data : undefined,
    serverCard:
      card && typeof card === "object" && !Array.isArray(card)
        ? (card as Record<string, unknown>)
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
    // The probe swallows failures of its follow-up requests (the well-known
    // lookups, the server card); a policy denial among them fails the probe.
    requests.throwIfDenied();
    return probe;
  } catch (error) {
    requests.throwIfDenied();
    throw error;
  } finally {
    await requests.close();
  }
}

type EndpointTarget = {
  entry: RegistryEntry;
  identifier: string;
  endpointUrl: string;
  transport: McpTransport;
  versionId: string;
};

/** Each entry with a remote, with its endpoint and its version's id. */
function endpointTargets(entries: RegistryEntry[]): EndpointTarget[] {
  return entries.flatMap((entry) => {
    const server: RegistryServer = entry.server ?? entry;
    const identifier = server.name?.trim();
    const version = server.version?.trim();
    const remote = primaryRemote(server);
    const endpointUrl = remote?.url;
    return identifier && version && endpointUrl
      ? [
          {
            entry,
            identifier,
            endpointUrl,
            transport: transportFromRemote(remote),
            versionId: mcpServerVersionId(identifier, version),
          },
        ]
      : [];
  });
}

/** Runs `task` over `targets`, `AUTH_PROBE_CONCURRENCY` at a time. */
async function eachConcurrently<T>(
  targets: T[],
  task: (target: T) => Promise<void>,
) {
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      await task(targets[next++]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(AUTH_PROBE_CONCURRENCY, targets.length) },
      worker,
    ),
  );
}

/**
 * The endpoint auth probe of each target: the one stored for that version
 * when it probed the same endpoint within 30 days of `now`, else a fresh one
 * — so what the endpoint says about itself refreshes with its auth
 * classification. A probe that fails keeps the version's stored one whatever
 * its age (a transient failure does not empty the entry), or, without one,
 * is left out (the entry is mapped from its declared headers alone); either
 * way it is retried on the next sync.
 */
async function registryAuthProbes(
  targets: EndpointTarget[],
  stored: Map<string, StoredEndpointProbes>,
  now: Date,
) {
  const probes = new Map<RegistryEntry, AuthProbe>();
  const pending: EndpointTarget[] = [];
  const previous = (target: EndpointTarget, maxAgeMs?: number) => {
    const row = stored.get(target.versionId);
    const probe = storedAuthProbe(
      row?.authProbe,
      target.endpointUrl,
      now,
      maxAgeMs,
    );
    return probe ? { ...probe, ...storedProbePieces(row) } : undefined;
  };
  for (const target of targets) {
    const reused = previous(target);
    if (reused) probes.set(target.entry, reused);
    else pending.push(target);
  }
  let failed = 0;
  await eachConcurrently(pending, async (target) => {
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
      const kept = previous(target, Number.POSITIVE_INFINITY);
      if (kept) probes.set(target.entry, kept);
      logger.warn("Registry federation auth probe failed", {
        identifier: target.identifier,
        keptStoredProbe: Boolean(kept),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { probes, probed: pending.length - failed, failed };
}

type ToolsListing = { tools: MarketMcpToolManifest[]; listedAt: Date };

/**
 * The tool listing as kept in the version's provenance; the tools themselves
 * are the manifest's. The endpoint is kept by hash only, as for the probe.
 */
export function toolsListingRecord(
  endpointUrl: string,
  toolsCount: number,
  listedAt: Date,
) {
  return {
    endpointSha256: endpointSha256(endpointUrl),
    toolsCount,
    listedAt: listedAt.toISOString(),
  };
}

/**
 * The version's stored tool listing of this same endpoint, and whether it is
 * under 30 days old at `now`; undefined when there is none or its record or
 * tools are malformed. The stored tools are bounded again on the way back.
 */
export function storedToolsListing(
  stored: StoredEndpointProbes | undefined,
  endpointUrl: string,
  now: Date,
): (ToolsListing & { fresh: boolean }) | undefined {
  const record = stored?.toolsListing;
  if (!record || typeof record !== "object") return undefined;
  const { endpointSha256: hash, listedAt: listedAtValue } = record as {
    endpointSha256?: unknown;
    listedAt?: unknown;
  };
  if (hash !== endpointSha256(endpointUrl)) return undefined;
  const listedAt = new Date(
    typeof listedAtValue === "string" ? listedAtValue : Number.NaN,
  );
  if (Number.isNaN(listedAt.getTime())) return undefined;
  const tools = registryTools(Array.isArray(stored.tools) ? stored.tools : []);
  const age = now.getTime() - listedAt.getTime();
  return {
    tools,
    listedAt,
    fresh: age >= 0 && age < AUTH_PROBE_MAX_AGE_MS,
  };
}

/**
 * Listed tools as manifest tools. The risk is always "unknown": a verified
 * catalog risk is trusted by the approval gate of an install, and these
 * hints are the server's own claims about itself.
 */
function registryTools(raw: readonly unknown[]): MarketMcpToolManifest[] {
  return boundedMcpListedTools(raw).flatMap((tool) => {
    const parsed = marketMcpToolManifestSchema.safeParse({
      ...tool,
      risk: "unknown",
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Whether federation may list this endpoint's tools anonymously. A query or
 * user info can carry the publisher's credential, so what such a URL lists
 * may be one account's tools; a `{variable}` URL is a template, not an
 * endpoint.
 */
function isListableEndpoint(endpointUrl: string) {
  try {
    const url = new URL(endpointUrl);
    return (
      url.protocol === "https:" &&
      !url.search &&
      !url.username &&
      !url.password &&
      !/[{}]|%7b|%7d/i.test(url.href)
    );
  } catch {
    return false;
  }
}

async function listRegistryEndpointTools(target: EndpointTarget) {
  // The same endpoint policy as the probe and as an install's requests.
  const requests = createControlledFetch({
    enforceAddressChecks: config.endpointAddressChecksEnabled,
    allowedInternalOrigins: config.mcpAllowedInternalOrigins ?? [],
  });
  try {
    return registryTools(
      await listMcpEndpointTools(
        target.endpointUrl,
        target.transport === "sse" ? "sse" : "streamable_http",
        requests.fetch,
      ),
    );
  } catch (error) {
    requests.throwIfDenied();
    throw error;
  } finally {
    await requests.close();
  }
}

/**
 * The tools of each target whose endpoint answered the probe without asking
 * for a credential, as listed to an anonymous client: the version's stored
 * listing of the same endpoint when under 30 days old, else a fresh one. A
 * listing that fails keeps the stored one, at any age, and is retried on the
 * next sync. Endpoints that ask for a credential, or whose probe failed, are
 * not listed; a failed probe keeps the stored listing too.
 */
async function registryToolListings(
  targets: EndpointTarget[],
  probes: Map<RegistryEntry, AuthProbe>,
  stored: Map<string, StoredEndpointProbes>,
  now: Date,
) {
  const listings = new Map<RegistryEntry, ToolsListing>();
  const pending: EndpointTarget[] = [];
  for (const target of targets) {
    const previous = storedToolsListing(
      stored.get(target.versionId),
      target.endpointUrl,
      now,
    );
    const probe = probes.get(target.entry);
    if (!probe) {
      if (previous) listings.set(target.entry, previous);
    } else if (
      probe.result === "open" &&
      isListableEndpoint(target.endpointUrl)
    ) {
      if (previous?.fresh) listings.set(target.entry, previous);
      else pending.push(target);
    }
  }
  let failed = 0;
  await eachConcurrently(pending, async (target) => {
    try {
      listings.set(target.entry, {
        tools: await listRegistryEndpointTools(target),
        listedAt: now,
      });
    } catch (error) {
      failed += 1;
      const previous = storedToolsListing(
        stored.get(target.versionId),
        target.endpointUrl,
        now,
      );
      if (previous) listings.set(target.entry, previous);
      logger.warn("Registry federation tool listing failed", {
        identifier: target.identifier,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return { listings, listed: pending.length - failed, failed };
}

type IngestCounters = {
  ingested: number;
  skipped: number;
  authProbed: number;
  authProbeFailed: number;
  toolsListed: number;
  toolsListFailed: number;
  /** Favicon domains fetched, hits among them, fetches that failed. */
  faviconFetched: number;
  faviconHits: number;
  faviconFailed: number;
  /** Entries whose favicon step did not run (no public storage, or stopped). */
  faviconSkipped: number;
  /** The icon dry-run step (Issue #367); it never changes the displayed icon. */
  iconDryRun: IconDryRunCounts;
};

/**
 * Probe, list, map and upsert one page of registry entries — at most `limit` of
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
    toolsListed: 0,
    toolsListFailed: 0,
    faviconFetched: 0,
    faviconHits: 0,
    faviconFailed: 0,
    faviconSkipped: 0,
    iconDryRun: emptyIconDryRunCounts(),
  };
  const now = new Date();
  const latestEntries = entries.filter(isLatestEntry).slice(0, limit);
  const targets = endpointTargets(latestEntries);
  const stored = await findStoredEndpointProbes(
    targets.map((target) => target.versionId),
  );
  const authProbes = await registryAuthProbes(targets, stored, now);
  counters.authProbed = authProbes.probed;
  counters.authProbeFailed = authProbes.failed;
  const toolListings = await registryToolListings(
    targets,
    authProbes.probes,
    stored,
    now,
  );
  counters.toolsListed = toolListings.listed;
  counters.toolsListFailed = toolListings.failed;
  const icons = await registryEntryIcons(latestEntries, now);
  counters.faviconFetched = icons.faviconFetched;
  counters.faviconHits = icons.faviconHits;
  counters.faviconFailed = icons.faviconFailed;
  counters.faviconSkipped = icons.faviconSkipped;
  const iconDryRun = await registryIconDryRun(
    latestEntries.flatMap((entry) => {
      const server: RegistryServer = entry.server ?? entry;
      const identifier = server.name?.trim();
      const version = server.version?.trim();
      if (!identifier || !version) return [];
      const key = mcpServerVersionId(identifier, version);
      const icon = icons.icons.get(key);
      const probe = authProbes.probes.get(entry);
      return [
        {
          key,
          identifier,
          endpointUrl: primaryRemote(server)?.url,
          repositoryUrl: server.repository?.url?.trim() || undefined,
          registryIconUrl: registryIconUrl(server),
          registryWebsiteUrl: server.websiteUrl,
          selfDescription: probe?.selfDescription,
          authMetadata: probe?.authMetadata,
          faviconUrl:
            icon?.iconProbe?.result === "hit" ? icon.iconProbe.url : undefined,
          current: {
            iconSource: icon?.iconSource ?? "placeholder",
            iconUrl: icon?.iconUrl,
          },
        },
      ];
    }),
    now,
  );
  addIconDryRunCounts(counters.iconDryRun, iconDryRun.counts);
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
    const server: RegistryServer = entry.server ?? entry;
    const icon = icons.icons.get(
      mcpServerVersionId(
        server.name?.trim() ?? "",
        server.version?.trim() ?? "",
      ),
    );
    const toolsListing = toolListings.listings.get(entry);
    const iconProvenance = iconDryRun.provenance.get(
      mcpServerVersionId(
        server.name?.trim() ?? "",
        server.version?.trim() ?? "",
      ),
    );
    const mapped = mapRegistryServerToManifest(entry, {
      verified: input.verified,
      authProbe: authProbe?.result,
      tools: toolsListing?.tools,
      icon,
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
      {
        fallbackName: genericFallbackName(mapped.identifier),
        untitled: !(entry.server ?? entry).title?.trim(),
      },
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
          // When the endpoint last listed the manifest's tools to an
          // anonymous client, kept so syncs within 30 days reuse them.
          toolsListing:
            toolsListing && manifest.endpointUrl
              ? toolsListingRecord(
                  manifest.endpointUrl,
                  manifest.tools.length,
                  toolsListing.listedAt,
                )
              : undefined,
          // The namespace domain's favicon fetch and when it was made, kept
          // so syncs reuse a hit and retry a miss only after 30 days.
          iconProbe: icon?.iconProbe,
          // The icon dry-run's candidates and what the new rules would pick
          // (Issue #367); the displayed icon above is unchanged by them.
          iconCandidates: iconProvenance?.iconCandidates,
          iconDecision: iconProvenance?.iconDecision,
          // What the endpoint said about itself while being probed (Issue
          // #367 W1), kept with the probe so it refreshes with it; validated
          // when it both described itself and listed its tools.
          selfDescription: authProbe?.selfDescription,
          authMetadata: authProbe?.authMetadata,
          serverCard: authProbe?.serverCard,
          validatedAt:
            authProbe?.selfDescription && toolsListing
              ? toolsListing.listedAt.toISOString()
              : undefined,
          // What the GitHub MCP Registry's daily pass (W5) stored for the
          // version, carried over as it was found: the pass, not the sync,
          // refreshes it.
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
 * The logo chain of each entry (`icons/registry-icons.ts`), keyed by version
 * id: steps 1–3 from the entry and the version's stored provenance, then a
 * favicon fetch for the namespace domain when they found nothing and no
 * outcome is cached for it.
 */
async function registryEntryIcons(entries: RegistryEntry[], now: Date) {
  const targets: IconTarget[] = entries.flatMap((entry) => {
    const server: RegistryServer = entry.server ?? entry;
    const identifier = server.name?.trim();
    const version = server.version?.trim();
    if (!identifier || !version) return [];
    const repositoryUrl = server.repository?.url?.trim();
    return [
      {
        key: mcpServerVersionId(identifier, version),
        identifier,
        registryIconUrl: registryIconUrl(server),
        repositoryUrl: repositoryUrl || undefined,
      },
    ];
  });
  return registryIcons(targets, {
    now,
    stored: await findStoredIconProvenance(targets.map((t) => t.key)),
  });
}

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
  let toolsListed = 0;
  let toolsListFailed = 0;
  let faviconFetched = 0;
  let faviconHits = 0;
  let faviconFailed = 0;
  let faviconSkipped = 0;
  const iconDryRun = emptyIconDryRunCounts();
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
    toolsListed += counters.toolsListed;
    toolsListFailed += counters.toolsListFailed;
    faviconFetched += counters.faviconFetched;
    faviconHits += counters.faviconHits;
    faviconFailed += counters.faviconFailed;
    faviconSkipped += counters.faviconSkipped;
    addIconDryRunCounts(iconDryRun, counters.iconDryRun);
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
    toolsListed,
    toolsListFailed,
    faviconFetched,
    faviconHits,
    faviconFailed,
    faviconSkipped,
    iconDryRun,
    partial,
  });
  return {
    source: input.source,
    ingested,
    skipped,
    authProbed,
    authProbeFailed,
    toolsListed,
    toolsListFailed,
    faviconFetched,
    faviconHits,
    faviconFailed,
    faviconSkipped,
    iconDryRun,
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
      toolsListed: 0,
      toolsListFailed: 0,
      faviconFetched: 0,
      faviconHits: 0,
      faviconFailed: 0,
      faviconSkipped: 0,
      iconDryRun: emptyIconDryRunCounts(),
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
    toolsListed: 0,
    toolsListFailed: 0,
    faviconFetched: 0,
    faviconHits: 0,
    faviconFailed: 0,
    faviconSkipped: 0,
    iconDryRun: emptyIconDryRunCounts(),
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
    total.toolsListed += run.toolsListed;
    total.toolsListFailed += run.toolsListFailed;
    total.faviconFetched += run.faviconFetched;
    total.faviconHits += run.faviconHits;
    total.faviconFailed += run.faviconFailed;
    total.faviconSkipped += run.faviconSkipped;
    addIconDryRunCounts(total.iconDryRun, run.iconDryRun);
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
