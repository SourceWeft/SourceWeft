/**
 * Hosts whose MCP endpoints expose each account's own connected apps rather
 * than one fixed server: the tool list a member sees there describes their
 * account, not a product. A member's observation is never recorded for an
 * endpoint on one of them (Issue #367). Matched against the endpoint's host
 * and its parent domains, so `mcp.zapier.com` and `a.b.zapier.com` both hit
 * `zapier.com`. To add a gateway, add its registrable domain.
 */
export const ACCOUNT_SPECIFIC_GATEWAY_DOMAINS: readonly string[] = [
  "zapier.com",
  "composio.dev",
  "composio.ai",
  "rube.app",
  "pipedream.com",
  "pipedream.net",
  "smithery.ai",
  "smithery.run",
  "mcp.run",
  "apify.com",
  "make.com",
  "n8n.cloud",
  "workato.com",
  "toolhouse.ai",
  "mcpjungle.com",
];

/** `host` is a normalised hostname (lower-case, no port, no trailing dot). */
export function isAccountSpecificGatewayHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, "");
  return ACCOUNT_SPECIFIC_GATEWAY_DOMAINS.some(
    (domain) => name === domain || name.endsWith(`.${domain}`),
  );
}
