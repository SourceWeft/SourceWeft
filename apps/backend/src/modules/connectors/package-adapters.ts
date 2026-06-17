import {
  createNotionConnectorAdapter,
  notionAgentToolDefs,
  type NotionAdapterRuntimeConfig,
} from "@sourceweft/builtin-connector-notion";
import { config } from "../../shared/config";
import type { ConnectorAdapter } from "@sourceweft/contracts";
import type { AgentToolDefinitionShape } from "@sourceweft/contracts/agent-tools";

function resolveNotionRuntimeConfig(): NotionAdapterRuntimeConfig {
  return {
    baseUrl: config.auth.baseUrl,
    redirectUri: config.connectors.notion.redirectUri,
    clientId: config.connectors.notion.clientId,
    clientSecret: config.connectors.notion.clientSecret,
    webhookSecret: config.connectors.notion.webhookSecret,
  };
}

export function createPackageConnectorAdapters(
  adapters: ConnectorAdapter[] = [
    createNotionConnectorAdapter(resolveNotionRuntimeConfig()),
  ],
): ConnectorAdapter[] {
  return adapters;
}

export function createPackageAgentToolDefs(
  toolDefs: AgentToolDefinitionShape[] = [...notionAgentToolDefs],
): AgentToolDefinitionShape[] {
  return toolDefs;
}
