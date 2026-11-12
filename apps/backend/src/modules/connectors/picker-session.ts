import { ConnectorError } from "./errors";
import type { ConnectorAdapter, SourceConnectorRecord } from "./types";
import type { ConnectorOAuthService } from "./oauth-service";

/** The only action Google Drive's adapter exposes for this flow. */
const GOOGLE_DRIVE_PICKER_CONFIG_ACTION = "google_drive.picker.config";

export type GoogleDrivePickerSession = {
  accessToken: string;
  appId: string;
  developerKey: string;
  mimeTypes: string[];
};

type GoogleDrivePickerConfig = {
  appId: string;
  developerKey: string;
  mimeTypes: string[];
};

function isGoogleDrivePickerConfig(
  value: Record<string, unknown>,
): value is GoogleDrivePickerConfig {
  return (
    typeof value.appId === "string" &&
    value.appId.length > 0 &&
    typeof value.developerKey === "string" &&
    value.developerKey.length > 0 &&
    Array.isArray(value.mimeTypes) &&
    value.mimeTypes.every((item) => typeof item === "string")
  );
}

/**
 * Builds a short-lived Google Picker session: the runtime OAuth access token
 * (a `drive.file` token) plus the adapter's non-secret picker configuration.
 *
 * This is a deliberate, bounded exception to "the UI never holds a provider
 * token" — callers must only reach it for a workspace admin, and must never
 * log or persist the returned `accessToken`.
 */
export async function createGoogleDrivePickerSession(input: {
  connector: SourceConnectorRecord | null;
  teamId: string;
  workspaceId: string;
  deps: {
    getRuntimeToken: ConnectorOAuthService["getRuntimeToken"];
    getAdapter: (type: string) => ConnectorAdapter;
  };
}): Promise<GoogleDrivePickerSession> {
  const { connector, teamId, workspaceId, deps } = input;

  if (
    !connector ||
    connector.connectorType !== "google_drive" ||
    connector.status !== "active"
  ) {
    throw new ConnectorError(
      404,
      "GOOGLE_DRIVE_CONNECTOR_NOT_FOUND",
      "Active Google Drive connector not found",
    );
  }

  const accessToken = await deps.getRuntimeToken({
    teamId,
    workspaceId,
    accountId: connector.oauthAccountId,
    connectorType: "google_drive",
  });

  const adapter = deps.getAdapter("google_drive");
  const actionResult = await adapter.executeAction({
    teamId,
    workspaceId,
    connectorId: connector.id,
    connectorType: "google_drive",
    actionType: GOOGLE_DRIVE_PICKER_CONFIG_ACTION,
    request: {},
    config: connector.configJson,
    accessToken,
    idempotencyKey: GOOGLE_DRIVE_PICKER_CONFIG_ACTION,
  });

  if (!isGoogleDrivePickerConfig(actionResult.result)) {
    throw new ConnectorError(
      502,
      "GOOGLE_DRIVE_PICKER_CONFIG_INVALID",
      "Google Drive adapter returned a malformed picker configuration",
    );
  }

  return {
    accessToken,
    appId: actionResult.result.appId,
    developerKey: actionResult.result.developerKey,
    mimeTypes: actionResult.result.mimeTypes,
  };
}
