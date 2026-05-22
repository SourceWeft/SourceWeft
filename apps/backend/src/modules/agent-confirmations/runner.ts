import {
  ConnectorError,
  connectorActionRunner,
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
    if (
      input.confirmation?.domain === "mcp" ||
      input.confirmation?.execution.executor.kind === "mcp_action_run"
    ) {
      return mcpService.respondToApproval({
        workspaceId: input.workspaceId,
        userId: input.userId,
        confirmationId: input.confirmationId,
        confirmation: input.confirmation,
        decision: input.decision,
        note: input.note,
      });
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
      throw new ConnectorError(404, "CONNECTOR_NOT_FOUND", "Connector not found");
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
      };
      return {
        confirmation: connectorActionApprovalPayload({
          action: rejected.action,
          agentToolName: input.confirmation?.action.toolName,
          connector,
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
        connectorActions: [
          {
            actionRunId: approved.action.id,
            connectorId: connector.id,
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
        target: connectorTargetFromConfirmation(input.confirmation),
      }),
      resume,
    };
  }
}

export const toolConfirmationRunner = new ToolConfirmationRunner();
