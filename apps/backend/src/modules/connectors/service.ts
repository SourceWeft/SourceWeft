import { ConnectorError } from "./errors";
import { validateObjectWithJsonSchema } from "./config-validation";
import { requireConnectorWorkspace } from "./permissions";
import {
  createSourceConnectorRecord,
  findOAuthAccountRecord,
  findSourceConnectorRecord,
  listOAuthAccountRecords,
  listSourceConnectorRecords,
  updateSourceConnectorRecord,
} from "./repository";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import type { ConnectorStatus } from "./types";

function resolveNextScheduledAt(input: {
  enabled: boolean;
  frequencyMinutes: number | null;
}) {
  if (!input.enabled || !input.frequencyMinutes) {
    return null;
  }
  return new Date(Date.now() + input.frequencyMinutes * 60_000);
}

export class ConnectorService {
  constructor(private readonly registry: ConnectorRegistry = connectorRegistry) {}

  listManifests() {
    return { items: this.registry.listManifests() };
  }

  async listAccounts(input: {
    workspaceId: string;
    userId: string;
    connectorType?: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const items = await listOAuthAccountRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorType: input.connectorType,
    });
    return { items };
  }

  async createConnector(input: {
    workspaceId: string;
    userId: string;
    connectorType: string;
    name: string;
    oauthAccountId?: string | null;
    configJson?: Record<string, unknown>;
    periodicIndexingEnabled?: boolean;
    indexingFrequencyMinutes?: number | null;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const manifest = this.registry.getManifest(input.connectorType);
    const configJson = input.configJson ?? {};
    validateObjectWithJsonSchema({
      schema: manifest.configSchema,
      value: configJson,
      label: "configJson",
    });

    if (input.oauthAccountId) {
      const account = await findOAuthAccountRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        accountId: input.oauthAccountId,
      });
      if (!account || account.connectorType !== input.connectorType) {
        throw new ConnectorError(
          400,
          "CONNECTOR_OAUTH_ACCOUNT_INVALID",
          "OAuth account does not belong to this connector type",
        );
      }
    }

    const frequency =
      input.indexingFrequencyMinutes ?? manifest.sync.defaultFrequencyMinutes;
    const periodicIndexingEnabled = input.periodicIndexingEnabled ?? false;
    const connector = await createSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorType: input.connectorType,
      name: input.name,
      configJson,
      oauthAccountId: input.oauthAccountId ?? null,
      periodicIndexingEnabled,
      indexingFrequencyMinutes: periodicIndexingEnabled ? frequency : null,
      nextScheduledAt: resolveNextScheduledAt({
        enabled: periodicIndexingEnabled,
        frequencyMinutes: frequency,
      }),
      createdBy: input.userId,
    });

    return { connector };
  }

  async listConnectors(input: { workspaceId: string; userId: string }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const items = await listSourceConnectorRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
    });
    return { items };
  }

  async updateConnector(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    name?: string;
    configJson?: Record<string, unknown>;
    status?: Extract<ConnectorStatus, "active" | "paused" | "disabled">;
    periodicIndexingEnabled?: boolean;
    indexingFrequencyMinutes?: number | null;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const current = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    if (!current) {
      throw new ConnectorError(404, "CONNECTOR_NOT_FOUND", "Connector not found");
    }

    const manifest = this.registry.getManifest(current.connectorType);
    const nextConfig = input.configJson ?? current.configJson;
    validateObjectWithJsonSchema({
      schema: manifest.configSchema,
      value: nextConfig,
      label: "configJson",
    });

    const periodicIndexingEnabled =
      input.periodicIndexingEnabled ?? current.periodicIndexingEnabled;
    const frequency =
      input.indexingFrequencyMinutes === undefined
        ? current.indexingFrequencyMinutes ?? manifest.sync.defaultFrequencyMinutes
        : input.indexingFrequencyMinutes;
    const connector = await updateSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      name: input.name,
      configJson: input.configJson,
      status: input.status,
      periodicIndexingEnabled,
      indexingFrequencyMinutes: periodicIndexingEnabled ? frequency : null,
      nextScheduledAt: resolveNextScheduledAt({
        enabled: periodicIndexingEnabled,
        frequencyMinutes: frequency,
      }),
      lastError: input.status === "active" ? null : undefined,
    });

    if (!connector) {
      throw new ConnectorError(404, "CONNECTOR_NOT_FOUND", "Connector not found");
    }
    return { connector };
  }

  async deleteConnector(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const connector = await updateSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      status: "disabled",
      periodicIndexingEnabled: false,
      nextScheduledAt: null,
    });
    return { deleted: Boolean(connector) };
  }
}
