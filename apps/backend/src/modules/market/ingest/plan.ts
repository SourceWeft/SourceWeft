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

/** The catalog row id of an MCP server, from its identifier. */
export function mcpServerId(identifier: string) {
  return hashId("mcp", identifier);
}

/** The catalog row id of one version of an MCP server. */
export function mcpServerVersionId(identifier: string, version: string) {
  return hashId("mcpv", `${identifier}@${version}`);
}

export function buildDryRunIngestResult(
  manifest: MarketMcpManifest,
  provenanceJson: McpParserReport,
  options: McpRepositoryIngestOptions,
): DryRunIngestResult {
  const itemId = mcpServerId(manifest.identifier);
  return {
    item: {
      id: itemId,
      identifier: manifest.identifier,
      status: options.status,
      visibility: options.visibility,
    },
    version: {
      id: mcpServerVersionId(manifest.identifier, manifest.version),
      version: manifest.version,
      status: options.status,
    },
    manifest,
    provenanceJson,
  };
}
