import {
  ConnectorError,
  connectorActionRunner,
  connectorRegistry,
} from "../connectors";
import { mcpService } from "../mcp";
import {
  findActionRunRecordById,
  findSourceConnectorRecord,
} from "../connectors/repository";
import { requireConnectorWorkspace } from "../connectors/permissions";
import { connectorActionApprovalPayload } from "../connectors/agent-tool-payload";
import type { ConnectorActionRunRecord } from "../connectors/types";
import type {
  ToolApprovalResume,
  ToolApprovalResumeDecision,
  ToolConfirmationRequest,
} from "@sourceweft/contracts";

function resumeDecisionFromSandboxInput(input: {
  confirmation?: ToolConfirmationRequest;
  decision: "approve" | "reject";
  editedArgs?: Record<string, unknown>;
  note?: string;
}): ToolApprovalResumeDecision {
  if (input.decision === "reject") {
    return {
      type: "reject",
      message: input.note ?? "User rejected the sandbox action in SourceWeft.",
    };
  }
  if (input.editedArgs && input.confirmation?.action.toolName) {
    return {
      type: "edit",
      editedAction: {
        name: input.confirmation.action.toolName,
        args: input.editedArgs,
      },
    };
  }
  return { type: "approve" };
}

function resolvedConfirmationStatus(decision: "approve" | "reject") {
  return decision === "reject" ? "rejected" : "approved";
}

function connectorTargetFromConfirmation(
  confirmation?: ToolConfirmationRequest,
) {
  const target = confirmation?.preview.target;
  if (!target) {
    return undefined;
  }
  return {
    externalUri: target.externalUri ?? null,
    id: target.id ?? null,
    label: target.label,
    type: target.type,
  };
}

function assertConnectorExecutor(
  confirmationId: string,
  confirmation?: ToolConfirmationRequest,
) {
  const executor = confirmation?.execution.executor;
  if (
    !executor ||
    executor.kind !== "connector_action_run" ||
    !("connectorId" in executor) ||
    !("actionRunId" in executor)
  ) {
    return {
      connectorId: undefined,
      actionRunId: confirmationId,
    };
  }
  return {
    connectorId: executor.connectorId,
    actionRunId: executor.actionRunId,
  };
}

function resumeDecisionFromInput(input: {
  action: ConnectorActionRunRecord;
  decision: "approve" | "reject";
  note?: string;
}): ToolApprovalResumeDecision {
  if (input.decision === "reject") {
    return {
      type: "reject",
      message: input.note ?? "User rejected the action in SourceWeft.",
    };
  }
  return { type: "approve" };
}

function hitlInterruptIdFromConfirmation(
  confirmation?: ToolConfirmationRequest,
) {
  return confirmation?.execution.sourceweft?.hitlInterruptId;
}

function sandboxExecuteToolCallIdFromConfirmation(
  confirmation?: ToolConfirmationRequest,
) {
  return confirmation?.execution.sourceweft?.sandboxExecuteToolCallId;
}

function sandboxActionRequestJsonFromConfirmation(
  confirmation?: ToolConfirmationRequest,
) {
  return (
    confirmation?.execution.sourceweft?.requestJson ??
    confirmation?.execution.sourceweft?.hitlActionRequestJson ??
    confirmation?.preview.requestJson
  );
}

function sandboxActionRefFromConfirmation(input: {
  confirmationId: string;
  confirmation?: ToolConfirmationRequest;
  requestJson?: Record<string, unknown>;
}):
  | NonNullable<
      NonNullable<ToolApprovalResume["sourceweft"]>["sandboxActions"]
    >[number]
  | null {
  const { confirmation } = input;
  const toolName =
    confirmation?.execution.sourceweft?.toolName ??
    confirmation?.execution.sourceweft?.hitlActionToolName ??
    confirmation?.action.toolName;
  const toolCallId =
    confirmation?.execution.sourceweft?.sandboxExecuteToolCallId ??
    confirmation?.execution.sourceweft?.toolCallId ??
    confirmation?.id;
  const requestJson =
    input.requestJson ?? sandboxActionRequestJsonFromConfirmation(confirmation);
  if (!toolName || !toolCallId || !requestJson) {
    return null;
  }
  return {
    toolName,
    toolCallId,
    requestJson,
    confirmationId: input.confirmationId,
    ...(confirmation?.execution.sourceweft?.hitlInterruptId
      ? { hitlInterruptId: confirmation.execution.sourceweft.hitlInterruptId }
      : {}),
    ...(confirmation?.execution.sourceweft?.sourceUserMessageId
      ? {
          sourceUserMessageId:
            confirmation.execution.sourceweft.sourceUserMessageId,
        }
      : {}),
    ...(confirmation?.execution.sourceweft?.sourceAssistantMessageId
      ? {
          sourceAssistantMessageId:
            confirmation.execution.sourceweft.sourceAssistantMessageId,
        }
      : {}),
  };
}

function withHitlInterruptResumeMetadata(input: {
  confirmation?: ToolConfirmationRequest;
  resume: ToolApprovalResume;
}): ToolApprovalResume {
  const hitlInterruptId = hitlInterruptIdFromConfirmation(input.confirmation);
  if (!hitlInterruptId || input.resume.sourceweft?.hitlInterruptId) {
    return input.resume;
  }
  return {
    ...input.resume,
    sourceweft: {
      ...(input.resume.sourceweft ?? {}),
      hitlInterruptId,
    },
  };
}

function connectorActionMetadata(action: ConnectorActionRunRecord) {
  const manifest = connectorRegistry
    .listManifests()
    .find((candidate) => candidate.type === action.connectorType);
  const actionSpec = manifest?.actions.find(
    (candidate) => candidate.type === action.actionType,
  );
  return {
    ...(actionSpec?.description ? { description: actionSpec.description } : {}),
    ...(actionSpec?.displayName ? { displayName: actionSpec.displayName } : {}),
  };
}

export class ToolConfirmationRunner {
  async respond(input: {
    workspaceId: string;
    userId: string;
    confirmationId: string;
    confirmation?: ToolConfirmationRequest;
    decision: "approve" | "reject";
    editedArgs?: Record<string, unknown>;
    note?: string;
  }) {
    if (input.confirmation?.domain === "sandbox") {
      const sandboxExecuteToolCallId =
        input.decision === "approve"
          ? sandboxExecuteToolCallIdFromConfirmation(input.confirmation)
          : undefined;
      const sandboxAction =
        input.decision === "approve"
          ? sandboxActionRefFromConfirmation({
              confirmationId: input.confirmationId,
              confirmation: input.confirmation,
              requestJson: input.editedArgs,
            })
          : null;
      const resume: ToolApprovalResume = {
        decisions: [
          resumeDecisionFromSandboxInput({
            confirmation: input.confirmation,
            decision: input.decision,
            editedArgs: input.editedArgs,
            note: input.note,
          }),
        ],
        ...(hitlInterruptIdFromConfirmation(input.confirmation) ||
        sandboxExecuteToolCallId ||
        sandboxAction
          ? {
              sourceweft: {
                confirmationId: input.confirmationId,
                ...(input.confirmation.execution.sourceweft?.sourceUserMessageId
                  ? {
                      sourceUserMessageId:
                        input.confirmation.execution.sourceweft
                          .sourceUserMessageId,
                    }
                  : {}),
                ...(input.confirmation.execution.sourceweft
                  ?.sourceAssistantMessageId
                  ? {
                      sourceAssistantMessageId:
                        input.confirmation.execution.sourceweft
                          .sourceAssistantMessageId,
                    }
                  : {}),
                ...(hitlInterruptIdFromConfirmation(input.confirmation)
                  ? {
                      hitlInterruptId: hitlInterruptIdFromConfirmation(
                        input.confirmation,
                      ),
                    }
                  : {}),
                ...(sandboxExecuteToolCallId
                  ? {
                      sandboxExecuteToolCallId,
                    }
                  : {}),
                ...(sandboxAction ? { sandboxActions: [sandboxAction] } : {}),
              },
            }
          : {}),
      };
      const status = resolvedConfirmationStatus(input.decision);
      return {
        confirmation: {
          ...input.confirmation,
          action: {
            ...input.confirmation.action,
            status,
          },
          status,
        },
        resume,
      };
    }

    if (
      input.confirmation?.domain === "mcp" ||
      input.confirmation?.execution.executor.kind === "mcp_action_run"
    ) {
      const result = await mcpService.respondToApproval({
        workspaceId: input.workspaceId,
        userId: input.userId,
        confirmationId: input.confirmationId,
        confirmation: input.confirmation,
        decision: input.decision,
        editedArgs: input.editedArgs,
        note: input.note,
      });
      return {
        ...result,
        resume: withHitlInterruptResumeMetadata({
          confirmation: input.confirmation,
          resume: result.resume,
        }),
      };
    }

    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.action.approve",
    });
    const executor = assertConnectorExecutor(
      input.confirmationId,
      input.confirmation,
    );
    const action = executor.connectorId
      ? await connectorActionRunner.get({
          workspaceId: input.workspaceId,
          userId: input.userId,
          connectorId: executor.connectorId,
          actionRunId: executor.actionRunId,
        })
      : {
          action: await findActionRunRecordById({
            teamId: workspace.organizationId,
            workspaceId: workspace.id,
            actionRunId: executor.actionRunId,
          }),
        };
    if (!action.action) {
      throw new ConnectorError(
        404,
        "CONFIRMATION_NOT_FOUND",
        "Confirmation request not found",
      );
    }

    const connector = await findSourceConnectorRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      connectorId: action.action.connectorId,
    });
    if (!connector) {
      throw new ConnectorError(
        404,
        "CONNECTOR_NOT_FOUND",
        "Connector not found",
      );
    }

    if (input.decision === "reject") {
      const rejected = await connectorActionRunner.reject({
        workspaceId: input.workspaceId,
        userId: input.userId,
        connectorId: connector.id,
        actionRunId: action.action.id,
      });
      const resume: ToolApprovalResume = {
        decisions: [
          resumeDecisionFromInput({
            action: rejected.action,
            decision: input.decision,
            note: input.note,
          }),
        ],
        ...(hitlInterruptIdFromConfirmation(input.confirmation)
          ? {
              sourceweft: {
                hitlInterruptId: hitlInterruptIdFromConfirmation(
                  input.confirmation,
                ),
              },
            }
          : {}),
      };
      return {
        confirmation: connectorActionApprovalPayload({
          action: rejected.action,
          agentToolName: input.confirmation?.action.toolName,
          connector,
          ...connectorActionMetadata(rejected.action),
          target: connectorTargetFromConfirmation(input.confirmation),
        }),
        resume,
      };
    }

    const approved = await connectorActionRunner.approve({
      workspaceId: input.workspaceId,
      userId: input.userId,
      connectorId: connector.id,
      actionRunId: action.action.id,
    });
    const resume: ToolApprovalResume = {
      decisions: [
        resumeDecisionFromInput({
          action: approved.action,
          decision: input.decision,
          note: input.note,
        }),
      ],
      sourceweft: {
        ...(hitlInterruptIdFromConfirmation(input.confirmation)
          ? {
              hitlInterruptId: hitlInterruptIdFromConfirmation(
                input.confirmation,
              ),
            }
          : {}),
        connectorActions: [
          {
            actionRunId: approved.action.id,
            connectorId: connector.id,
            requestJson: approved.action.requestJson,
            toolName:
              approved.action.agentToolName ??
              input.confirmation?.action.toolName ??
              approved.action.actionType,
          },
        ],
      },
    };

    return {
      confirmation: connectorActionApprovalPayload({
        action: approved.action,
        agentToolName: input.confirmation?.action.toolName,
        connector,
        ...connectorActionMetadata(approved.action),
        target: connectorTargetFromConfirmation(input.confirmation),
      }),
      resume,
    };
  }
}

export const toolConfirmationRunner = new ToolConfirmationRunner();
