import { createHash } from "node:crypto";
import { ConnectorError, toConnectorError } from "./errors";
import { requireConnectorWorkspace } from "./permissions";
import {
  createActionRunRecord,
  findActionRunRecord,
  findSourceConnectorRecord,
  listActionRunRecords,
  updateActionRunRecord,
} from "./repository";
import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import { buildRequestPreview, redactConnectorSecrets } from "./security";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildActionIdempotencyKey(input: {
  connectorId: string;
  actionType: string;
  request: Record<string, unknown>;
}) {
  const hash = createHash("sha256")
    .update(stableStringify(input.request))
    .digest("hex");
  return `connector-action:${input.connectorId}:${input.actionType}:${hash}`;
}

export class ConnectorActionRunner {
  constructor(
    private readonly registry: ConnectorRegistry = connectorRegistry,
    private readonly oauthService = new ConnectorOAuthService(registry),
  ) {}

  async propose(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    actionType: string;
    requestJson: Record<string, unknown>;
    requestPreview?: string;
    idempotencyKey?: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.action.propose",
    });
    const connector = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    if (!connector || connector.status === "disabled") {
      throw new ConnectorError(404, "CONNECTOR_NOT_FOUND", "Connector not found");
    }
    const manifest = this.registry.getManifest(connector.connectorType);
    const actionSpec = manifest.actions.find(
      (candidate) => candidate.type === input.actionType,
    );
    if (!actionSpec) {
      throw new ConnectorError(
        400,
        "CONNECTOR_ACTION_NOT_SUPPORTED",
        "Connector action is not supported",
      );
    }

    const redactedRequest = redactConnectorSecrets(
      input.requestJson,
    ) as Record<string, unknown>;
    const action = await createActionRunRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: connector.id,
      connectorType: connector.connectorType,
      actionType: input.actionType,
      riskLevel: actionSpec.riskLevel,
      status: "proposed",
      requestJson: redactedRequest,
      requestPreview:
        input.requestPreview ??
        buildRequestPreview({
          actionType: input.actionType,
          request: redactedRequest,
        }),
      idempotencyKey:
        input.idempotencyKey ??
        buildActionIdempotencyKey({
          connectorId: connector.id,
          actionType: input.actionType,
          request: redactedRequest,
        }),
    });

    return { action };
  }

  async approve(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    actionRunId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.action.approve",
    });
    const action = await findActionRunRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      actionRunId: input.actionRunId,
    });
    if (!action) {
      throw new ConnectorError(
        404,
        "CONNECTOR_ACTION_NOT_FOUND",
        "Connector action not found",
      );
    }
    if (action.status !== "proposed") {
      throw new ConnectorError(
        409,
        "CONNECTOR_ACTION_INVALID_STATE",
        "Only proposed actions can be approved",
      );
    }
    const updated = await updateActionRunRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      actionRunId: input.actionRunId,
      status: "approved",
      approvedBy: input.userId,
    });
    return { action: updated ?? action };
  }

  async reject(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    actionRunId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.action.approve",
    });
    const updated = await updateActionRunRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      actionRunId: input.actionRunId,
      status: "rejected",
      approvedBy: input.userId,
    });
    if (!updated) {
      throw new ConnectorError(
        404,
        "CONNECTOR_ACTION_NOT_FOUND",
        "Connector action not found",
      );
    }
    return { action: updated };
  }

  async execute(input: {
    teamId: string;
    workspaceId: string;
    connectorId: string;
    actionRunId: string;
    userId: string;
  }) {
    const action = await findActionRunRecord(input);
    if (!action) {
      throw new ConnectorError(
        404,
        "CONNECTOR_ACTION_NOT_FOUND",
        "Connector action not found",
      );
    }
    if (action.status !== "approved") {
      throw new ConnectorError(
        409,
        "CONNECTOR_ACTION_NOT_APPROVED",
        "Connector action must be approved before execution",
      );
    }
    const connector = await findSourceConnectorRecord(input);
    if (!connector || connector.status !== "active") {
      throw new ConnectorError(
        409,
        "CONNECTOR_NOT_ACTIVE",
        "Connector is not active",
      );
    }

    await updateActionRunRecord({
      ...input,
      status: "running",
      executedBy: input.userId,
    });

    try {
      const accessToken = await this.oauthService.getRuntimeToken({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        accountId: connector.oauthAccountId,
        connectorType: connector.connectorType,
      });
      const adapter = this.registry.getAdapter(connector.connectorType);
      const result = await adapter.executeAction({
        teamId: input.teamId,
        workspaceId: input.workspaceId,
        connectorId: connector.id,
        connectorType: connector.connectorType,
        actionType: action.actionType,
        request: action.requestJson,
        config: connector.configJson,
        accessToken,
        idempotencyKey: action.idempotencyKey,
      });
      const updated = await updateActionRunRecord({
        ...input,
        status: "succeeded",
        resultJson: redactConnectorSecrets(result.result) as Record<
          string,
          unknown
        >,
        externalId: result.externalId ?? null,
      });
      return { action: updated ?? action };
    } catch (error) {
      const connectorError = toConnectorError(error);
      const failed = await updateActionRunRecord({
        ...input,
        status: "failed",
        errorCode: connectorError.code,
        errorMessage: connectorError.message,
      });
      return { action: failed ?? action };
    }
  }

  async list(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const items = await listActionRunRecords({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    return { items };
  }
}
