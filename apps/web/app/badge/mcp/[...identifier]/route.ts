import {
  getPublicMcpManifest,
  isMarketNotFound,
} from "../../../../lib/market-mcp";
import {
  badgeKeyFromPath,
  badgeNotFound,
  listedBadge,
} from "../../listed-badge-response";

/**
 * The "Listed on SourceWeft" README badge of one MCP server:
 * `/badge/mcp/<encoded identifier>.svg`. The same picture for every listed
 * server; 404 once it is not listed.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ identifier: string[] }> },
) {
  const identifier = badgeKeyFromPath((await params).identifier);
  if (!identifier) return badgeNotFound();
  try {
    await getPublicMcpManifest(identifier);
  } catch (error) {
    if (isMarketNotFound(error)) return badgeNotFound();
    throw error;
  }
  return listedBadge(request);
}
