import { ConnectorError } from "./errors";
import { validateObjectWithJsonSchema } from "./config-validation";
import { requireConnectorWorkspace } from "./permissions";
import {
  createSourceConnectorRecord,
  deleteOAuthAccountRecord,
  findOAuthAccountRecord,
  findSourceConnectorRecord,
  findSourceConnectorRecordByName,
  hardDeleteSourceConnectorRecord,
  hasOtherSourceConnectorOAuthAccountReferences,
  hasSourceConnectorOAuthAccountReferences,
  listOAuthAccountRecords,
  listSourceConnectorRecords,
  listWorkspaceSourceConnectorRecordsByOAuthAccount,
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
  constructor(
    private readonly registry: ConnectorRegistry = connectorRegistry,
  ) {}

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

    const existingConnector = await findSourceConnectorRecordByName({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorType: input.connectorType,
      name: input.name,
    });
    if (existingConnector) {
      if (existingConnector.status === "disabled") {
        throw new ConnectorError(
          409,
          "CONNECTOR_DISABLED_CONFLICT",
          "A disabled connector with this name already exists. Enable it or hard delete it before reconnecting.",
          { connectorId: existingConnector.id },
        );
      }
      throw new ConnectorError(
        409,
        "CONNECTOR_ALREADY_EXISTS",
        "A connector with this name already exists",
        { connectorId: existingConnector.id },
      );
    }

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
      if (account.status !== "active") {
        throw new ConnectorError(
          400,
          "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
          "OAuth account is not active",
        );
      }
      const accountInUse = await hasSourceConnectorOAuthAccountReferences({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        accountId: input.oauthAccountId,
      });
      if (accountInUse) {
        throw new ConnectorError(
          409,
          "CONNECTOR_OAUTH_ACCOUNT_IN_USE",
          "OAuth account is already attached to another connector",
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

  async listConnectors(input: {
    workspaceId: string;
    userId: string;
    includeDisabled?: boolean;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const items = await listSourceConnectorRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      includeDisabled: input.includeDisabled,
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
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
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
    if (periodicIndexingEnabled && manifest.sync.resources.length === 0) {
      throw new ConnectorError(
        400,
        "CONNECTOR_PERIODIC_SYNC_UNSUPPORTED",
        "This connector does not support periodic sync",
      );
    }
    const frequency =
      input.indexingFrequencyMinutes === undefined
        ? (current.indexingFrequencyMinutes ??
          manifest.sync.defaultFrequencyMinutes)
        : input.indexingFrequencyMinutes;
    const connector = await updateSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      name: input.name,
      configJson: input.configJson === undefined ? undefined : nextConfig,
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
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
    return { connector };
  }

  async deleteConnector(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    disable?: boolean;
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
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }

    if (input.disable) {
      const connector = await updateSourceConnectorRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: input.connectorId,
        status: "disabled",
        periodicIndexingEnabled: false,
        indexingFrequencyMinutes: null,
        nextScheduledAt: null,
        lastError: null,
      });
      if (!connector) {
        throw new ConnectorError(
          404,
          "CONNECTOR_NOT_FOUND",
          "Connector not found",
        );
      }
      return {
        disabled: true,
        hardDeleted: false,
        connectorId: input.connectorId,
      };
    }

    if (current.oauthAccountId) {
      const hasOtherReferences =
        await hasOtherSourceConnectorOAuthAccountReferences({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          accountId: current.oauthAccountId,
          connectorId: input.connectorId,
        });
      if (hasOtherReferences) {
        throw new ConnectorError(
          409,
          "CONNECTOR_OAUTH_ACCOUNT_IN_USE",
          "Connector OAuth account is attached to another connector",
        );
      }
    }

    const result = await hardDeleteSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      oauthAccountId: current.oauthAccountId,
    });
    if (!result.connectorDeleted) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }
    return {
      disabled: false,
      hardDeleted: true,
      connectorId: input.connectorId,
      indexedContentDeleted: true,
      sourcesDeleted: result.sourcesDeleted,
      documentsDeleted: result.documentsDeleted,
      authorizationDeleted: result.authorizationDeleted,
    };
  }

  async deleteOAuthAccount(input: {
    workspaceId: string;
    userId: string;
    accountId: string;
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
    if (referencingConnectors.length > 0) {
      throw new ConnectorError(
        409,
        "CONNECTOR_OAUTH_ACCOUNT_IN_USE",
        "Connector OAuth account is still attached to a connector",
        {
          connectorIds: referencingConnectors.map((connector) => connector.id),
        },
      );
    }

    const deleted = await deleteOAuthAccountRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      accountId: input.accountId,
    });
    if (!deleted) {
      throw new ConnectorError(
        404,
        "CONNECTOR_OAUTH_ACCOUNT_NOT_FOUND",
        "Connector OAuth account not found",
      );
    }

    return {
      deleted: true,
      accountId: input.accountId,
    };
  }
}
