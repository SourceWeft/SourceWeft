import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
  connectorSelectionSearchResultSchema,
  type ConnectorSelectionBrowseResult,
  type ConnectorSelectionDescribeResult,
  type ConnectorSelectionSearchResult,
} from "@sourceweft/contracts";
import { logger } from "../../shared/logger";
import { ConnectorError, toConnectorError } from "./errors";
import type {
  ConnectorAdapter,
  ConnectorManifest,
  SourceConnectorRecord,
} from "./types";
import type { ConnectorOAuthService } from "./oauth-service";

/** The three selection actions a connector's manifest may declare under
 * `selection.actions` (`browse` and `describe` required, `search` optional). */
export type ConnectorSelectionActionName = "browse" | "search" | "describe";

const SELECTION_ACTION_NAMES: readonly ConnectorSelectionActionName[] = [
  "browse",
  "search",
  "describe",
];

const SELECTION_RESULT_SCHEMAS = {
  browse: connectorSelectionBrowseResultSchema,
  search: connectorSelectionSearchResultSchema,
  describe: connectorSelectionDescribeResultSchema,
} as const;

/**
 * Parses the `:action` route segment into one of the three supported
 * selection actions. Any other value is unsupported rather than a validation
 * error: the route cannot tell from the segment alone whether the connector
 * even has a `selection` descriptor, so every unrecognised action name
 * answers the same way a disabled one would.
 */
export function parseConnectorSelectionAction(
  value: string,
): ConnectorSelectionActionName {
  if (
    (SELECTION_ACTION_NAMES as readonly string[]).includes(value)
  ) {
    return value as ConnectorSelectionActionName;
  }
  throw new ConnectorError(
    404,
    "CONNECTOR_SELECTION_UNSUPPORTED",
    `Unsupported connector selection action: ${value}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runs one of a connector's internal selection actions (browse, search,
 * describe) with a freshly resolved runtime OAuth token.
 *
 * Generalises `runDropboxBrowseAction` (and mirrors
 * `createGoogleDrivePickerSession`) across every connector type that
 * declares a `selection` manifest entry, rather than one module per
 * connector: the connector must exist and be `active` or `error` — `error`
 * means the last sync failed, not that the connection itself is unusable,
 * and an admin may need the selection dialog to repair it. `paused` and
 * `disabled` connectors get nothing.
 */
export async function runConnectorSelectionAction(input: {
  connector: SourceConnectorRecord | null;
  teamId: string;
  workspaceId: string;
  action: ConnectorSelectionActionName;
  request: unknown;
  deps: {
    getRuntimeToken: ConnectorOAuthService["getRuntimeToken"];
    getAdapter: (type: string) => ConnectorAdapter;
    getManifest: (type: string) => ConnectorManifest;
  };
}): Promise<
  | ConnectorSelectionBrowseResult
  | ConnectorSelectionSearchResult
  | ConnectorSelectionDescribeResult
> {
  const { connector, teamId, workspaceId, action, request, deps } = input;

  if (
    !connector ||
    (connector.status !== "active" && connector.status !== "error")
  ) {
    throw new ConnectorError(
      404,
      "CONNECTOR_SELECTION_NOT_FOUND",
      "Usable connector not found",
    );
  }

  const manifest = deps.getManifest(connector.connectorType);
  const actionType = manifest.selection?.actions[action];
  if (!actionType) {
    throw new ConnectorError(
      404,
      "CONNECTOR_SELECTION_UNSUPPORTED",
      `Connector type '${connector.connectorType}' does not support the '${action}' selection action`,
    );
  }

  if (!isPlainObject(request)) {
    throw new ConnectorError(
      400,
      "CONNECTOR_SELECTION_INVALID_REQUEST",
      "Selection request body must be a JSON object",
    );
  }

  const accessToken = await deps.getRuntimeToken({
    teamId,
    workspaceId,
    accountId: connector.oauthAccountId,
    connectorType: connector.connectorType,
  });

  const adapter = deps.getAdapter(connector.connectorType);
  // The adapter validates `request` and talks to the provider here. Its
  // errors are the capability package's own class; convert them so the API
  // answers with their status and code (a refused token must reach the
  // caller as a reauthorization error, not as a 500).
  const actionResult = await adapter
    .executeAction({
      teamId,
      workspaceId,
      connectorId: connector.id,
      connectorType: connector.connectorType,
      actionType,
      request,
      config: connector.configJson,
      accessToken,
      idempotencyKey: actionType,
    })
    .catch((error: unknown) => {
      throw toConnectorError(error);
    });

  const schema = SELECTION_RESULT_SCHEMAS[action];
  const parsed = schema.safeParse(actionResult.result);
  if (!parsed.success) {
    // Never log the payload or zod's `message` text: both can echo values
    // from the connector's result (R3).
    logger.warn("connector_selection_invalid_result", {
      connectorType: connector.connectorType,
      action,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
      })),
    });
    throw new ConnectorError(
      502,
      "CONNECTOR_SELECTION_INVALID_RESULT",
      "Connector returned an invalid selection result",
    );
  }

  return parsed.data;
}
