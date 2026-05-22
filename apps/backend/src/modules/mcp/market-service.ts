import { MarketClient } from "@sourceweft/market-sdk";
import { config } from "../../shared/config";
import { McpError } from "./errors";

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

  async listMcp(input: {
    query?: string;
    category?: string;
    includeDesktopOnly?: boolean;
    limit?: number;
  }) {
    if (!this.isApiBacked()) {
      return { items: [], nextCursor: null };
    }
    return this.client.listMcp(input);
  }

  async getMcp(identifier: string) {
    if (!this.isApiBacked()) {
      throw new McpError(404, "MARKET_DISABLED", "Market API is not enabled");
    }
    return this.client.getMcp(identifier);
  }

  async getMcpManifest(identifier: string, input: { version?: string } = {}) {
    if (!this.isApiBacked()) {
      throw new McpError(404, "MARKET_DISABLED", "Market API is not enabled");
    }
    return this.client.getMcpManifest(identifier, input);
  }
}

export const marketService = new MarketService();
