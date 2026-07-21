import "server-only";

import {
  MarketClient,
  MarketClientError,
  type GetMarketMcpManifestResponse,
  type ListMarketCategoriesResponse,
  type ListMarketMcpRequest,
  type ListMarketMcpResponse,
} from "@sourceweft/market-sdk";

const DEFAULT_MARKET_API_BASE_URL = "http://localhost:3011";
const MCP_LIST_LIMIT = 100;

function marketApiBaseUrl() {
  return (
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- Runtime market service configuration is supplied by deployment/Compose, not Turbo cache inputs.
    process.env.MARKET_API_BASE_URL?.trim() ||
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- Runtime market service configuration is supplied by deployment/Compose, not Turbo cache inputs.
    process.env.MARKET_API_URL?.trim() ||
    DEFAULT_MARKET_API_BASE_URL
  );
}

function marketClient() {
  return new MarketClient({
    baseUrl: marketApiBaseUrl(),
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- Runtime market service configuration is supplied by deployment/Compose, not Turbo cache inputs.
    getToken: () => process.env.MARKET_SERVICE_TOKEN?.trim() || undefined,
  });
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
