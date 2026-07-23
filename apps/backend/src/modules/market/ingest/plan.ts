import { createHash } from "node:crypto";
import type { MarketMcpManifest } from "@sourceweft/market-contracts";
import type {
  DryRunIngestResult,
  McpParserReport,
  McpRepositoryIngestOptions,
} from "../types";

export function hashId(prefix: string, value: string) {
  return `${prefix}-${createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

export function buildDryRunIngestResult(
  manifest: MarketMcpManifest,
  provenanceJson: McpParserReport,
  options: McpRepositoryIngestOptions,
): DryRunIngestResult {
  const itemId = hashId("mcp", manifest.identifier);
  return {
    item: {
      id: itemId,
      identifier: manifest.identifier,
      status: options.status,
      visibility: options.visibility,
    },
    version: {
      id: hashId("mcpv", `${manifest.identifier}@${manifest.version}`),
      version: manifest.version,
      status: options.status,
    },
    manifest,
    provenanceJson,
  };
}
