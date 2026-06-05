import { ConnectorError } from "./errors";
import { redactConnectorSecrets } from "./security";
import type { ToolConfirmationRequest } from "@sourceweft/contracts";
import type {
  ConnectorActionRiskLevel,
  ConnectorActionRunStatus,
  SourceConnectorRecord,
} from "./types";

type ConnectorActionPayloadInput = {
  action: {
    actionType: string;
    agentToolName?: string | null;
    id: string;
    idempotencyKey: string;
    requestJson: Record<string, unknown>;
    requestPreview: string;
    riskLevel: ConnectorActionRiskLevel;
    status: ConnectorActionRunStatus;
  };
  agentToolName?: string;
  description?: string;
  displayName?: string;
  connector: SourceConnectorRecord;
  toolCallId?: string;
  target?: {
    externalUri?: string | null;
    id?: string | null;
    label: string;
    type: string;
  };
};

export function chooseConnector(input: {
  connectorId?: string;
  connectorType: string;
  connectors: SourceConnectorRecord[];
}) {
  if (input.connectorId) {
    const connector = input.connectors.find(
      (candidate) => candidate.id === input.connectorId,
    );
    if (connector) {
      return connector;
    }
    throw new ConnectorError(
      404,
      "CONNECTOR_NOT_FOUND",
      `No active ${input.connectorType} connector matched connectorId '${input.connectorId}'.`,
    );
  }
  if (input.connectors.length === 1) {
    return input.connectors[0]!;
  }
  throw new ConnectorError(
    409,
    "CONNECTOR_SELECTION_REQUIRED",
    `Multiple active ${input.connectorType} connectors are available. Call this tool with connectorId.`,
  );
}

function formatActionLabel(actionType: string) {
  return (
    actionType
      .split(".")
      .at(-1)
      ?.replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase()) ?? actionType
  );
}

export function connectorActionApprovalPayload(
  input: ConnectorActionPayloadInput,
): ToolConfirmationRequest {
  const redactedRequest = redactConnectorSecrets(input.action.requestJson);
  const request =
    redactedRequest &&
    typeof redactedRequest === "object" &&
    !Array.isArray(redactedRequest)
      ? (redactedRequest as Record<string, unknown>)
      : {};
  const target = input.target
    ? {
        type: input.target.type,
        label: input.target.label,
        id: input.target.id ?? null,
        externalUri: input.target.externalUri ?? null,
      }
    : undefined;
  const decisionOptions = [
    {
      decision: "reject" as const,
      label: "Reject",
      description: "Do not run this action.",
    },
    {
      decision: "approve" as const,
      label: "Approve",
      description: "Run this action once.",
    },
  ];
  const providerStatus =
    input.action.status === "running"
      ? "running"
      : input.action.status === "succeeded"
        ? "succeeded"
        : input.action.status === "failed"
          ? "failed"
          : "not_executed";
  return {
    type: "tool_confirmation_request" as const,
    schemaVersion: 1 as const,
    id: input.action.id,
    domain: "connector" as const,
    subject: {
      label: input.connector.name,
      provider: input.connector.connectorType,
      connectorId: input.connector.id,
      externalUri: input.target?.externalUri ?? null,
    },
    action: {
      type: input.action.actionType,
      toolName:
        input.agentToolName ??
        input.action.agentToolName ??
        input.action.actionType,
      label: input.displayName ?? formatActionLabel(input.action.actionType),
      ...(input.description ? { description: input.description } : {}),
      riskLevel: input.action.riskLevel,
      status: input.action.status,
      requiresApproval: true as const,
    },
    preview: {
      title: input.action.requestPreview,
      summary: input.action.requestPreview,
      requestJson: request,
      ...(target ? { target } : {}),
    },
    decisionOptions,
    execution: {
      providerStatus,
      executor: {
        kind: "connector_action_run",
        connectorId: input.connector.id,
        actionRunId: input.action.id,
      },
      sourceweft: {
        toolCallId: input.toolCallId ?? input.action.idempotencyKey,
      },
    },
    status: input.action.status,
    userMessage:
      providerStatus === "succeeded"
          ? "This action finished successfully in SourceWeft."
          : "This action is waiting for confirmation in SourceWeft. The external provider action has not executed yet.",
  };
}
