import {
  marketMcpPublisherSchema,
  type MarketMcpPublisher,
} from "@sourceweft/market-contracts";

/**
 * A registry namespace that names a GitHub account rather than a domain:
 * `io.github.<owner>`. The registry verifies these against GitHub, not DNS,
 * so they have no domain publisher.
 */
function isGitHubNamespace(labels: readonly string[]) {
  return labels[0] === "io" && labels[1] === "github";
}

/**
 * The domain a reverse-DNS registry namespace names, labels reversed:
 * `com.notion` → `notion.com`, `ai.com.mcp` → `mcp.com.ai`. Undefined for a
 * GitHub namespace, a single label (no domain to reverse) or a malformed one.
 */
export function publisherDomainFromNamespace(
  namespace: string,
): string | undefined {
  const labels = namespace.trim().toLowerCase().split(".");
  if (labels.length < 2 || isGitHubNamespace(labels)) {
    return undefined;
  }
  if (
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    return undefined;
  }
  return labels.reverse().join(".");
}

/**
 * Whether `endpointUrl` is served from `domain` or one of its subdomains:
 * `mcp.notion.com` under `notion.com`, never `notnotion.com` or
 * `notion.com.evil.test`. A URL that does not parse matches nothing.
 */
export function endpointMatchesDomain(
  endpointUrl: string | undefined,
  domain: string,
): boolean {
  if (!endpointUrl) {
    return false;
  }
  let host: string;
  try {
    host = new URL(endpointUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The publisher identity of a federated registry entry: the domain its
 * namespace names (the official registry verified ownership of it before the
 * publish), and whether the remote endpoint is on that domain. Undefined for
 * `io.github.*` entries and anything else without a domain namespace.
 */
export function publisherFromRegistryName(
  identifier: string,
  endpointUrl: string | undefined,
): MarketMcpPublisher | undefined {
  const domain = publisherDomainFromNamespace(identifier.split("/")[0]!);
  if (!domain) {
    return undefined;
  }
  return {
    domain,
    source: "registry-namespace",
    endpointMatch: endpointMatchesDomain(endpointUrl, domain),
  };
}

/**
 * The publisher stored on a server's metadata (`metadata_json.publisher`,
 * copied from the latest manifest) or on a manifest, when it is well-formed;
 * null for a server without one or from before it was derived. The one
 * parser for the field: listing, detail and grouping all read it here.
 */
export function publisherMeta(
  value: Record<string, unknown> | null | undefined,
): MarketMcpPublisher | null {
  const parsed = marketMcpPublisherSchema.safeParse(value?.publisher);
  return parsed.success ? parsed.data : null;
}
