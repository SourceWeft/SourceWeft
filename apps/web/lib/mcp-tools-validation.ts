import {
  marketMcpToolsValidationSchema,
  type MarketItemSummary,
  type MarketItemVersion,
  type MarketMcpToolsValidation,
  type McpStdioValidationReason,
} from "@sourceweft/market-contracts";

/**
 * The stdio package validation a page shows in place of "0 tools" (Issue
 * #367, W1b): the platform started the package once in a sandbox without
 * credentials and it did not list its tools. Only while the server has no
 * tools at all — a count it does have is the count.
 *
 * The summary carries it (`toolsValidation`); an answer from before the
 * field existed is read from the latest version's provenance instead, which
 * the detail page has anyway.
 */
export function mcpToolsValidation(
  item: Pick<MarketItemSummary, "toolsCount"> &
    Partial<Pick<MarketItemSummary, "toolsValidation">>,
  versions: ReadonlyArray<Pick<MarketItemVersion, "provenanceJson">> = [],
): MarketMcpToolsValidation | null {
  if (item.toolsCount > 0) return null;
  if (item.toolsValidation !== undefined) return item.toolsValidation;
  const latest = versions[0];
  const parsed = marketMcpToolsValidationSchema.safeParse(
    latest?.provenanceJson.validation,
  );
  return parsed.success ? parsed.data : null;
}

/** The `mcp.toolsValidation.reason.*` message key of a reason. */
export function mcpToolsValidationReasonKey(
  reason: McpStdioValidationReason,
): "install" | "start" | "protocol" | "timeout" | "unsupportedPackage" {
  return reason === "unsupported-package" ? "unsupportedPackage" : reason;
}
