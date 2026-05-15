import { ConnectorError } from "./errors";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

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
