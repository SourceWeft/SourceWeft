import type { ConnectorSyncReadinessResult } from "./types";

/**
 * Platform-owned key a not-ready sync writes into a connector's `configJson`
 * and the next ready sync removes. It is never part of the user's
 * configuration, so anything that compares configurations must ignore it.
 */
export const SYNC_READINESS_CONFIG_KEY = "syncReadiness";

export function withSyncReadinessMetadata(
  configJson: Record<string, unknown>,
  readiness: ConnectorSyncReadinessResult,
) {
  return {
    ...configJson,
    [SYNC_READINESS_CONFIG_KEY]: {
      ready: false,
      reason: readiness.reason ?? "connector_not_ready",
      message: readiness.message ?? "Connector is not ready to sync.",
      checkedAt: new Date().toISOString(),
    },
  };
}

export function hasSyncReadinessMetadata(configJson: Record<string, unknown>) {
  return Object.prototype.hasOwnProperty.call(
    configJson,
    SYNC_READINESS_CONFIG_KEY,
  );
}

export function withoutSyncReadinessMetadata(
  configJson: Record<string, unknown>,
) {
  if (!hasSyncReadinessMetadata(configJson)) {
    return configJson;
  }
  const { [SYNC_READINESS_CONFIG_KEY]: _syncReadiness, ...rest } = configJson;
  return rest;
}
