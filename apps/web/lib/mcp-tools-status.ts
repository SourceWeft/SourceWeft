import type {
  MarketItemSummary,
  MarketItemVersion,
  McpStdioValidationReason,
} from "@sourceweft/market-contracts";

import { mcpToolsValidation } from "./mcp-tools-validation";

/**
 * What a page can truthfully say about a server's tools. "0 tools" is only
 * one of several reasons a list is empty, and the others say different
 * things: nobody could list them without a credential, the package was never
 * started, it failed to start, the index has not read the server yet, or the
 * server was read and really lists none.
 */
export type McpToolsStatus =
  | { kind: "listed"; count: number }
  /** The listing stops at the cap: there may be more than shown. */
  | { kind: "partial"; count: number }
  /** The endpoint asks for credentials, so nothing was listed anonymously. */
  | { kind: "authRequired" }
  /** A stdio package the sandbox could not start or list. */
  | { kind: "failed"; reason: McpStdioValidationReason }
  /** A stdio package the sandbox has not tried yet. */
  | { kind: "notValidated" }
  /** The server was read and lists no tools. */
  | { kind: "empty" }
  /** A remote the index has not listed (yet). */
  | { kind: "unindexed" };

/** Listings are cut here (`MCP_TOOL_LISTING_LIMITS.tools`, the owner cap). */
export const MCP_TOOLS_LISTING_CAP = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mcpToolsStatus(input: {
  item: Pick<MarketItemSummary, "toolsCount" | "transport" | "requiresAuth"> &
    Partial<Pick<MarketItemSummary, "toolsValidation">>;
  /** The tools the page shows, where that differs from the summary's count. */
  count?: number;
  versions?: ReadonlyArray<Pick<MarketItemVersion, "provenanceJson">>;
  /** The latest version's provenance, when the caller has it. */
  provenanceJson?: unknown;
}): McpToolsStatus {
  const count = input.count ?? input.item.toolsCount;
  if (count >= MCP_TOOLS_LISTING_CAP) return { kind: "partial", count };
  if (count > 0) return { kind: "listed", count };

  const provenance = isRecord(input.provenanceJson)
    ? input.provenanceJson
    : (input.versions?.[0]?.provenanceJson ?? null);
  const remote = input.item.transport !== "stdio";
  if (!remote) {
    const validation = mcpToolsValidation(input.item, input.versions);
    if (validation) return { kind: "failed", reason: validation.reason };
    // A sandbox start that listed nothing is recorded as validated.
    return isRecord(provenance) && typeof provenance.validatedAt === "string"
      ? { kind: "empty" }
      : { kind: "notValidated" };
  }

  const probe = isRecord(provenance?.authProbe) ? provenance.authProbe : null;
  const probeResult = typeof probe?.result === "string" ? probe.result : null;
  if (probeResult === "credential" || probeResult === "oauth") {
    return { kind: "authRequired" };
  }
  const listing = isRecord(provenance?.toolsListing)
    ? provenance.toolsListing
    : null;
  if (listing && listing.toolsCount === 0 && typeof listing.listedAt === "string") {
    return { kind: "empty" };
  }
  // Without a stored probe (a list answer) the summary's flag is all there is.
  if (probeResult === null && input.item.requiresAuth) {
    return { kind: "authRequired" };
  }
  return { kind: "unindexed" };
}

/** The `mcp.toolsStatus.*` message key of a status. */
export function mcpToolsStatusKey(status: McpToolsStatus) {
  return status.kind;
}
