import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createComposioBroker } from "@sourceweft/connector-broker-composio";
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

  const authProvider =
    env.get("GMAIL_AUTH_PROVIDER")?.trim().toLowerCase() || "google";
  if (authProvider !== "google" && authProvider !== "composio") {
    throw new Error("GMAIL_AUTH_PROVIDER must be google or composio");
  }

  if (authProvider === "composio") {
    const composioApiKey = env.get("COMPOSIO_API_KEY")?.trim() ?? "";
    // A missing key is not malformed. The connector stays registered and
    // refuses to connect (its adapter is built with `broker: null`), so it
    // never silently disappears from the catalog.
    if (!composioApiKey) {
      logger?.warn?.("connector_not_configured", {
        connectorType: "gmail",
        missing: ["COMPOSIO_API_KEY"],
      });
    }
    const broker = composioApiKey
      ? createComposioBroker({
          apiKey: composioApiKey,
          // The host logger passed in only has `warn`; the broker's own
          // `error` level is downgraded to it rather than widening the host
          // logger type, and `info` is left unset.
          logger: {
            error: (message, meta) => logger?.warn?.(message, meta),
          },
        })
      : null;
    return {
      adapters: [
        createGmailConnectorAdapter({
          mode: "composio",
          baseUrl: env.baseUrl,
          broker,
        }),
      ],
      agentToolDefs: [...gmailAgentToolDefs],
    };
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
        mode: "google",
        baseUrl: env.baseUrl,
        redirectUri: env.get("GMAIL_REDIRECT_URI")?.trim() || undefined,
        clientId,
        clientSecret,
      }),
    ],
    agentToolDefs: [...gmailAgentToolDefs],
  };
};
