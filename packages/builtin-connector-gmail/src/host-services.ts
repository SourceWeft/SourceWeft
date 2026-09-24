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
}): CapabilityConnectorContribution => {
  const activation = env.get("GMAIL_CONNECTOR_ENABLED")?.trim().toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error("GMAIL_CONNECTOR_ENABLED must be true, false, 1, or 0");
  }
  const clientId = env.get("GMAIL_CLIENT_ID")?.trim() ?? "";
  const clientSecret = env.get("GMAIL_CLIENT_SECRET")?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new Error(
      "Gmail connector enabled without GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET",
    );
  }
  return {
    adapters: [
      createGmailConnectorAdapter({
        baseUrl: env.baseUrl,
        redirectUri: env.get("GMAIL_REDIRECT_URI")?.trim() || undefined,
        clientId,
        clientSecret,
      }),
    ],
    agentToolDefs: [...gmailAgentToolDefs],
  };
};
