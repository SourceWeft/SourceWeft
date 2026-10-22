import type { MarketMcpAuthRequirement } from "@sourceweft/market-contracts";

/** A key of the `mcp.authMethod` messages. */
export type McpAuthMethod =
  | "notRequired"
  | "required"
  | "oauth"
  | "oauthOrApiKey"
  | "apiKey"
  | "customHeaders";

/**
 * How a catalog MCP server is authenticated, for its listing's Auth field.
 * An OAuth server that also names a credential header accepts either; without
 * a manifest, only the catalog item's `requiresAuth` flag is known.
 */
export function mcpAuthMethod(
  auth:
    | Pick<
        MarketMcpAuthRequirement,
        "type" | "required" | "headerName" | "allowedHeaderNames"
      >
    | null
    | undefined,
  requiresAuth = false,
): McpAuthMethod {
  if (!auth) {
    return requiresAuth ? "required" : "notRequired";
  }
  if (!auth.required || auth.type === "none") {
    return "notRequired";
  }
  switch (auth.type) {
    case "oauth":
      return auth.headerName ? "oauthOrApiKey" : "oauth";
    case "bearer":
    case "api_key_header":
      return "apiKey";
    case "custom_headers":
      return auth.allowedHeaderNames.length > 0 ? "customHeaders" : "required";
  }
}
