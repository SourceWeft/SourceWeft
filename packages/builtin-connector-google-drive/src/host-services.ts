import type {
  CapabilityConnectorContribution,
  CapabilityHostEnvironment,
  CreateConnectorAdapters,
} from "@sourceweft/contracts/capability-host-services";
import type { ConnectorAdapter } from "@sourceweft/contracts";
import { toBackendGoogleDriveManifest } from "./backend-manifest";

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

function notImplementedAdapterError(): Error {
  return new Error(
    "The Google Drive connector adapter is not implemented yet; it ships in a follow-up task",
  );
}

/**
 * Stub adapter: registers the capability and its manifest so the connector is
 * discoverable and configurable end to end, but every sync/action/OAuth
 * operation is deferred to the next task, which replaces this file.
 */
function createStubGoogleDriveConnectorAdapter(config: {
  clientId: string;
  redirectUri: string;
}): ConnectorAdapter {
  return {
    capabilityId: "sourceweft/google-drive",
    getManifest() {
      return toBackendGoogleDriveManifest(config);
    },
    exchangeOAuthCode() {
      return Promise.reject(notImplementedAdapterError());
    },
    refreshOAuthToken() {
      return Promise.reject(notImplementedAdapterError());
    },
    // eslint-disable-next-line require-yield -- stub always throws before a yield
    async *discover() {
      throw notImplementedAdapterError();
    },
    extract() {
      return Promise.reject(notImplementedAdapterError());
    },
    executeAction() {
      return Promise.reject(notImplementedAdapterError());
    },
  };
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
  parseProjectNumber(clientId);
  const redirectUri = `${env.baseUrl}/v1/connectors/oauth/google_drive/callback`;
  return {
    adapters: [
      createStubGoogleDriveConnectorAdapter({ clientId, redirectUri }),
    ],
    agentToolDefs: [],
  };
};
