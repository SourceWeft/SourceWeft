import { Command } from "@langchain/langgraph";
import type { createThreadAgent } from "..";
import { buildConnectorActionApprovalScope } from "../../../connectors/agent-tool-idempotency";
import type {
  ConnectorActionApprovalCursor,
  ConnectorActionExecutionCursor,
} from "../../../connectors/agent-tool-idempotency";
import { ContentError } from "../../../content/errors";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { LlmExecutionConfig } from "../../../content/model-gateway-audit";
import type { AgentCheckpointRef, PreparedThreadTurn, ToolCallTrace } from "../..";
import { finalizeMessageRenderBlocks } from "../../turn/render-blocks";
import { logger } from "../../../../shared/logger";
import { resolveAssistantContentFromUpdatesChunk } from "./content";
import {
  resolveHitlInterruptCheckpoint,
  resolvePendingInterruptCheckpoint,
  type AgentRunnableConfig,
} from "./checkpoint";
import type { DeepAgentTurnEvent } from "./events";
import {
  applyTrustedHitlApproval,
  buildAutoApprovedHitlResume,
  commandResumeFromHitlDecisions,
  createHitlConfirmation,
  extractHitlInterrupts,
  hitlActionRef,
  resolveTrustedHitlApproval,
  type HitlActionBinding,
  type SandboxActionExecutionCursor,
} from "./hitl-handler";
import { listThinkingSteps } from "./thinking";
import {
  extractToolCallsFromAgentState,
  extractToolCallsFromUpdates,
  rememberObservedToolCalls,
} from "./tool-tracker";
import type { TurnRuntime } from "./turn-runtime";

type Agent = Awaited<ReturnType<typeof createThreadAgent>>;

type HitlConnectorContext = {
  actionApprovalCursor?: ConnectorActionApprovalCursor;
  actionExecutionCursor?: ConnectorActionExecutionCursor;
  actionApprovalScope?: string;
  sandboxActionExecutionCursor?: SandboxActionExecutionCursor;
  enabledToolNames?: ReadonlySet<string>;
  sourceUserMessageId?: string;
  sourceAssistantMessageId?: string;
  teamId: string;
  workspaceId: string;
  userId: string;
};

export type HitlStreamHandlerResult =
  | { kind: "continue" }
  | {
      kind: "replace-stream";
      autoApprovedHitlResumeCount: number;
      beforeAssistantCheckpoint: AgentCheckpointRef;
      finalCheckpoint: AgentCheckpointRef;
      stream: AsyncGenerator<unknown>;
    }
  | { kind: "done" };

export async function* handleHitlStreamChunk(input: {
  agent: Agent;
  autoApprovedHitlResumeCount: number;
  beforeAssistantCheckpoint: AgentCheckpointRef | null;
  beforeInputCheckpoint: AgentCheckpointRef | null;
  billing?: ContentBillingPort;
  connectorToolContext: HitlConnectorContext;
  finalCheckpoint: AgentCheckpointRef | null;
  llm?: LlmExecutionConfig;
  maxAutoApprovedHitlResumes: number;
  prepared?: PreparedThreadTurn;
  payload: unknown;
  runConfig: AgentRunnableConfig;
  runtime: TurnRuntime;
  threadId: string;
  userId: string;
  workspaceId: string;
}): AsyncGenerator<DeepAgentTurnEvent, HitlStreamHandlerResult> {
  const { runtime } = input;
  const payloadToolCalls = extractToolCallsFromUpdates(input.payload);
  rememberObservedToolCalls(runtime.observedToolCallsById, payloadToolCalls);
  const assistantFromUpdates = resolveAssistantContentFromUpdatesChunk(
    input.payload,
  );
  if (assistantFromUpdates && assistantFromUpdates.trim().length > 0) {
    runtime.assistantContentFromUpdates = assistantFromUpdates.trim();
  }

  const hitlInterrupts = extractHitlInterrupts(input.payload);
  if (hitlInterrupts.length === 0) {
    return { kind: "continue" };
  }

  runtime.resetReasoningBoundary();
  if (runtime.hasTextSinceLastToolBoundary) {
    yield {
      type: "text-interrupted",
      reason: "tool-call",
      toolCallId: "tool_confirmation",
      tool: "tool_confirmation",
    };
    runtime.assistantContent += "\n";
    runtime.renderBlocks.appendText("\n");
    yield {
      type: "text-delta",
      delta: "\n",
    };
    runtime.hasTextSinceLastToolBoundary = false;
  }

  const interruptCheckpoint = await resolvePendingInterruptCheckpoint({
    agent: input.agent,
    config: input.runConfig,
  });
  rememberObservedToolCalls(
    runtime.observedToolCallsById,
    extractToolCallsFromAgentState(interruptCheckpoint.state),
  );
  const hitlCheckpoint = resolveHitlInterruptCheckpoint({
    pendingCheckpoint: interruptCheckpoint,
    observedCheckpoint: input.finalCheckpoint,
  });
  if (!hitlCheckpoint) {
    throw new ContentError(
      500,
      "AGENT_HITL_TOOL_CALL_NOT_FOUND",
      "DeepAgents HITL interrupt did not have a pending checkpoint to bind a confirmation tool call.",
    );
  }

  input.connectorToolContext.actionApprovalScope =
    buildConnectorActionApprovalScope({
      threadId: hitlCheckpoint.threadId,
      checkpointId: hitlCheckpoint.checkpointId,
    });
  const autoApprovedHitlResume = buildAutoApprovedHitlResume({
    connectorContext: input.connectorToolContext,
    hitlInterrupts,
  });
  if (
    autoApprovedHitlResume &&
    input.autoApprovedHitlResumeCount < input.maxAutoApprovedHitlResumes
  ) {
    const autoApprovedHitlResumeCount = input.autoApprovedHitlResumeCount + 1;
    logger.info(
      "Agent HITL interrupt already has approved execution metadata; resuming without a duplicate confirmation",
      {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        userId: input.userId,
        decisionCount: autoApprovedHitlResume.decisions.length,
        autoApprovedHitlResumeCount,
      },
    );
    const stream = (await input.agent.stream(
      new Command({
        resume: commandResumeFromHitlDecisions({
          decisions: autoApprovedHitlResume.decisions,
          hitlInterruptId:
            hitlInterrupts.length === 1 ? hitlInterrupts[0]?.id : undefined,
        }),
      }),
      input.runConfig,
    )) as AsyncGenerator<unknown>;
    return {
      kind: "replace-stream",
      stream,
      finalCheckpoint: hitlCheckpoint,
      beforeAssistantCheckpoint: hitlCheckpoint,
      autoApprovedHitlResumeCount,
    };
  }

  // Trust gate. Consulted after the "already approved earlier in this turn"
  // check and *before* any confirmation is built, because building one for a
  // connector proposes a durable action run and shows the user a prompt we have
  // already decided not to ask. A matched rule replaces the prompt entirely; a
  // miss falls through and the user is asked exactly as before.
  //
  // The same resume budget bounds this path: an auto-approved resume that keeps
  // re-interrupting must not loop forever just because a trust rule exists.
  if (input.autoApprovedHitlResumeCount < input.maxAutoApprovedHitlResumes) {
    const trustedApproval = await resolveTrustedHitlApproval({
      connectorContext: input.connectorToolContext,
      hitlInterrupts,
    });
    if (
      trustedApproval &&
      (await applyTrustedHitlApproval({
        approval: trustedApproval,
        connectorContext: input.connectorToolContext,
      }))
    ) {
      const autoApprovedHitlResumeCount = input.autoApprovedHitlResumeCount + 1;
      logger.info(
        "Agent HITL interrupt auto-approved by agent tool trust rules; resuming without a confirmation",
        {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          userId: input.userId,
          decisionCount: trustedApproval.decisions.length,
          trustRuleIds: trustedApproval.matches.map(
            (match) => match.trustRuleId,
          ),
          autoApprovedHitlResumeCount,
        },
      );
      const stream = (await input.agent.stream(
        new Command({
          resume: commandResumeFromHitlDecisions({
            decisions: trustedApproval.decisions,
            hitlInterruptId:
              hitlInterrupts.length === 1 ? hitlInterrupts[0]?.id : undefined,
          }),
        }),
        input.runConfig,
      )) as AsyncGenerator<unknown>;
      return {
        kind: "replace-stream",
        stream,
        finalCheckpoint: hitlCheckpoint,
        beforeAssistantCheckpoint: hitlCheckpoint,
        autoApprovedHitlResumeCount,
      };
    }
  }

  if (!interruptCheckpoint.pending || !interruptCheckpoint.checkpoint) {
    throw new ContentError(
      500,
      "AGENT_HITL_TOOL_CALL_NOT_FOUND",
      "DeepAgents HITL interrupt did not have a pending checkpoint to bind a confirmation tool call.",
    );
  }

  for (const interruptRequest of hitlInterrupts) {
    for (const [index, action] of interruptRequest.actionRequests.entries()) {
      // Every domain binds to a stable, payload-derived id and resolves approval
      // by args-ref (connector/sandbox) or by args-matched action run (MCP) at
      // execution — never by a checkpoint tool-call id. That is what lets an
      // interrupt raised inside a sub-agent subgraph, whose tool-call id never
      // surfaces in the top-level graph, bind and resume correctly.
      const toolCallId = hitlActionRef({
        checkpointId: hitlCheckpoint.checkpointId,
        index,
        ...(interruptRequest.id ? { interruptId: interruptRequest.id } : {}),
        toolName: action.name,
      });
      const binding: HitlActionBinding = {
        actionIndex: index,
        ...(interruptRequest.id
          ? { hitlInterruptId: interruptRequest.id }
          : {}),
        requestJson: action.args,
        ...(input.connectorToolContext.sourceUserMessageId
          ? {
              sourceUserMessageId:
                input.connectorToolContext.sourceUserMessageId,
            }
          : {}),
        ...(input.connectorToolContext.sourceAssistantMessageId
          ? {
              sourceAssistantMessageId:
                input.connectorToolContext.sourceAssistantMessageId,
            }
          : {}),
        toolCallId: toolCallId,
        toolName: action.name,
      };
      const reviewConfig =
        interruptRequest.reviewConfigs.find(
          (config) => config.actionName === action.name,
        ) ?? interruptRequest.reviewConfigs[index];
      const confirmation = await createHitlConfirmation({
        action,
        binding,
        connectorContext: input.connectorToolContext,
        reviewConfig,
      });
      const latencyMs = 0;
      const nextToolCall: ToolCallTrace = {
        id: toolCallId,
        tool: action.name,
        input: action.args,
        output: confirmation,
        status: "approval_requested",
        latencyMs,
        error: null,
        sequence:
          runtime.toolCallsById.get(toolCallId)?.sequence ??
          runtime.resolveToolCallSequence(toolCallId),
      };
      if (!runtime.toolCallsById.has(toolCallId)) {
        runtime.toolCallOrder.push(toolCallId);
      }
      runtime.toolCallsById.set(toolCallId, nextToolCall);
      runtime.renderBlocks.appendTool(toolCallId);
      const runningToolCall: ToolCallTrace = {
        ...nextToolCall,
        output: null,
        status: "running",
      };
      yield {
        type: "tool-call-start",
        id: toolCallId,
        tool: action.name,
        input: action.args,
        toolCall: runningToolCall,
      };
      yield {
        type: "tool-call-result",
        id: toolCallId,
        tool: action.name,
        input: action.args,
        output: confirmation,
        latencyMs,
        toolCall: nextToolCall,
      };
      yield {
        type: "tool-call-end",
        id: toolCallId,
        tool: action.name,
        latencyMs,
        status: "approval_requested",
        toolCall: nextToolCall,
      };
      logger.info("Agent turn paused for DeepAgents HITL interrupt", {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        userId: input.userId,
        toolName: action.name,
        toolCallId: toolCallId,
        confirmationId: confirmation.id,
      });
    }
  }

  const finalText = runtime.assistantContent.trim();
  const finalRenderBlocks = finalizeMessageRenderBlocks({
    blocks: runtime.renderBlocks.list(),
    finalText,
  });
  yield {
    type: "done",
    outcome: {
      assistantContent: finalText,
      usage: runtime.billingScope?.totalUsage(),
      finishReason: "tool_confirmation_requested",
      reasoning: runtime.modelReasoning,
      retrieval: runtime.latestToolRetrieval,
      citations: [],
      availableCitations: runtime.citationRegistry.list(),
      retrievalCalls: runtime.collectRetrievalCalls(),
      toolCalls: runtime.collectToolCalls(),
      meteredLlmCalls: [...(runtime.billingScope?.meteredCalls() ?? [])],
      ...(finalRenderBlocks.length > 0
        ? { renderBlocks: finalRenderBlocks }
        : {}),
      thinkingSteps: listThinkingSteps({
        stepsById: runtime.thinkingStepsById,
        stepOrder: runtime.thinkingStepOrder,
      }),
      reasoningSegments: runtime.reasoningSegments,
      agentCheckpoint: {
        beforeInput: input.beforeInputCheckpoint,
        beforeAssistant: hitlCheckpoint,
        resume: hitlCheckpoint,
        final: hitlCheckpoint,
      },
    },
  };
  return { kind: "done" };
}
