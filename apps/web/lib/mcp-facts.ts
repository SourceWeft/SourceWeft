import type {
  MarketItemSummary,
  MarketMcpManifest,
  McpTransport,
} from "@sourceweft/market-contracts";

import {
  mcpAuthExplanation,
  mcpAuthMethod,
  type McpAuthMethod,
} from "./mcp-auth-method";

/**
 * The plain facts about a catalog MCP server that its template description
 * and facts panel are built from (#367 W4). Each reader is tolerant: the
 * publisher (W2), the self-description and the auth metadata (W1) arrive in
 * sibling workstreams, so they are absent on entries synced before them and
 * on contract versions that do not carry them yet.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host of an http(s) URL (`mcp.notion.com`); null for anything else. */
export function mcpEndpointHost(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.host || null;
  } catch {
    return null;
  }
}

/**
 * The domain a server's publisher is known by (`notion.com`), from the
 * `publisher` W2 derives from the registry namespace onto the manifest and
 * the catalog item. Null without one (an `io.github.*` namespace, or an
 * entry synced before publishers existed).
 */
export function mcpPublisherDomain(source: unknown): string | null {
  if (!isRecord(source)) return null;
  const publisher = source.publisher;
  if (!isRecord(publisher)) return null;
  const domain = publisher.domain;
  return typeof domain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)
    ? domain.toLowerCase()
    : null;
}

/**
 * The documentation a server points to from its protected-resource metadata
 * (RFC 9728 `resource_documentation`, kept by W1 as
 * `provenance.authMetadata.resourceDocumentation`). Shown as a link, never
 * fetched. Null unless it is an http(s) URL.
 */
export function mcpDocumentationUrl(provenanceJson: unknown): string | null {
  if (!isRecord(provenanceJson)) return null;
  const authMetadata = provenanceJson.authMetadata;
  if (!isRecord(authMetadata)) return null;
  const url = authMetadata.resourceDocumentation;
  if (typeof url !== "string") return null;
  return mcpEndpointHost(url) ? url.trim() : null;
}

/** What a public server page's facts panel and template are built from. */
export type McpPublicFacts = {
  name: string;
  publisherDomain: string | null;
  endpointHost: string | null;
  transport: McpTransport;
  authMethod: McpAuthMethod;
  authExplanation: ReturnType<typeof mcpAuthExplanation>;
  toolCount: number;
  documentationUrl: string | null;
  repoUrl: string | null;
  homepageUrl: string | null;
};

/**
 * The facts of a public server page: from the manifest first, the catalog
 * item where the manifest says nothing, the version's provenance for what
 * the server said about itself. Plain data, so a client component can show
 * it without the manifest.
 */
export function publicMcpFacts({
  item,
  manifest,
  provenanceJson,
}: {
  item: MarketItemSummary;
  manifest: MarketMcpManifest;
  provenanceJson?: unknown;
}): McpPublicFacts {
  return {
    name: item.name || manifest.name,
    publisherDomain: mcpPublisherDomain(manifest) ?? mcpPublisherDomain(item),
    endpointHost: mcpEndpointHost(manifest.endpointUrl),
    transport: manifest.transport,
    authMethod: mcpAuthMethod(manifest.auth, item.requiresAuth),
    authExplanation: mcpAuthExplanation(manifest.auth, item.requiresAuth),
    toolCount: manifest.tools.length,
    documentationUrl: mcpDocumentationUrl(provenanceJson),
    repoUrl: manifest.repoUrl ?? item.repoUrl ?? null,
    homepageUrl: manifest.homepageUrl ?? item.homepageUrl ?? null,
  };
}
