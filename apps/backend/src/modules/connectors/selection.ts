import {
  connectorSelectionBrowseResultSchema,
  connectorSelectionDescribeResultSchema,
  connectorSelectionSearchResultSchema,
  type ConnectorSelectionBrowseResult,
  type ConnectorSelectionDescribeResult,
  type ConnectorSelectionSearchResult,
} from "@sourceweft/contracts";
import { logger } from "../../shared/logger";
import { resolveCredential } from "./credential";
import { ConnectorError, isConnectorError } from "./errors";
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

/** The single, non-identifying message every rewritten selection failure
 * reaches the caller with. The web maps the error's code, not its message, so
 * the provider's own text never has to leave the server. */
const SELECTION_REQUEST_FAILED_MESSAGE = "Connector selection request failed";

/** An adapter/package connector error carries a numeric `statusCode` and a
 * string `code` but is not the platform's own `ConnectorError` class. */
function isAdapterConnectorError(
  error: unknown,
): error is { statusCode: number; code: string; details?: unknown } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as Record<string, unknown>).statusCode === "number" &&
    typeof (error as Record<string, unknown>).code === "string"
  );
}

/** The only adapter-error detail safe to forward: a finite retry hint. Anything
 * else (raw provider bodies, free text) is dropped. */
function retryAfterDetails(
  details: unknown,
): { retryAfterSeconds: number } | undefined {
  if (isPlainObject(details)) {
    const value = details.retryAfterSeconds;
    if (typeof value === "number" && Number.isFinite(value)) {
      return { retryAfterSeconds: value };
    }
  }
  return undefined;
}

/**
 * The error boundary for the adapter call and runtime-token retrieval. Platform
 * errors (this module's own, and the OAuth service's reauth/account errors)
 * keep their status, code and message — they carry no provider text and the web
 * maps selected platform codes. An adapter/package error keeps the status and
 * code the web maps on, but its message and details are replaced so provider
 * text never reaches the browser or the API error log. Anything else becomes a
 * generic 502. The two rewritten cases log one `warn` line and nothing else.
 */
function toSelectionBoundaryError(
  error: unknown,
  context: { connectorType: string; action: ConnectorSelectionActionName },
): ConnectorError {
  if (isConnectorError(error)) {
    return error;
  }
  if (isAdapterConnectorError(error)) {
    logger.warn("connector_selection_action_failed", {
      connectorType: context.connectorType,
      action: context.action,
      code: error.code,
      statusCode: error.statusCode,
    });
    return new ConnectorError(
      error.statusCode,
      error.code,
      SELECTION_REQUEST_FAILED_MESSAGE,
      retryAfterDetails(error.details),
    );
  }
  logger.warn("connector_selection_action_failed", {
    connectorType: context.connectorType,
    action: context.action,
    code: "CONNECTOR_SELECTION_FAILED",
    statusCode: 502,
  });
  return new ConnectorError(
    502,
    "CONNECTOR_SELECTION_FAILED",
    SELECTION_REQUEST_FAILED_MESSAGE,
  );
}

/**
 * After schema validation, checks every selectable entry (browse/search) and
 * every describe item with a non-null kind against the manifest's declared
 * `selection.kinds`. A non-selectable entry or the container may carry other
 * kinds (an account, a site), so those are not checked. Returns the paths and
 * code of any offenders, for the invalid-result log (paths and codes only).
 */
function collectUnlistedKindIssues(
  action: ConnectorSelectionActionName,
  data:
    | ConnectorSelectionBrowseResult
    | ConnectorSelectionSearchResult
    | ConnectorSelectionDescribeResult,
  kinds: readonly string[],
): Array<{ path: (string | number)[]; code: string }> {
  const allowed = new Set(kinds);
  const issues: Array<{ path: (string | number)[]; code: string }> = [];
  if (action === "describe") {
    (data as ConnectorSelectionDescribeResult).items.forEach((item, index) => {
      if (item.kind !== null && !allowed.has(item.kind)) {
        issues.push({ path: ["items", index, "kind"], code: "unlisted_kind" });
      }
    });
  } else {
    (
      data as ConnectorSelectionBrowseResult | ConnectorSelectionSearchResult
    ).entries.forEach((entry, index) => {
      if (entry.selectable && !allowed.has(entry.kind)) {
        issues.push({
          path: ["entries", index, "kind"],
          code: "unlisted_kind",
        });
      }
    });
  }
  return issues;
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
  const selection = manifest.selection;
  const actionType = selection?.actions[action];
  if (!actionType || !selection) {
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

  const errorContext = {
    connectorType: connector.connectorType,
    action,
  } as const;

  // Token retrieval is a boundary too: a platform OAuth error (reauth/account)
  // keeps its own status, code and message, but any other failure is rewritten
  // so provider text never escapes.
  let accessToken: string;
  try {
    accessToken = await resolveCredential(deps, {
      teamId,
      workspaceId,
      connector,
    });
  } catch (error: unknown) {
    throw toSelectionBoundaryError(error, errorContext);
  }

  const adapter = deps.getAdapter(connector.connectorType);
  // The adapter validates `request` and talks to the provider here. Its errors
  // are the capability package's own class: keep the status and code the web
  // maps on, but replace the message and strip details so a provider's own
  // error text never reaches the browser or the API error log.
  let actionResult;
  try {
    actionResult = await adapter.executeAction({
      teamId,
      workspaceId,
      connectorId: connector.id,
      connectorType: connector.connectorType,
      actionType,
      request,
      config: connector.configJson,
      accessToken,
      idempotencyKey: actionType,
    });
  } catch (error: unknown) {
    throw toSelectionBoundaryError(error, errorContext);
  }

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

  // A result can be schema-valid yet offer a selectable entry (or a describe
  // item) of a kind the manifest never declared; the web would let it be saved
  // and then hide it. Reject such a result the same way (paths and codes only).
  const unlistedKindIssues = collectUnlistedKindIssues(
    action,
    parsed.data,
    selection.kinds,
  );
  if (unlistedKindIssues.length > 0) {
    logger.warn("connector_selection_invalid_result", {
      connectorType: connector.connectorType,
      action,
      issues: unlistedKindIssues,
    });
    throw new ConnectorError(
      502,
      "CONNECTOR_SELECTION_INVALID_RESULT",
      "Connector returned an invalid selection result",
    );
  }

  return parsed.data;
}
