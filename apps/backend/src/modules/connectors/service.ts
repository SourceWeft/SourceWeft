import { ConnectorError } from "./errors";
import { config } from "../../shared/config";
import { decryptSecret } from "../../shared/secrets";
import {
  normalizeConnectorConfigJson,
  validateObjectWithJsonSchema,
} from "./config-validation";
import { requireConnectorWorkspace } from "./permissions";
import {
  createSourceConnectorRecord,
  detachSourceConnectorOAuthAccount,
  disableAndDetachSourceConnectorsByOAuthAccount,
  findOAuthAccountRecord,
  findSourceConnectorRecord,
  listOAuthAccountRecords,
  listSourceConnectorRecords,
  listWorkspaceSourceConnectorRecordsByOAuthAccount,
  purgeConnectorIndexedContent,
  revokeOAuthAccountRecord,
  updateSourceConnectorRecord,
} from "./repository";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import type { ConnectorOAuthAccountSecretRecord, ConnectorStatus } from "./types";

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
    const configJson = normalizeConnectorConfigJson({
      connectorType: input.connectorType,
      value: input.configJson ?? {},
    }).value;
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
    if (periodicIndexingEnabled && manifest.sync.resources.length === 0) {
      throw new ConnectorError(
        400,
        "CONNECTOR_PERIODIC_SYNC_UNSUPPORTED",
        "This connector does not support periodic sync",
      );
    }
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
    const normalizedConfig = normalizeConnectorConfigJson({
      connectorType: current.connectorType,
      value: input.configJson ?? current.configJson,
    });
    const nextConfig = normalizedConfig.value;
    validateObjectWithJsonSchema({
      schema: manifest.configSchema,
      value: nextConfig,
      label: "configJson",
    });

    const periodicIndexingEnabled =
      input.periodicIndexingEnabled ?? current.periodicIndexingEnabled;
    if (periodicIndexingEnabled && manifest.sync.resources.length === 0) {
      throw new ConnectorError(
        400,
        "CONNECTOR_PERIODIC_SYNC_UNSUPPORTED",
        "This connector does not support periodic sync",
      );
    }
    const frequency =
      input.indexingFrequencyMinutes === undefined
        ? current.indexingFrequencyMinutes ?? manifest.sync.defaultFrequencyMinutes
        : input.indexingFrequencyMinutes;
    const connector = await updateSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      name: input.name,
      configJson: input.configJson === undefined && !normalizedConfig.changed
        ? undefined
        : nextConfig,
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

  async removeConnector(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    purgeIndexedContent?: boolean;
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

    const connector = await updateSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      name: `removed:${input.connectorId}`,
      status: "disabled",
      periodicIndexingEnabled: false,
      indexingFrequencyMinutes: null,
      nextScheduledAt: null,
      lastError: null,
    });
    if (!connector) {
      throw new ConnectorError(404, "CONNECTOR_NOT_FOUND", "Connector not found");
    }
    if (current.oauthAccountId) {
      await detachSourceConnectorOAuthAccount({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: input.connectorId,
      });
    }
    let purgeCounts = {
      sourcesDeleted: 0,
      documentsDeleted: 0,
    };
    if (input.purgeIndexedContent) {
      purgeCounts = await purgeConnectorIndexedContent({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: input.connectorId,
      });
    }
    return {
      deleted: true,
      connectorId: input.connectorId,
      indexedContentDeleted: Boolean(input.purgeIndexedContent),
      ...(input.purgeIndexedContent
        ? {
            sourcesDeleted: purgeCounts.sourcesDeleted,
            documentsDeleted: purgeCounts.documentsDeleted,
          }
        : {}),
    };
  }

  async deleteConnector(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    purgeIndexedContent?: boolean;
  }) {
    return this.removeConnector(input);
  }

  async deleteOAuthAccount(input: {
    workspaceId: string;
    userId: string;
    accountId: string;
    force?: boolean;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.manage",
    });
    const account = await findOAuthAccountRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      accountId: input.accountId,
    });
    if (!account) {
      throw new ConnectorError(
        404,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
        "Connector OAuth account not found",
      );
    }

    const referencingConnectors =
      await listWorkspaceSourceConnectorRecordsByOAuthAccount({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        oauthAccountId: input.accountId,
      });
    if (referencingConnectors.length > 0 && !input.force) {
      throw new ConnectorError(
        409,
        "CONNECTOR_OAUTH_ACCOUNT_IN_USE",
        "Connector OAuth account is still used by active connectors",
        { connectorIds: referencingConnectors.map((connector) => connector.id) },
      );
    }

    const detachedConnectorIds = input.force
      ? await disableAndDetachSourceConnectorsByOAuthAccount({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          oauthAccountId: input.accountId,
        })
      : [];
    const providerRevokeWarning = await this.revokeProviderAccount(account);
    const revoked = await revokeOAuthAccountRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      accountId: input.accountId,
      lastError: providerRevokeWarning,
    });
    if (!revoked) {
      throw new ConnectorError(
        404,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
        "Connector OAuth account not found",
      );
    }

    return {
      deleted: true,
      accountId: input.accountId,
      accountStatus: revoked.status,
      detachedConnectorIds,
      providerRevokeWarning,
    };
  }

  private async revokeProviderAccount(
    account: ConnectorOAuthAccountSecretRecord,
  ) {
    try {
      const adapter = this.registry.getAdapter(account.connectorType);
      if (!adapter.revokeOAuthAccount) {
        return null;
      }
      await adapter.revokeOAuthAccount({
        accessToken: decryptSecret(
          account.accessTokenEncrypted,
          config.modelGatewayEncryptionSecret,
        ),
        refreshToken: account.refreshTokenEncrypted
          ? decryptSecret(
              account.refreshTokenEncrypted,
              config.modelGatewayEncryptionSecret,
            )
          : null,
        account,
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
