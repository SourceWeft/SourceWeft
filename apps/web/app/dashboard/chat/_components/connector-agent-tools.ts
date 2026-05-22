import type { SourceConnector } from "@sourceweft/sdk";

export type ActiveConnectorToolState = {
  notionConnectorId: string | null;
};

export const EMPTY_ACTIVE_CONNECTOR_TOOLS: ActiveConnectorToolState = {
  notionConnectorId: null,
};

export function resolveActiveConnectorToolState(
  connectors: SourceConnector[],
): ActiveConnectorToolState {
  const notionConnector =
    connectors.find(
      (connector) =>
        connector.connectorType === "notion" && connector.status === "active",
    ) ?? null;

  return {
    notionConnectorId: notionConnector?.id ?? null,
  };
}
