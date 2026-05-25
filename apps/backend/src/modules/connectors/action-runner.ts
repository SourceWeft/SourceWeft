import { createHash } from "node:crypto";
import { ConnectorError, toConnectorError } from "./errors";
import { validateObjectWithJsonSchema } from "./config-validation";
import { requireConnectorWorkspace } from "./permissions";
import {
  createActionRunRecord,
  createSyncRunRecord,
  findActionRunRecord,
  findSourceConnectorRecord,
  listActionRunRecords,
  updateActionRunRecord,
} from "./repository";
import { enqueueConnectorSyncJob } from "../content/queue";
import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorRegistry, connectorRegistry } from "./registry";
import { buildRequestPreview, redactConnectorSecrets } from "./security";
import { logger } from "../../shared/logger";
import { jsonValuesEqual, stableJsonStringify } from "./json-compare";

function buildActionIdempotencyKey(input: {
  connectorId: string;
  actionType: string;
  request: Record<string, unknown>;
}) {
  const hash = createHash("sha256")
    .update(stableJsonStringify(input.request))
    .digest("hex");
  return `connector-action:${input.connectorId}:${input.actionType}:${hash}`;
}

function nextActionProposalIdempotencyKey(input: {
  attempt: number;
  baseKey: string;
}) {
  return input.attempt === 0
    ? input.baseKey
    : `${input.baseKey}:proposal-${input.attempt + 1}`;
}

function isSameActionProposal(input: {
  action: {
    actionType: string;
    agentToolName?: string | null;
    requestJson: Record<string, unknown>;
  };
  actionType: string;
  agentToolName?: string | null;
  requestJson: Record<string, unknown>;
}) {
  return (
    input.action.actionType === input.actionType &&
    (input.action.agentToolName ?? null) === (input.agentToolName ?? null) &&
    jsonValuesEqual(input.action.requestJson, input.requestJson)
  );
}

function connectorActionExecutionMeta(input: {
  actionRunId: string;
  actionType?: string;
  agentToolName?: string | null;
  connectorId: string;
  connectorType?: string;
  teamId: string;
  userId?: string;
  workspaceId: string;
}) {
  return {
    actionRunId: input.actionRunId,
    actionType: input.actionType,
    agentToolName: input.agentToolName,
    connectorId: input.connectorId,
    connectorType: input.connectorType,
    teamId: input.teamId,
    userId: input.userId,
    workspaceId: input.workspaceId,
  };
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
    agentToolName?: string | null;
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
    validateObjectWithJsonSchema({
      schema: actionSpec.inputSchema,
      value: input.requestJson,
      label: "requestJson",
    });

    const redactedRequest = redactConnectorSecrets(
      input.requestJson,
    ) as Record<string, unknown>;
    const idempotencyKey =
      input.idempotencyKey ??
      buildActionIdempotencyKey({
        connectorId: connector.id,
        actionType: input.actionType,
        request: redactedRequest,
      });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const proposalIdempotencyKey = nextActionProposalIdempotencyKey({
        attempt,
        baseKey: idempotencyKey,
      });
      const existingAction = await findActionRunRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        idempotencyKey: proposalIdempotencyKey,
      });
      const agentToolName =
        input.agentToolName ?? actionSpec.agentToolName ?? null;
      if (
        existingAction?.status === "proposed" &&
        isSameActionProposal({
          action: existingAction,
          actionType: input.actionType,
          agentToolName,
          requestJson: redactedRequest,
        })
      ) {
        return { action: existingAction };
      }
      if (existingAction) {
        continue;
      }

      const action = await createActionRunRecord({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        connectorType: connector.connectorType,
        actionType: input.actionType,
        agentToolName,
        riskLevel: actionSpec.riskLevel,
        status: "proposed",
        requestJson: redactedRequest,
        requestPreview:
          input.requestPreview ??
          buildRequestPreview({
            actionType: input.actionType,
            request: redactedRequest,
          }),
        idempotencyKey: proposalIdempotencyKey,
      });
      if (action.status === "proposed") {
        return { action };
      }
    }

    throw new ConnectorError(
      409,
      "CONNECTOR_ACTION_PROPOSAL_CONFLICT",
      "Could not create a fresh connector action proposal for confirmation.",
    );
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
        "Only proposed actions can be rejected",
      );
    }
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

  async get(input: {
    workspaceId: string;
    userId: string;
    connectorId: string;
    actionRunId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
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
    return { action };
  }

  async execute(input: {
    workspaceId: string;
    connectorId: string;
    actionRunId: string;
    expected?: {
      actionType?: string;
      agentToolName?: string | null;
      requestJson?: Record<string, unknown>;
    };
    userId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.action.approve",
    });
    const lookup = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
      actionRunId: input.actionRunId,
    };
    logger.debug("Connector action execution requested", {
      actionRunId: input.actionRunId,
      connectorId: input.connectorId,
      teamId: workspace.organizationId,
      userId: input.userId,
      workspaceId: workspace.id,
    });
    const action = await findActionRunRecord(lookup);
    if (!action) {
      throw new ConnectorError(
        404,
        "CONNECTOR_ACTION_NOT_FOUND",
        "Connector action not found",
      );
    }
    if (
      input.expected?.actionType &&
      action.actionType !== input.expected.actionType
    ) {
      throw new ConnectorError(
        409,
        "CONNECTOR_ACTION_APPROVAL_MISMATCH",
        "Approved connector action type does not match the resumed tool call.",
      );
    }
    if (
      input.expected?.agentToolName !== undefined &&
      (action.agentToolName ?? null) !== (input.expected.agentToolName ?? null)
    ) {
      throw new ConnectorError(
        409,
        "CONNECTOR_ACTION_APPROVAL_MISMATCH",
        "Approved connector action tool does not match the resumed tool call.",
      );
    }
    if (
      input.expected?.requestJson &&
      !jsonValuesEqual(action.requestJson, input.expected.requestJson)
    ) {
      throw new ConnectorError(
        409,
        "CONNECTOR_ACTION_APPROVAL_MISMATCH",
        "Approved connector action arguments do not match the resumed tool call.",
      );
    }
    if (action.status === "succeeded" || action.status === "running") {
      logger.debug("Connector action execution skipped for terminal or running status", {
        ...connectorActionExecutionMeta({
          ...lookup,
          actionType: action.actionType,
          agentToolName: action.agentToolName,
          connectorType: action.connectorType,
          userId: input.userId,
        }),
        status: action.status,
      });
      return { action };
    }
    if (action.status !== "approved") {
      throw new ConnectorError(
        409,
        "CONNECTOR_ACTION_NOT_APPROVED",
        "Connector action must be approved before execution",
      );
    }
    const connector = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: input.connectorId,
    });
    if (!connector || connector.status !== "active") {
      throw new ConnectorError(
        409,
        "CONNECTOR_NOT_ACTIVE",
        "Connector is not active",
      );
    }

    await updateActionRunRecord({
      ...lookup,
      status: "running",
      executedBy: input.userId,
    });
    logger.debug("Connector action marked running", {
      ...connectorActionExecutionMeta({
        ...lookup,
        actionType: action.actionType,
        agentToolName: action.agentToolName,
        connectorType: connector.connectorType,
        userId: input.userId,
      }),
      status: "running",
    });

    const startedAt = Date.now();
    try {
      const accessToken = await this.oauthService.getRuntimeToken({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        accountId: connector.oauthAccountId,
        connectorType: connector.connectorType,
      });
      const adapter = this.registry.getAdapter(connector.connectorType);
      logger.debug("Connector action adapter execution started", {
        ...connectorActionExecutionMeta({
          ...lookup,
          actionType: action.actionType,
          agentToolName: action.agentToolName,
          connectorType: connector.connectorType,
          userId: input.userId,
        }),
        idempotencyKey: action.idempotencyKey,
      });
      const result = await adapter.executeAction({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        connectorId: connector.id,
        connectorType: connector.connectorType,
        actionType: action.actionType,
        request: action.requestJson,
        config: connector.configJson,
        accessToken,
        idempotencyKey: action.idempotencyKey,
      });
      const latencyMs = Date.now() - startedAt;
      logger.debug("Connector action adapter execution succeeded", {
        ...connectorActionExecutionMeta({
          ...lookup,
          actionType: action.actionType,
          agentToolName: action.agentToolName,
          connectorType: connector.connectorType,
          userId: input.userId,
        }),
        externalId: result.externalId ?? null,
        latencyMs,
        rawResponseJson: result.rawResponseJson,
        resultJson: result.result,
        shouldResync: Boolean(result.shouldResync),
      });
      let updated = await updateActionRunRecord({
        ...lookup,
        status: "succeeded",
        resultJson: redactConnectorSecrets(result.result) as Record<
          string,
          unknown
        >,
        externalId: result.externalId ?? null,
      });
      if (result.shouldResync) {
        const targetExternalIds = result.resyncExternalIds?.length
          ? result.resyncExternalIds
          : result.externalId
            ? [result.externalId]
            : [];
        const run = await createSyncRunRecord({
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          connectorId: connector.id,
          triggerType: "backfill",
          status: "queued",
          createdBy: input.userId,
          metadataJson: {
            reason: "connector_action",
            actionRunId: action.id,
            actionType: action.actionType,
            targetExternalIds,
          },
        });
        await enqueueConnectorSyncJob({
          runId: run.id,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          connectorId: connector.id,
          userId: input.userId,
          targetExternalIds,
        });
        logger.debug("Connector action post-action sync enqueued", {
          ...connectorActionExecutionMeta({
            ...lookup,
            actionType: action.actionType,
            agentToolName: action.agentToolName,
            connectorType: connector.connectorType,
            userId: input.userId,
          }),
          syncRunId: run.id,
          targetExternalIds,
        });
        updated = await updateActionRunRecord({
          ...lookup,
          resultJson: redactConnectorSecrets({
            ...result.result,
            postActionSyncRunId: run.id,
          }) as Record<string, unknown>,
        });
      }
      return { action: updated ?? action };
    } catch (error) {
      const connectorError = toConnectorError(error);
      logger.debug("Connector action adapter execution failed", {
        ...connectorActionExecutionMeta({
          ...lookup,
          actionType: action.actionType,
          agentToolName: action.agentToolName,
          connectorType: connector.connectorType,
          userId: input.userId,
        }),
        errorCode: connectorError.code,
        errorMessage: connectorError.message,
        latencyMs: Date.now() - startedAt,
        rawResponseJson: connectorError.details?.rawResponseJson,
      });
      const failed = await updateActionRunRecord({
        ...lookup,
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
