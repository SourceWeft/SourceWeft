import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import { createGoogleDriveConnectorAdapter } from "./adapter";

const PROJECT_NUMBER_PREFIX = /^(\d+)-/;

/**
 * Google OAuth client IDs for a given project are prefixed with that
 * project's numeric ID (`"123456789-abc....apps.googleusercontent.com"`).
 * Extracting it lets the adapter (Task 6) address project-scoped Drive APIs
 * without a second, redundant environment variable.
 */
export function parseProjectNumber(clientId: string): string {
  const match = PROJECT_NUMBER_PREFIX.exec(clientId);
  if (!match) {
    throw new Error(
      "GOOGLE_DRIVE_CLIENT_ID does not start with a Google Cloud project number",
    );
  }
  return match[1] as string;
}

export const createConnectorAdapters: CreateConnectorAdapters = ({
  env,
  logger,
}: {
  env: CapabilityHostEnvironment;
  logger?: { warn?(message: string, meta?: Record<string, unknown>): void };
}): CapabilityConnectorContribution => {
  const activation = env
    .get("GOOGLE_DRIVE_CONNECTOR_ENABLED")
    ?.trim()
    .toLowerCase();
  if (!activation || activation === "false" || activation === "0") {
    return { adapters: [], agentToolDefs: [] };
  }
  if (activation !== "true" && activation !== "1") {
    throw new Error(
      "GOOGLE_DRIVE_CONNECTOR_ENABLED must be true, false, 1, or 0",
    );
  }
  const clientId = env.get("GOOGLE_DRIVE_CLIENT_ID")?.trim() ?? "";
  const clientSecret = env.get("GOOGLE_DRIVE_CLIENT_SECRET")?.trim() ?? "";
  // A client id that is present but carries no project number is malformed:
  // fail fast, because the adapter needs it to answer the picker-config action.
  if (clientId) parseProjectNumber(clientId);
  // A missing credential is not malformed. The connector stays registered,
  // refuses to connect, and says what is missing, so it never silently
  // disappears from the catalog.
  const missing = [
    clientId ? null : "GOOGLE_DRIVE_CLIENT_ID",
    clientSecret ? null : "GOOGLE_DRIVE_CLIENT_SECRET",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    logger?.warn?.("connector_not_configured", {
      connectorType: "google_drive",
      missing,
    });
  }
  return {
    adapters: [
      createGoogleDriveConnectorAdapter({
        baseUrl: env.baseUrl,
        clientId,
        clientSecret,
      }),
    ],
    agentToolDefs: [],
  };
};
