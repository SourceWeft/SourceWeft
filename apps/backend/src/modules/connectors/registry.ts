import { ConnectorError } from "./errors";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

/**
 * The standard OAuth2 token calls belong to `oauth2` connectors only: both
 * are required there, and a `none` connector has no account to exchange or
 * refresh, so neither may be present. `brokered` connectors are unconstrained.
 */
function assertAdapterMatchesAuthKind(
  adapter: ConnectorAdapter,
  manifest: ConnectorManifest,
) {
  const kind = manifest.auth.kind;
  if (kind !== "oauth2" && kind !== "none") return;
  const methods = ["exchangeOAuthCode", "refreshOAuthToken"] as const;
  if (kind === "oauth2") {
    const missing = methods.filter(
      (name) => typeof adapter[name] !== "function",
    );
    if (missing.length > 0) {
      throw new ConnectorError(
        500,
        "CONNECTOR_MANIFEST_INVALID",
        `Connector '${manifest.type}' uses oauth2 auth but does not implement ${missing.join(" and ")}`,
      );
    }
    return;
  }
  const forbidden = methods.filter((name) => adapter[name] !== undefined);
  if (forbidden.length > 0) {
    throw new ConnectorError(
      500,
      "CONNECTOR_MANIFEST_INVALID",
      `Connector '${manifest.type}' uses auth kind 'none' but implements ${forbidden.join(" and ")}`,
    );
  }
}

export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();

  constructor(adapters: ConnectorAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: ConnectorAdapter) {
    const manifest = adapter.getManifest();
    if (!manifest.type.trim()) {
      throw new ConnectorError(
        500,
        "CONNECTOR_MANIFEST_INVALID",
        "Connector manifest type is required",
      );
    }
    assertAdapterMatchesAuthKind(adapter, manifest);
    this.adapters.set(manifest.type, adapter);
  }

  listManifests(): ConnectorManifest[] {
    return Array.from(this.adapters.values()).map((adapter) =>
      adapter.getManifest(),
    );
  }

  getAdapter(connectorType: string) {
    const adapter = this.adapters.get(connectorType);
    if (!adapter) {
      throw new ConnectorError(
        404,
        "CONNECTOR_ADAPTER_NOT_FOUND",
        `Connector adapter '${connectorType}' is not registered`,
      );
    }
    return adapter;
  }

  getManifest(connectorType: string) {
    return this.getAdapter(connectorType).getManifest();
  }
}

export const connectorRegistry = new ConnectorRegistry();
