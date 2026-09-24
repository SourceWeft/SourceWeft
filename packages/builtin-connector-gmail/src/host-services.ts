import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createGmailConnectorAdapter } from "./adapter";
import { gmailAgentToolDefs } from "./agent-tool-defs";

export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
}: {
  env: CapabilityHostEnvironment;
}): CapabilityConnectorContribution => ({
  adapters: [
    createGmailConnectorAdapter({
      baseUrl: env.baseUrl,
      redirectUri: env.get("GMAIL_REDIRECT_URI")?.trim() || undefined,
      clientId: env.get("GMAIL_CLIENT_ID")?.trim() ?? "",
      clientSecret: env.get("GMAIL_CLIENT_SECRET")?.trim() ?? "",
    }),
  ],
  agentToolDefs: [...gmailAgentToolDefs],
});
