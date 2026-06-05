import type {
  ToolApprovalResume,
  ToolApprovalResumeDecision,
  ToolConfirmationRequest,
} from "@sourceweft/contracts";
import type {
  ConnectorActionApprovalCursor,
  ConnectorActionExecutionCursor,
} from "../../../connectors/agent-tool-idempotency";
import { peekConnectorActionExecutionRef } from "../../../connectors/agent-tool-idempotency";
import { createConnectorActionApprovalRequest } from "../../../connectors/agent-tools";
import { mcpService } from "../../../mcp";
import { ContentError } from "../../errors";
import {
  getAgentToolDefinition,
  isSandboxToolName,
} from "../tool-registry";
import { toObjectRecord } from "./content";
import { parseToolArgs, sameToolArgs } from "./output-normalizer";
import type { ObservedAgentToolCall } from "./tool-tracker";

export type HitlActionRequest = {
  args: Record<string, unknown>;
  description?: string;
  name: string;
};

export type HitlReviewConfig = {
  actionName: string;
  allowedDecisions: Array<"approve" | "edit" | "reject">;
  argsSchema?: Record<string, unknown>;
};

export type HitlInterruptRequest = {
  id?: string;
  actionRequests: HitlActionRequest[];
  reviewConfigs: HitlReviewConfig[];
};

export function extractHitlInterrupts(payload: unknown) {
  const record = toObjectRecord(payload);
  const interrupts = record?.__interrupt__;
  if (!Array.isArray(interrupts)) {
    return [] as HitlInterruptRequest[];
  }
  return interrupts
    .map((interruptValue): HitlInterruptRequest | null => {
      const interruptRecord = toObjectRecord(interruptValue);
      const value = toObjectRecord(interruptRecord?.value);
      const id =
        typeof interruptRecord?.id === "string" &&
        interruptRecord.id.trim().length > 0
          ? interruptRecord.id.trim()
          : undefined;
      const actionRequestsValue = value?.actionRequests;
      const reviewConfigsValue = value?.reviewConfigs;
      if (
        !Array.isArray(actionRequestsValue) ||
        !Array.isArray(reviewConfigsValue)
      ) {
        return null;
      }
      const actionRequests = actionRequestsValue.map((candidate) => {
        const action = toObjectRecord(candidate);
        return {
          name: typeof action?.name === "string" ? action.name : "",
          args: parseToolArgs(action?.args),
          ...(typeof action?.description === "string"
            ? { description: action.description }
            : {}),
        };
      });
      const reviewConfigs = reviewConfigsValue.map((candidate) => {
        const config = toObjectRecord(candidate);
        const argsSchema = toObjectRecord(config?.argsSchema);
        const allowed = Array.isArray(config?.allowedDecisions)
          ? config.allowedDecisions.filter(
              (decision): decision is "approve" | "edit" | "reject" =>
                decision === "approve" ||
                decision === "edit" ||
                decision === "reject",
            )
          : [];
        return {
          actionName:
            typeof config?.actionName === "string" ? config.actionName : "",
          allowedDecisions: allowed,
          ...(argsSchema ? { argsSchema } : {}),
        };
      });
      if (
        actionRequests.some((request) => request.name.length === 0) ||
        reviewConfigs.some((config) => config.actionName.length === 0)
      ) {
        return null;
      }
      return { ...(id ? { id } : {}), actionRequests, reviewConfigs };
    })
    .filter(
      (interrupt): interrupt is HitlInterruptRequest => interrupt !== null,
    );
}

export function matchInterruptedToolCall(input: {
  action: HitlActionRequest;
  index: number;
  observedToolCalls: ObservedAgentToolCall[];
  usedToolCallIds: Set<string>;
}) {
  const matches = input.observedToolCalls.filter(
    (call) =>
      call.name === input.action.name && !input.usedToolCallIds.has(call.id),
  );
  const exactMatches = matches.filter((call) =>
    sameToolArgs(call.args, input.action.args),
  );
  if (exactMatches.length !== 1) {
    throw new ContentError(
      500,
      exactMatches.length > 1
        ? "AGENT_HITL_TOOL_CALL_AMBIGUOUS"
        : "AGENT_HITL_TOOL_CALL_NOT_FOUND",
      exactMatches.length > 1
        ? `DeepAgents HITL interrupted ${input.action.name}, but multiple streamed tool calls had identical arguments.`
        : `DeepAgents HITL interrupted ${input.action.name}, but no streamed tool call had exact matching arguments.`,
    );
  }
  const match = exactMatches[0]!;
  input.usedToolCallIds.add(match.id);
  return match;
}

function withHitlEditableArgs(
  confirmation: ToolConfirmationRequest,
  reviewConfig: HitlReviewConfig | undefined,
) {
  if (
    confirmation.domain === "connector" ||
    !reviewConfig ||
    !reviewConfig.allowedDecisions.includes("edit")
  ) {
    return confirmation;
  }
  return {
    ...confirmation,
    editableArgs: {
      value:
        confirmation.editableArgs?.value ??
        confirmation.preview.requestJson ??
        {},
      ...(reviewConfig.argsSchema
        ? { schema: reviewConfig.argsSchema }
        : confirmation.editableArgs?.schema
          ? { schema: confirmation.editableArgs.schema }
          : {}),
    },
  };
}

function connectorHitlActionResumeInput(action: HitlActionRequest) {
  const { connectorId: rawConnectorId, ...requestJson } = action.args;
  return {
    connectorId:
      typeof rawConnectorId === "string" && rawConnectorId.trim().length > 0
        ? rawConnectorId.trim()
        : undefined,
    requestJson,
    toolName: action.name,
  };
}

function createSandboxToolConfirmation(input: {
  action: HitlActionRequest;
  hitlInterruptId?: string;
  reviewConfig?: HitlReviewConfig;
  toolCallId: string;
}): ToolConfirmationRequest | null {
  if (!isSandboxToolName(input.action.name)) {
    return null;
  }
  const definition = getAgentToolDefinition(input.action.name);
  const label = definition?.id ?? input.action.name;
  return withHitlEditableArgs(
    {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id: input.toolCallId,
      domain: "sandbox",
      subject: {
        label: "Sandbox runtime",
        provider: "sandbox",
      },
      action: {
        type: input.action.name,
        toolName: input.action.name,
        label,
        ...(input.action.description
          ? { description: input.action.description }
          : {}),
        riskLevel: definition?.riskLevel ?? "high",
        status: "proposed",
        requiresApproval: true,
      },
      preview: {
        title: `Review sandbox action: ${input.action.name}`,
        summary:
          input.action.description ??
          "Review this sandbox action before it runs in the isolated runtime.",
        requestJson: input.action.args,
      },
      decisionOptions: [
        { decision: "reject", label: "Reject" },
        { decision: "approve", label: "Approve" },
      ],
      execution: {
        providerStatus: "not_executed",
        executor: {
          kind: "sandbox_tool_call",
        },
        sourceweft: {
          ...(input.hitlInterruptId
            ? { hitlInterruptId: input.hitlInterruptId }
            : {}),
          ...(input.action.name === "execute"
            ? { sandboxExecuteToolCallId: input.toolCallId }
            : {}),
        },
      },
      status: "proposed",
      userMessage: "Waiting for sandbox action confirmation.",
    },
    input.reviewConfig,
  );
}

function isConnectorHitlActionAlreadyApproved(input: {
  action: HitlActionRequest;
  connectorContext: {
    actionExecutionCursor?: ConnectorActionExecutionCursor;
  };
}) {
  return Boolean(
    peekConnectorActionExecutionRef(
      input.connectorContext,
      connectorHitlActionResumeInput(input.action),
    ),
  );
}

export function buildAutoApprovedHitlResumeDecisions(input: {
  connectorContext: {
    actionExecutionCursor?: ConnectorActionExecutionCursor;
  };
  hitlInterrupts: HitlInterruptRequest[];
}): ToolApprovalResumeDecision[] | null {
  const decisions: ToolApprovalResumeDecision[] = [];

  for (const interruptRequest of input.hitlInterrupts) {
    for (const action of interruptRequest.actionRequests) {
      if (
        !isConnectorHitlActionAlreadyApproved({
          action,
          connectorContext: input.connectorContext,
        })
      ) {
        return null;
      }
      decisions.push({ type: "approve" });
    }
  }

  return decisions.length > 0 ? decisions : null;
}

export async function createHitlConfirmation(input: {
  action: HitlActionRequest;
  connectorContext: {
    actionApprovalCursor?: ConnectorActionApprovalCursor;
    actionExecutionCursor?: ConnectorActionExecutionCursor;
    actionApprovalScope?: string;
    enabledToolNames?: ReadonlySet<string>;
    teamId: string;
    workspaceId: string;
    userId: string;
  };
  reviewConfig?: HitlReviewConfig;
  hitlInterruptId?: string;
  toolCallId: string;
}) {
  const sandboxConfirmation = createSandboxToolConfirmation({
    action: input.action,
    hitlInterruptId: input.hitlInterruptId,
    reviewConfig: input.reviewConfig,
    toolCallId: input.toolCallId,
  });
  if (sandboxConfirmation) {
    return sandboxConfirmation;
  }

  const confirmation = input.action.name.startsWith("mcp__")
    ? await mcpService.createApprovalForInterruptedTool({
        workspaceId: input.connectorContext.workspaceId,
        userId: input.connectorContext.userId,
        toolName: input.action.name,
        args: input.action.args,
        toolCallId: input.toolCallId,
      })
    : await createConnectorActionApprovalRequest(input.connectorContext, {
        args: input.action.args,
        toolCallId: input.toolCallId,
        toolName: input.action.name,
      });
  if (!confirmation) {
    throw new ContentError(
      500,
      "AGENT_HITL_CONFIRMATION_UNSUPPORTED",
      `DeepAgents HITL interrupted unsupported tool ${input.action.name}.`,
    );
  }
  const nextConfirmation = withHitlEditableArgs(
    confirmation,
    input.reviewConfig,
  );
  return input.hitlInterruptId
    ? {
        ...nextConfirmation,
        execution: {
          ...nextConfirmation.execution,
          sourceweft: {
            ...(nextConfirmation.execution.sourceweft ?? {}),
            hitlInterruptId: input.hitlInterruptId,
          },
        },
      }
    : nextConfirmation;
}

export function commandResumeFromToolApprovalResume(
  resume: ToolApprovalResume,
): ToolApprovalResume | Record<string, ToolApprovalResume> {
  const interruptId = resume.sourceweft?.hitlInterruptId;
  const commandResume = { decisions: resume.decisions };
  return interruptId ? { [interruptId]: commandResume } : commandResume;
}

export function commandResumeFromHitlDecisions(input: {
  decisions: ToolApprovalResumeDecision[];
  hitlInterruptId?: string;
}): ToolApprovalResume | Record<string, ToolApprovalResume> {
  const commandResume = { decisions: input.decisions };
  return input.hitlInterruptId
    ? { [input.hitlInterruptId]: commandResume }
    : commandResume;
}

export function shouldSilenceEmptyApprovalResume(input: {
  assistantMessageId: string | null;
  hasCompletedToolOutput: boolean;
  toolApprovalResume: ToolApprovalResume | null;
}) {
  if (!input.assistantMessageId || input.hasCompletedToolOutput) {
    return false;
  }

  return (
    input.toolApprovalResume?.decisions.some(
      (decision) => decision.type === "reject",
    ) ?? false
  );
}
