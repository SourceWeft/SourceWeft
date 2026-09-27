import { previewAccessService } from "../preview";
import { ConnectorError } from "./errors";
import { connectorRegistry, type ConnectorRegistry } from "./registry";

type ConnectorIdentity = { connectorType: string; createdBy?: string | null };

/** Preview eligibility only; callers retain their workspace and OAuth checks. */
export class ConnectorAccessPolicy {
  constructor(
    private readonly preview = previewAccessService,
    private readonly registry: ConnectorRegistry = connectorRegistry,
  ) {}

  async isAvailable(connectorType: string, userId: string) {
    if (connectorType !== "gmail") return true;
    return (
      this.registry.listManifests().some((item) => item.type === "gmail") &&
      this.preview.isEnabled(userId, "gmail")
    );
  }

  async requireAvailable(connectorType: string, userId: string) {
    if (connectorType !== "gmail") return;
    this.registry.getManifest(connectorType);
    if (!(await this.preview.isEnabled(userId, "gmail"))) {
      throw new ConnectorError(
        403,
        "CONNECTOR_PREVIEW_ACCESS_DENIED",
        "Gmail preview access is required",
      );
    }
  }

  async requireConnection(connector: ConnectorIdentity, userId?: string) {
    if (connector.connectorType !== "gmail") return;
    const actor = userId ?? connector.createdBy;
    if (!actor) {
      throw new ConnectorError(
        403,
        "CONNECTOR_PREVIEW_OWNER_REQUIRED",
        "Gmail background work requires an authorized owner",
      );
    }
    await this.requireAvailable(connector.connectorType, actor);
  }

  async filterAvailable<T extends ConnectorIdentity>(
    items: T[],
    userId: string,
  ): Promise<T[]> {
    if (!items.some((item) => item.connectorType === "gmail")) return items;
    const gmailAvailable = await this.isAvailable("gmail", userId);
    return items.filter(
      (item) => item.connectorType !== "gmail" || gmailAvailable,
    );
  }
}

export const connectorAccessPolicy = new ConnectorAccessPolicy();
