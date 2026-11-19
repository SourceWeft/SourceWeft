import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createLinearConnectorAdapter } from "./adapter";
import { linearAgentToolDefs } from "./agent-tool-defs";

export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  logger,
}: {
  env: CapabilityHostEnvironment;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
}): CapabilityConnectorContribution => {
  const activation = env.get("LINEAR_CONNECTOR_ENABLED")?.trim().toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error("LINEAR_CONNECTOR_ENABLED must be true, false, 1, or 0");
  }
  const clientId = env.get("LINEAR_CLIENT_ID")?.trim() ?? "";
  const clientSecret = env.get("LINEAR_CLIENT_SECRET")?.trim() ?? "";
  // A missing credential is not malformed. The connector stays registered,
  // refuses to connect, and says what is missing, so it never silently
  // disappears from the catalog.
  const missing = [
    clientId ? null : "LINEAR_CLIENT_ID",
    clientSecret ? null : "LINEAR_CLIENT_SECRET",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    logger?.warn?.("connector_not_configured", {
      connectorType: "linear",
      missing,
    });
  }
  return {
    adapters: [
      createLinearConnectorAdapter({
        baseUrl: env.baseUrl,
        clientId,
        clientSecret,
      }),
    ],
    agentToolDefs: [...linearAgentToolDefs],
  };
};
