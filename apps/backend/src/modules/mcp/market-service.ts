import {
  MarketClient,
  MarketClientError,
  type ListMarketMcpRequest,
} from "@sourceweft/market-sdk";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { McpError } from "./errors";

function marketError(error: unknown) {
  if (error instanceof MarketClientError) {
    return new McpError(
      error.status,
      error.code,
      error.message,
      error.details,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new McpError(
    503,
    "MARKET_API_UNAVAILABLE",
    `Market API is unavailable: ${message}`,
  );
}

function emptyMcpList() {
  return { items: [], nextCursor: null };
}

export class MarketService {
  private readonly client = new MarketClient({
    baseUrl: config.market.baseUrl,
    getToken: () => config.market.serviceToken || undefined,
  });

  isEnabled() {
    return config.market.mode !== "disabled";
  }

  isApiBacked() {
    return (
      config.market.mode === "official_api" ||
      config.market.mode === "private_api"
    );
  }

  async listMcp(input: ListMarketMcpRequest = {}) {
    if (!this.isApiBacked()) {
      return emptyMcpList();
    }
    try {
      // Forward the full filter set (transport/official/verified/runtime/cursor)
      // rather than dropping facets the API and contract support.
      return await this.client.listMcp(input);
    } catch (error) {
      // An outage must be observable, not silently indistinguishable from an
      // empty catalog. We still degrade to empty so the dashboard renders.
      logger.warn("Market listMcp failed; returning empty catalog", {
        error: error instanceof Error ? error.message : String(error),
      });
      return emptyMcpList();
    }
  }

  async listMcpCategories() {
    if (!this.isApiBacked()) {
      return { items: [] };
    }
    try {
      return await this.client.listMcpCategories();
    } catch (error) {
      logger.warn("Market listMcpCategories failed; returning empty list", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { items: [] };
    }
  }

  async getMcp(identifier: string) {
    if (!this.isApiBacked()) {
      throw new McpError(404, "MARKET_DISABLED", "Market API is not enabled");
    }
    try {
      return await this.client.getMcp(identifier);
    } catch (error) {
      throw marketError(error);
    }
  }

  async getMcpManifest(identifier: string, input: { version?: string } = {}) {
    if (!this.isApiBacked()) {
      throw new McpError(404, "MARKET_DISABLED", "Market API is not enabled");
    }
    try {
      return await this.client.getMcpManifest(identifier, input);
    } catch (error) {
      throw marketError(error);
    }
  }
}

export const marketService = new MarketService();
