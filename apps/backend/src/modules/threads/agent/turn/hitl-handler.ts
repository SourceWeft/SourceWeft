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
import {
  approveConnectorActionForTrustRule,
  createConnectorActionApprovalRequest,
} from "../../../connectors/agent-tools";
import {
  findAgentToolTrustRuleForScope,
  resolveAgentToolTrustScope,
  touchAgentToolTrustRuleUse,
  type AgentToolTrustScope,
} from "../../../agent-confirmations/trust-rules";
import { mcpService } from "../../../mcp";
import { ContentError } from "../../../content/errors";
import {
  getAgentToolDefinition,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { logger } from "../../../../shared/logger";
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

export type HitlActionBinding = {
  actionIndex: number;
  hitlInterruptId?: string;
  requestJson: Record<string, unknown>;
  sourceUserMessageId?: string;
  sourceAssistantMessageId?: string;
  toolCallId: string;
  toolName: string;
};

type SandboxActionExecutionRef = NonNullable<
  NonNullable<ToolApprovalResume["sourceweft"]>["sandboxActions"]
>[number];

export type SandboxActionExecutionCursor = {
  consumedActionKeys?: Set<string>;
  refs: SandboxActionExecutionRef[];
  value: number;
};

function sandboxActionExecutionRefKey(ref: SandboxActionExecutionRef) {
  return `${ref.toolName}:${ref.toolCallId}`;
}

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

/**
 * Stable, payload-derived id for an interrupted action, used as the confirmation
 * / trace / render-block key in place of a checkpoint tool-call id. Deterministic
 * across the approve→resume round trip (the same interrupt re-fires at the same
 * checkpoint in the same order), and it never reads graph state, so an interrupt
 * raised inside a sub-agent subgraph (whose tool-call id never surfaces in the
 * top-level graph) binds correctly.
 */
export function hitlActionRef(input: {
  checkpointId: string;
  index: number;
  interruptId?: string;
  toolName: string;
}) {
  return `hitl:${input.interruptId ?? input.checkpointId}:${input.index}:${input.toolName}`;
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

function sourceweftMetadataFromHitlBinding(binding: HitlActionBinding) {
  return {
    ...(binding.hitlInterruptId
      ? { hitlInterruptId: binding.hitlInterruptId }
      : {}),
    actionIndex: binding.actionIndex,
    ...(binding.sourceUserMessageId
      ? { sourceUserMessageId: binding.sourceUserMessageId }
      : {}),
    ...(binding.sourceAssistantMessageId
      ? { sourceAssistantMessageId: binding.sourceAssistantMessageId }
      : {}),
    toolName: binding.toolName,
    requestJson: binding.requestJson,
    hitlActionIndex: binding.actionIndex,
    hitlActionToolName: binding.toolName,
    hitlActionRequestJson: binding.requestJson,
    toolCallId: binding.toolCallId,
  };
}

function createSandboxToolConfirmation(input: {
  action: HitlActionRequest;
  binding: HitlActionBinding;
  reviewConfig?: HitlReviewConfig;
}): ToolConfirmationRequest | null {
  if (!isAgentToolDomain(input.action.name, "sandbox")) {
    return null;
  }
  const definition = getAgentToolDefinition(input.action.name);
  const label = definition?.id ?? input.action.name;
  return withHitlEditableArgs(
    {
      type: "tool_confirmation_request",
      schemaVersion: 1,
      id: input.binding.toolCallId,
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
        // Gated on the registry declaring a risk level, because that is exactly
        // what `resolveAgentToolTrustScope` requires: a tool with no declared
        // risk cannot be contained by `allowedRiskLevels`, so no rule is ever
        // written for it and the option would be a promise the server cannot
        // keep. The displayed risk falls back to "high" above; the trust scope
        // deliberately does not.
        ...(definition?.riskLevel
          ? [
              {
                decision: "approve_always" as const,
                label: "Always allow",
                description:
                  "Run this action now and approve the same action automatically until the grant expires.",
              },
            ]
          : []),
      ],
      execution: {
        providerStatus: "not_executed",
        executor: {
          kind: "sandbox_tool_call",
        },
        sourceweft: sourceweftMetadataFromHitlBinding(input.binding),
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

function consumeSandboxActionExecutionRef(
  cursor: SandboxActionExecutionCursor | undefined,
  ref: SandboxActionExecutionRef,
) {
  if (!cursor) {
    return;
  }
  cursor.consumedActionKeys ??= new Set<string>();
  cursor.consumedActionKeys.add(sandboxActionExecutionRefKey(ref));
  cursor.value = Math.max(
    cursor.value,
    cursor.refs.findIndex(
      (candidate) =>
        candidate.toolCallId === ref.toolCallId &&
        candidate.toolName === ref.toolName,
    ) + 1,
  );
}

function findMatchingSandboxActionExecutionRef(input: {
  action: HitlActionRequest;
  hitlInterruptId?: string;
  sourceUserMessageId?: string;
  sourceAssistantMessageId?: string;
  sandboxActionExecutionCursor?: SandboxActionExecutionCursor;
}) {
  const refs = input.sandboxActionExecutionCursor?.refs ?? [];
  return (
    refs.find((candidate) => {
      if (
        input.sandboxActionExecutionCursor?.consumedActionKeys?.has(
          sandboxActionExecutionRefKey(candidate),
        )
      ) {
        return false;
      }
      if (
        input.hitlInterruptId &&
        candidate.hitlInterruptId &&
        candidate.hitlInterruptId !== input.hitlInterruptId
      ) {
        return false;
      }
      if (
        input.sourceUserMessageId &&
        candidate.sourceUserMessageId &&
        candidate.sourceUserMessageId !== input.sourceUserMessageId
      ) {
        return false;
      }
      if (
        input.sourceAssistantMessageId &&
        candidate.sourceAssistantMessageId &&
        candidate.sourceAssistantMessageId !== input.sourceAssistantMessageId
      ) {
        return false;
      }
      return (
        candidate.toolName === input.action.name &&
        sameToolArgs(candidate.requestJson, input.action.args)
      );
    }) ?? null
  );
}

function isSandboxHitlActionAlreadyApproved(input: {
  action: HitlActionRequest;
  hitlInterruptId?: string;
  sourceUserMessageId?: string;
  sourceAssistantMessageId?: string;
  sandboxActionExecutionCursor?: SandboxActionExecutionCursor;
}) {
  if (!isAgentToolDomain(input.action.name, "sandbox")) {
    return false;
  }

  const ref = findMatchingSandboxActionExecutionRef({
    action: input.action,
    hitlInterruptId: input.hitlInterruptId,
    sourceUserMessageId: input.sourceUserMessageId,
    sourceAssistantMessageId: input.sourceAssistantMessageId,
    sandboxActionExecutionCursor: input.sandboxActionExecutionCursor,
  });
  if (!ref) {
    return false;
  }
  consumeSandboxActionExecutionRef(input.sandboxActionExecutionCursor, ref);
  return true;
}

export function buildAutoApprovedHitlResume(input: {
  connectorContext: {
    actionExecutionCursor?: ConnectorActionExecutionCursor;
    sandboxActionExecutionCursor?: SandboxActionExecutionCursor;
    sourceUserMessageId?: string;
    sourceAssistantMessageId?: string;
  };
  hitlInterrupts: HitlInterruptRequest[];
}): {
  decisions: ToolApprovalResumeDecision[];
} | null {
  const decisions: ToolApprovalResumeDecision[] = [];

  for (const interruptRequest of input.hitlInterrupts) {
    for (const action of interruptRequest.actionRequests) {
      if (
        isConnectorHitlActionAlreadyApproved({
          action,
          connectorContext: input.connectorContext,
        })
      ) {
        decisions.push({ type: "approve" });
        continue;
      }

      if (
        isSandboxHitlActionAlreadyApproved({
          action,
          hitlInterruptId: interruptRequest.id,
          sourceUserMessageId: input.connectorContext.sourceUserMessageId,
          sourceAssistantMessageId:
            input.connectorContext.sourceAssistantMessageId,
          sandboxActionExecutionCursor:
            input.connectorContext.sandboxActionExecutionCursor,
        })
      ) {
        decisions.push({ type: "approve" });
        continue;
      }

      return null;
    }
  }

  return decisions.length > 0 ? { decisions } : null;
}

export function buildAutoApprovedHitlResumeDecisions(input: {
  connectorContext: {
    actionExecutionCursor?: ConnectorActionExecutionCursor;
    sandboxActionExecutionCursor?: SandboxActionExecutionCursor;
    sourceUserMessageId?: string;
    sourceAssistantMessageId?: string;
  };
  hitlInterrupts: HitlInterruptRequest[];
}): ToolApprovalResumeDecision[] | null {
  return buildAutoApprovedHitlResume(input)?.decisions ?? null;
}

export type TrustedHitlApprovalMatch = {
  action: HitlActionRequest;
  actionIndex: number;
  hitlInterruptId?: string;
  scope: AgentToolTrustScope;
  trustRuleId: string;
};

export type TrustedHitlApproval = {
  decisions: ToolApprovalResumeDecision[];
  matches: TrustedHitlApprovalMatch[];
};

/**
 * Read-only pass over an interrupt: does every single interrupted action have a
 * live trust rule covering it?
 *
 * All-or-nothing on purpose. An interrupt is resumed with one decision list, so
 * partially auto-approving would mean silently executing the covered actions
 * while the user is still being asked about the rest — the user would approve a
 * prompt whose siblings had already run. Returning `null` (prompt for
 * everything) is the only behaviour that keeps the prompt honest.
 *
 * This function performs no writes, so bailing out costs nothing and leaves no
 * trace: rules are only marked used once the whole interrupt is covered.
 */
export async function resolveTrustedHitlApproval(input: {
  connectorContext: {
    teamId: string;
    workspaceId: string;
    userId: string;
  };
  hitlInterrupts: HitlInterruptRequest[];
}): Promise<TrustedHitlApproval | null> {
  const matches: TrustedHitlApprovalMatch[] = [];
  const tenant = {
    teamId: input.connectorContext.teamId,
    workspaceId: input.connectorContext.workspaceId,
    userId: input.connectorContext.userId,
  };

  try {
    for (const interruptRequest of input.hitlInterrupts) {
      for (const [index, action] of interruptRequest.actionRequests.entries()) {
        const scope = await resolveAgentToolTrustScope({
          args: action.args,
          context: tenant,
          toolName: action.name,
        });
        if (!scope) {
          return null;
        }
        const rule = await findAgentToolTrustRuleForScope({ scope, tenant });
        if (!rule) {
          return null;
        }
        matches.push({
          action,
          actionIndex: index,
          ...(interruptRequest.id
            ? { hitlInterruptId: interruptRequest.id }
            : {}),
          scope,
          trustRuleId: rule.id,
        });
      }
    }
  } catch (error) {
    // A trust rule is a convenience over the approval prompt, never a
    // requirement for it. If the lookup itself fails we ask the user, which is
    // the same thing that happens when no rule exists — an unavailable trust
    // store must never be able to break a turn, and it must certainly never
    // fail in the direction of auto-approving.
    logger.warn("Agent tool trust rule lookup failed; falling back to prompt", {
      workspaceId: tenant.workspaceId,
      userId: tenant.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  return matches.length > 0
    ? { decisions: matches.map(() => ({ type: "approve" as const })), matches }
    : null;
}

/**
 * Side-effecting half of the trust gate, run only after
 * {@link resolveTrustedHitlApproval} confirmed the whole interrupt is covered.
 *
 * Connector actions get a real proposed+approved action run pushed onto the
 * execution cursor because the connector tool body refuses to execute without
 * one; skipping that would turn a matched trust rule into a hard tool failure
 * rather than a silent approval.
 */
export async function applyTrustedHitlApproval(input: {
  approval: TrustedHitlApproval;
  connectorContext: {
    actionApprovalCursor?: ConnectorActionApprovalCursor;
    actionExecutionCursor?: ConnectorActionExecutionCursor;
    actionApprovalScope?: string;
    teamId: string;
    workspaceId: string;
    userId: string;
  };
}) {
  const tenant = {
    teamId: input.connectorContext.teamId,
    workspaceId: input.connectorContext.workspaceId,
    userId: input.connectorContext.userId,
  };

  for (const match of input.approval.matches) {
    if (match.scope.connectorId) {
      const ref = await approveConnectorActionForTrustRule(
        input.connectorContext,
        {
          args: match.action.args,
          // The approval cursor supplies the real idempotency key whenever the
          // turn has one; this fallback only has to be stable for a retry of
          // the same interrupt, which is why it is derived and not random.
          toolCallId: `trust:${match.hitlInterruptId ?? "hitl"}:${match.actionIndex}:${match.action.name}`,
          toolName: match.action.name,
        },
      );
      if (!ref) {
        return false;
      }
      input.connectorContext.actionExecutionCursor ??= { refs: [], value: 0 };
      input.connectorContext.actionExecutionCursor.refs.push(ref);
    }
    await touchAgentToolTrustRuleUse({ trustRuleId: match.trustRuleId, tenant });
  }

  return true;
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
  binding: HitlActionBinding;
}) {
  const sandboxConfirmation = createSandboxToolConfirmation({
    action: input.action,
    binding: input.binding,
    reviewConfig: input.reviewConfig,
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
        toolCallId: input.binding.toolCallId,
      })
    : await createConnectorActionApprovalRequest(input.connectorContext, {
        args: input.action.args,
        toolCallId: input.binding.toolCallId,
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
  return {
    ...nextConfirmation,
    execution: {
      ...nextConfirmation.execution,
      sourceweft: {
        ...(nextConfirmation.execution.sourceweft ?? {}),
        ...sourceweftMetadataFromHitlBinding(input.binding),
      },
    },
  };
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
