import { ConnectorError, toConnectorError } from "./errors";
import type { ConnectorAdapter, SourceConnectorRecord } from "./types";
import type { ConnectorOAuthService } from "./oauth-service";

/** The three internal actions the Dropbox adapter exposes for this flow
 * (adapter.ts `executeAction`): `dropbox.browse`, `dropbox.search`,
 * `dropbox.describe`. */
export type DropboxBrowseActionName = "browse" | "search" | "describe";

/**
 * Runs one of the Dropbox adapter's browse-dialog actions (browse, search,
 * describe) with a freshly resolved runtime OAuth token.
 *
 * Mirrors `createGoogleDrivePickerSession`: the connector must exist, be a
 * `dropbox` connector, and be `active` or `error` — `error` means the
 * last sync failed, not that the connection itself is unusable, and an admin
 * may need the browse dialog to repair the selection. `paused` and
 * `disabled` connectors get nothing.
 */
export async function runDropboxBrowseAction(input: {
  connector: SourceConnectorRecord | null;
  teamId: string;
  workspaceId: string;
  action: DropboxBrowseActionName;
  request: Record<string, unknown>;
  deps: {
    getRuntimeToken: ConnectorOAuthService["getRuntimeToken"];
    getAdapter: (type: string) => ConnectorAdapter;
  };
}): Promise<Record<string, unknown>> {
  const { connector, teamId, workspaceId, action, request, deps } = input;

  if (
    !connector ||
    connector.connectorType !== "dropbox" ||
    (connector.status !== "active" && connector.status !== "error")
  ) {
    throw new ConnectorError(
      404,
      "DROPBOX_CONNECTOR_NOT_FOUND",
      "Usable Dropbox connector not found",
    );
  }

  const accessToken = await deps.getRuntimeToken({
    teamId,
    workspaceId,
    accountId: connector.oauthAccountId,
    connectorType: "dropbox",
  });

  const adapter = deps.getAdapter("dropbox");
  const actionType = `dropbox.${action}`;
  // The adapter validates `request` and talks to Dropbox here. Its errors
  // are the package's own class; convert them so the API answers with their
  // status and code (a refused token must reach the browser as a
  // reauthorization error, not as a 500).
  const actionResult = await adapter
    .executeAction({
      teamId,
      workspaceId,
      connectorId: connector.id,
      connectorType: "dropbox",
      actionType,
      request,
      config: connector.configJson,
      accessToken,
      idempotencyKey: actionType,
    })
    .catch((error: unknown) => {
      throw toConnectorError(error);
    });

  return actionResult.result as Record<string, unknown>;
}
