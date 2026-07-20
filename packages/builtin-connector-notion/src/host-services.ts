import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createNotionConnectorAdapter } from "./adapter";
import { notionAgentToolDefs } from "./agent-tool-defs";

/**
 * This capability's half of the connector host-service contract.
 *
 * The environment variable names below are Notion's, and they live here for
 * the same reason the OAuth URLs do: they are facts about Notion, not about
 * the host. The backend used to read them out of its own config object under a
 * `connectors.notion` key, which meant deleting this package left a dangling
 * branch of host configuration behind.
 */
export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
}: {
  env: CapabilityHostEnvironment;
}): CapabilityConnectorContribution => ({
  adapters: [
    createNotionConnectorAdapter({
      baseUrl: env.baseUrl,
      redirectUri: env.get("NOTION_REDIRECT_URI")?.trim() || undefined,
      clientId: env.get("NOTION_CLIENT_ID")?.trim() ?? "",
      clientSecret: env.get("NOTION_CLIENT_SECRET")?.trim() ?? "",
      webhookSecret: env.get("NOTION_WEBHOOK_SECRET")?.trim() ?? "",
    }),
  ],
  agentToolDefs: [...notionAgentToolDefs],
});
