import type {
  MarketMcpManifest,
  McpRiskLevel,
} from "@sourceweft/market-contracts";
import type { WorkspaceMcpInstall } from "@sourceweft/sdk";

export type McpDetailTool = {
  name: string;
  title: string | null;
  description: string | null;
  risk: McpRiskLevel;
  /** `false` only for a synced tool the workspace switched off. */
  enabled: boolean;
};

/**
 * The tools a detail view lists. The workspace install's synced tools win:
 * federated registry entries publish no tools in the catalog, so the catalog
 * alone would show none for a server that has dozens connected. Before any
 * tools have synced, the catalog manifest and its count are all there is.
 */
export function mcpDetailTools(
  manifest: MarketMcpManifest | null,
  install: WorkspaceMcpInstall | null,
  catalogCount: number,
): { tools: McpDetailTool[]; count: number } {
  if (install && install.tools.length > 0) {
    return {
      tools: install.tools.map((tool) => ({
        name: tool.serverToolName,
        title: tool.title,
        description: tool.description,
        risk: tool.risk,
        enabled: tool.enabled,
      })),
      count: install.tools.length,
    };
  }
  const tools = (manifest?.tools ?? []).map((tool) => ({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    risk: tool.risk,
    enabled: true,
  }));
  return { tools, count: tools.length || catalogCount };
}
