import "server-only";

import {
  MarketClient,
  MarketClientError,
  type GetMarketMcpManifestResponse,
  type ListMarketCategoriesResponse,
  type ListMarketMcpRequest,
  type ListMarketMcpResponse,
} from "@sourceweft/market-sdk";

import { apiBaseUrl } from "./api-base-url";

const MCP_LIST_LIMIT = 100;

function marketClient() {
  // The MCP catalog is now served by the backend (sourceweft-api retired), so
  // the public read API lives at {backend}/v1/mcp — no separate service or
  // service token.
  return new MarketClient({ baseUrl: apiBaseUrl });
}

export function isMarketNotFound(error: unknown) {
  return error instanceof MarketClientError && error.status === 404;
}

export async function listPublicMcp(
  input: ListMarketMcpRequest = {},
): Promise<ListMarketMcpResponse> {
  try {
    return await marketClient().listMcp({
      includeDesktopOnly: true,
      limit: MCP_LIST_LIMIT,
      ...input,
    });
  } catch {
    return { items: [], nextCursor: null };
  }
}

export async function listPublicMcpCategories(): Promise<ListMarketCategoriesResponse> {
  try {
    return await marketClient().listMcpCategories();
  } catch {
    return { items: [] };
  }
}

export async function getPublicMcpManifest(
  identifier: string,
): Promise<GetMarketMcpManifestResponse> {
  return marketClient().getMcpManifest(identifier);
}
