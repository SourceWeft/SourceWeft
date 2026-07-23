import type { ListMarketMcpRequest } from "@sourceweft/market-contracts";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";
import { listMcpCategories as readMcpCategories } from "../market/read-categories";
import {
  findMcp,
  findMcpVersion,
  listMcp as readListMcp,
} from "../market/read-repository";
import { McpError } from "./errors";

function emptyMcpList() {
  return { items: [], nextCursor: null };
}

/**
 * Reads the MCP catalog directly from the in-process market module (the
 * publisher was folded into this backend when sourceweft-api was retired), so
 * there is no longer an HTTP hop or a separate market service to reach.
 */
export class MarketService {
  isEnabled() {
    return config.market.enabled;
  }

  async listMcp(input: ListMarketMcpRequest = {}) {
    if (!this.isEnabled()) {
      return emptyMcpList();
    }
    try {
      return await readListMcp(input);
    } catch (error) {
      logger.warn("Market listMcp failed; returning empty catalog", {
        error: error instanceof Error ? error.message : String(error),
      });
      return emptyMcpList();
    }
  }

  async listMcpCategories() {
    if (!this.isEnabled()) {
      return { items: [] };
    }
    try {
      return await readMcpCategories();
    } catch (error) {
      logger.warn("Market listMcpCategories failed; returning empty list", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { items: [] };
    }
  }

  async getMcp(identifier: string) {
    if (!this.isEnabled()) {
      throw new McpError(404, "MARKET_DISABLED", "MCP market is not enabled");
    }
    const record = await findMcp(identifier);
    if (!record) {
      throw new McpError(404, "MCP_ITEM_NOT_FOUND", "MCP item not found");
    }
    return { item: record.item, versions: record.versions };
  }

  async getMcpManifest(identifier: string, input: { version?: string } = {}) {
    if (!this.isEnabled()) {
      throw new McpError(404, "MARKET_DISABLED", "MCP market is not enabled");
    }
    const found = await findMcpVersion(identifier, input.version);
    if (!found) {
      throw new McpError(
        404,
        "MCP_MANIFEST_NOT_FOUND",
        "MCP manifest not found",
      );
    }
    return {
      item: found.record.item,
      version: found.itemVersion,
      manifest: found.itemVersion.manifestJson,
    };
  }
}

export const marketService = new MarketService();
