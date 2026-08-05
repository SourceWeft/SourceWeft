import {
  ConnectorError,
  connectorActionRunner,
  connectorRegistry,
} from "../connectors";
import { mcpService } from "../mcp";
import {
  findActionRunRecordById,
  findSourceConnectorRecord,
  listAgentToolTrustRuleRecords,
  revokeAgentToolTrustRuleRecord,
} from "../connectors/repository";
import { requireConnectorWorkspace } from "../connectors/permissions";
import { connectorActionApprovalPayload } from "../connectors/agent-tool-payload";
import type { ConnectorActionRunRecord } from "../connectors/types";
import type {
  AgentToolTrustRule,
  RespondAgentConfirmationTrust,
  ToolApprovalResume,
  ToolApprovalResumeDecision,
  ToolConfirmationDecision,
  ToolConfirmationRequest,
} from "@sourceweft/contracts";
import {
  narrowAgentToolTrustScope,
  recordAgentToolTrustRule,
  resolveAgentToolTrustScope,
  type AgentToolTrustScope,
  type AgentToolTrustTenant,
} from "./trust-rules";
import { logger } from "../../shared/logger";

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
    confirmation?.execution.sourceweft?.toolCallId ?? confirmation?.id;
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

/**
 * Persists the standing approval behind an `approve_always` decision.
 *
 * Returns `undefined` — never throws — when the scope cannot be derived. A
 * confirmation whose scope the *gate* could not reproduce would produce a rule
 * that can never match, i.e. an entry in the user's "remembered approvals" list
 * that silently does nothing. Failing to remember is recoverable; claiming to
 * have remembered is not.
 */
async function recordTrustRuleForDecision(input: {
  confirmation?: ToolConfirmationRequest;
  confirmationId: string;
  decision: ToolConfirmationDecision;
  scope: AgentToolTrustScope | null;
  tenant: AgentToolTrustTenant;
  trust?: RespondAgentConfirmationTrust;
}): Promise<AgentToolTrustRule | undefined> {
  if (input.decision !== "approve_always") {
    return undefined;
  }
  if (!input.scope) {
    logger.warn(
      "approve_always decision could not be turned into a trust rule; approving once only",
      {
        workspaceId: input.tenant.workspaceId,
        userId: input.tenant.userId,
        confirmationId: input.confirmationId,
        toolName: input.confirmation?.action.toolName,
      },
    );
    return undefined;
  }
  return recordAgentToolTrustRule({
    scope: narrowAgentToolTrustScope({
      scope: input.scope,
      ...(input.trust?.scope ? { granularity: input.trust.scope } : {}),
      ...(input.confirmation ? { confirmation: input.confirmation } : {}),
    }),
    tenant: input.tenant,
    confirmationId: input.confirmationId,
    ...(typeof input.trust?.ttlSeconds === "number"
      ? { ttlSeconds: input.trust.ttlSeconds }
      : {}),
  });
}

export class ToolConfirmationRunner {
  /**
   * Trust-rule half of a sandbox `approve_always`.
   *
   * Membership and approval rights are resolved here rather than trusted from
   * the confirmation payload: the sandbox response path never otherwise touches
   * the workspace, so without this a session could mint a standing approval in
   * a workspace it merely knows the id of.
   */
  private async recordSandboxTrustRule(input: {
    confirmation: ToolConfirmationRequest;
    confirmationId: string;
    decision: ToolConfirmationDecision;
    trust?: RespondAgentConfirmationTrust;
    userId: string;
    workspaceId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.action.approve",
    });
    const tenant = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
    };
    return recordTrustRuleForDecision({
      confirmation: input.confirmation,
      confirmationId: input.confirmationId,
      decision: input.decision,
      // Resolved through the same helper the gate uses, so a rule can only be
      // written for a scope the gate is able to reproduce and match.
      scope: await resolveAgentToolTrustScope({
        args: {},
        context: tenant,
        toolName: input.confirmation.action.toolName,
      }),
      tenant,
      ...(input.trust ? { trust: input.trust } : {}),
    });
  }

  async respond(input: {
    workspaceId: string;
    userId: string;
    confirmationId: string;
    confirmation?: ToolConfirmationRequest;
    decision: ToolConfirmationDecision;
    editedArgs?: Record<string, unknown>;
    note?: string;
    trust?: RespondAgentConfirmationTrust;
  }) {
    // Everything downstream only distinguishes "run it" from "don't". The
    // remember-this half is handled separately so that adding the decision can
    // never change how the action itself executes.
    const decision = input.decision === "reject" ? "reject" : "approve";

    if (input.confirmation?.domain === "sandbox") {
      const sandboxAction =
        decision === "approve"
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
            decision: decision,
            editedArgs: input.editedArgs,
            note: input.note,
          }),
        ],
        ...(hitlInterruptIdFromConfirmation(input.confirmation) ||
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
                ...(sandboxAction ? { sandboxActions: [sandboxAction] } : {}),
              },
            }
          : {}),
      };
      const status = resolvedConfirmationStatus(decision);
      // Guarded on the decision so that plain approve/reject on a sandbox
      // action takes exactly the code path it took before trust rules existed —
      // no extra workspace lookup, no extra query, no new failure mode.
      const trustRule =
        input.decision === "approve_always"
          ? await this.recordSandboxTrustRule({
              confirmation: input.confirmation,
              confirmationId: input.confirmationId,
              decision: input.decision,
              userId: input.userId,
              workspaceId: input.workspaceId,
              ...(input.trust ? { trust: input.trust } : {}),
            })
          : undefined;
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
        ...(trustRule ? { trustRule } : {}),
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
        decision: decision,
        editedArgs: input.editedArgs,
        note: input.note,
      });
      // No trust rule is recorded for MCP approvals. The HITL gate has no way
      // to resolve an MCP tool's domain and risk level without contacting the
      // install, so a rule written here could never be matched — and an entry
      // in the user's remembered-approvals list that never fires is worse than
      // no entry at all. `approve_always` therefore degrades to `approve`.
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

    if (decision === "reject") {
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
            decision: decision,
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
          decision: decision,
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

    // Built from the action run and connector the server just loaded, not from
    // the client-supplied confirmation: the risk level and connector id are the
    // two things risk containment and cross-connector isolation rest on, so
    // they must come from the database row that is actually being approved.
    //
    // `agentToolName` is required because the gate looks rules up by the agent
    // tool name; an action run without one could never be matched, so we record
    // nothing rather than a dead rule.
    const connectorTrustScope: AgentToolTrustScope | null = approved.action
      .agentToolName
      ? {
          domain: "connector",
          toolName: approved.action.agentToolName,
          connectorId: connector.id,
          targetType: null,
          targetId: null,
          riskLevel: approved.action.riskLevel,
        }
      : null;
    const trustRule = await recordTrustRuleForDecision({
      ...(input.confirmation ? { confirmation: input.confirmation } : {}),
      confirmationId: input.confirmationId,
      decision: input.decision,
      scope: connectorTrustScope,
      tenant: {
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
      },
      ...(input.trust ? { trust: input.trust } : {}),
    });

    return {
      confirmation: connectorActionApprovalPayload({
        action: approved.action,
        agentToolName: input.confirmation?.action.toolName,
        connector,
        ...connectorActionMetadata(approved.action),
        target: connectorTargetFromConfirmation(input.confirmation),
      }),
      resume,
      ...(trustRule ? { trustRule } : {}),
    };
  }

  /**
   * Lists the caller's own standing approvals in a workspace.
   *
   * Guarded by `connector.read` rather than `connector.action.approve`: a
   * member whose approval rights were removed must still be able to see — and
   * revoke — the grants they left behind.
   */
  async listTrustRules(input: { workspaceId: string; userId: string }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    return {
      rules: await listAgentToolTrustRuleRecords({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
      }),
    };
  }

  /**
   * Revokes one of the caller's standing approvals. Revocation is a
   * de-escalation, so it deliberately requires only read access; the repository
   * scopes the update by team, workspace and user, which is what stops a known
   * rule id from being revoked out of another tenant.
   */
  async revokeTrustRule(input: {
    workspaceId: string;
    userId: string;
    trustRuleId: string;
  }) {
    const { workspace } = await requireConnectorWorkspace({
      workspaceId: input.workspaceId,
      userId: input.userId,
      permission: "connector.read",
    });
    const rule = await revokeAgentToolTrustRuleRecord({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      userId: input.userId,
      trustRuleId: input.trustRuleId,
    });
    if (!rule) {
      throw new ConnectorError(
        404,
        "AGENT_TOOL_TRUST_RULE_NOT_FOUND",
        "Trust rule not found",
      );
    }
    logger.info("Agent tool trust rule revoked", {
      workspaceId: workspace.id,
      userId: input.userId,
      trustRuleId: rule.id,
    });
    return { rule };
  }
}

export const toolConfirmationRunner = new ToolConfirmationRunner();
