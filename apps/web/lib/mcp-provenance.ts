import {
  marketMcpAuthMetadataSchema,
  type MarketItemVersion,
} from "@sourceweft/market-contracts";

/**
 * The documentation link an MCP server's endpoint published in its RFC 9728
 * protected-resource metadata (`resource_documentation`), as federation kept
 * it in the version's provenance (Issue #367 W1). Https only, and a link for
 * the reader: nothing reads the page it points at. Null when there is none.
 */
export function mcpDocumentationUrl(
  version: Pick<MarketItemVersion, "provenanceJson"> | null | undefined,
): string | null {
  const parsed = marketMcpAuthMetadataSchema.safeParse(
    version?.provenanceJson?.authMetadata,
  );
  const url = parsed.success ? parsed.data.resourceDocumentation : undefined;
  return url && url.startsWith("https://") ? url : null;
}
