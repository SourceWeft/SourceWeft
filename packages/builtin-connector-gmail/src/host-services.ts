import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createGmailConnectorAdapter } from "./adapter";
import { gmailAgentToolDefs } from "./agent-tool-defs";

export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  logger,
}: {
  env: CapabilityHostEnvironment;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
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
  // A missing credential is not malformed. The connector stays registered,
  // refuses to connect, and says what is missing, so it never silently
  // disappears from the catalog.
  const missing = [
    clientId ? null : "GMAIL_CLIENT_ID",
    clientSecret ? null : "GMAIL_CLIENT_SECRET",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    logger?.warn?.("connector_not_configured", {
      connectorType: "gmail",
      missing,
    });
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
