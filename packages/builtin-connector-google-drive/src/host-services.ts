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
}: {
  env: CapabilityHostEnvironment;
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
  const pickerApiKey = env.get("GOOGLE_DRIVE_PICKER_API_KEY")?.trim() ?? "";
  if (!clientId || !clientSecret || !pickerApiKey) {
    throw new Error(
      "Google Drive connector enabled without GOOGLE_DRIVE_CLIENT_ID, " +
        "GOOGLE_DRIVE_CLIENT_SECRET, and GOOGLE_DRIVE_PICKER_API_KEY",
    );
  }
  // Fail fast if the client id carries no project number; the adapter needs it
  // to answer the picker-config action.
  parseProjectNumber(clientId);
  return {
    adapters: [
      createGoogleDriveConnectorAdapter({
        baseUrl: env.baseUrl,
        clientId,
        clientSecret,
        pickerApiKey,
      }),
    ],
    agentToolDefs: [],
  };
};
