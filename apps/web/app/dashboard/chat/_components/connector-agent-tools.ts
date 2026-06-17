import type { SourceConnector } from "@sourceweft/sdk";

export type ActiveConnectorToolState = {
  /** @deprecated Use {@link activeConnectorIds} instead. */
  notionConnectorId: string | null;
  /** Map of connector type to active connector id (or null if none active). */
  activeConnectorIds: Record<string, string | null>;
};

export const EMPTY_ACTIVE_CONNECTOR_TOOLS: ActiveConnectorToolState = {
  notionConnectorId: null,
  activeConnectorIds: {},
};

export function resolveActiveConnectorToolState(
  connectors: SourceConnector[],
): ActiveConnectorToolState {
  const activeConnectorIds: Record<string, string | null> = {};
  let notionConnectorId: string | null = null;

  for (const connector of connectors) {
    if (connector.status !== "active") {
      continue;
    }
    activeConnectorIds[connector.connectorType] = connector.id;
    if (connector.connectorType === "notion") {
      notionConnectorId = connector.id;
    }
  }

  return {
    notionConnectorId,
    activeConnectorIds,
  };
}
