import type {
  MarketMcpAuthMethod,
  MarketMcpAuthRequirement,
} from "@sourceweft/market-contracts";

/** A key of the `mcp.authMethod` messages. */
export type McpAuthMethod =
  | "notRequired"
  | "optionalApiKey"
  | "required"
  | "oauth"
  | "oauthOrApiKey"
  | "apiKey"
  | "customHeaders";

/**
 * A key of the `mcp.authMethod.explain` messages: one per label, plus
 * `apiKeyAnyHeader` for a key header the manifest does not name.
 */
export type McpAuthExplanation = McpAuthMethod | "apiKeyAnyHeader";

type McpAuth = Pick<
  MarketMcpAuthRequirement,
  | "type"
  | "required"
  | "headerName"
  | "allowedHeaderNames"
  | "posture"
  | "methods"
>;

export type McpAuthHeaderMethod = Extract<
  MarketMcpAuthMethod,
  { type: "header" }
>;

/** The credential header a server accepts, from its declared methods. */
export function mcpAuthHeaderMethod(
  auth: Pick<MarketMcpAuthRequirement, "methods"> | null | undefined,
): McpAuthHeaderMethod | null {
  return (
    auth?.methods?.find(
      (method): method is McpAuthHeaderMethod => method.type === "header",
    ) ?? null
  );
}

/**
 * How a catalog MCP server is authenticated, for its listing's Auth field.
 * An OAuth server that also names a credential header accepts either; an
 * open server that accepts a key header takes it optionally. Without a
 * manifest, only the catalog item's `requiresAuth` flag is known.
 */
export function mcpAuthMethod(
  auth: McpAuth | null | undefined,
  requiresAuth = false,
): McpAuthMethod {
  if (!auth) {
    return requiresAuth ? "required" : "notRequired";
  }
  if (auth.posture === "optional" && mcpAuthHeaderMethod(auth)) {
    return "optionalApiKey";
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

/**
 * The one-sentence explanation under the Auth field: the message key and the
 * header a key is sent in, for the labels that involve one.
 */
export function mcpAuthExplanation(
  auth: McpAuth | null | undefined,
  requiresAuth = false,
): { key: McpAuthExplanation; values: { header?: string } } {
  const method = mcpAuthMethod(auth, requiresAuth);
  if (
    method !== "apiKey" &&
    method !== "oauthOrApiKey" &&
    method !== "optionalApiKey"
  ) {
    return { key: method, values: {} };
  }
  const header =
    mcpAuthHeaderMethod(auth)?.name ??
    auth?.headerName ??
    (auth?.type === "bearer" ? "Authorization" : undefined);
  return header
    ? { key: method, values: { header } }
    : { key: "apiKeyAnyHeader", values: {} };
}
