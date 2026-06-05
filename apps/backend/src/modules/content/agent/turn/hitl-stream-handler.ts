import { Command } from "@langchain/langgraph";
import type { createThreadAgent } from "..";
import { buildConnectorActionApprovalScope } from "../../../connectors/agent-tool-idempotency";
import type {
  ConnectorActionApprovalCursor,
  ConnectorActionExecutionCursor,
} from "../../../connectors/agent-tool-idempotency";
import { ContentError } from "../../errors";
import type { AgentCheckpointRef, ToolCallTrace } from "../../threads";
import { finalizeMessageRenderBlocks } from "../../threads/turn/render-blocks";
import { logger } from "../../../../shared/logger";
import {
  resolveAssistantContentFromUpdatesChunk,
} from "./content";
import {
  resolveHitlInterruptCheckpoint,
  resolvePendingInterruptCheckpoint,
  type AgentRunnableConfig,
} from "./checkpoint";
import type { DeepAgentTurnEvent } from "./events";
import {
  buildAutoApprovedHitlResumeDecisions,
  commandResumeFromHitlDecisions,
  createHitlConfirmation,
  extractHitlInterrupts,
  matchInterruptedToolCall,
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
  enabledToolNames?: ReadonlySet<string>;
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
  connectorToolContext: HitlConnectorContext;
  finalCheckpoint: AgentCheckpointRef | null;
  maxAutoApprovedHitlResumes: number;
  payload: unknown;
  runConfig: AgentRunnableConfig;
  runtime: TurnRuntime;
  threadId: string;
  userId: string;
  workspaceId: string;
}): AsyncGenerator<DeepAgentTurnEvent, HitlStreamHandlerResult> {
  const { runtime } = input;
  rememberObservedToolCalls(
    runtime.observedToolCallsById,
    extractToolCallsFromUpdates(input.payload),
  );
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

  runtime.currentReasoningSegment = null;
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

  const usedToolCallIds = new Set<string>();
  const interruptCheckpoint = await resolvePendingInterruptCheckpoint({
    agent: input.agent,
    config: input.runConfig,
  });
  rememberObservedToolCalls(
    runtime.observedToolCallsById,
    extractToolCallsFromAgentState(interruptCheckpoint.state),
  );
  const observedToolCalls = [...runtime.observedToolCallsById.values()];
  const hitlCheckpoint = resolveHitlInterruptCheckpoint({
    pendingCheckpoint: interruptCheckpoint,
    observedCheckpoint: input.finalCheckpoint,
  });
  if (!hitlCheckpoint) {
    throw new ContentError(
      409,
      "AGENT_HITL_CHECKPOINT_MISSING",
      "DeepAgents HITL interrupt did not provide a resumable checkpoint.",
    );
  }

  input.connectorToolContext.actionApprovalScope =
    buildConnectorActionApprovalScope({
      threadId: hitlCheckpoint.threadId,
      checkpointId: hitlCheckpoint.checkpointId,
    });
  const autoApprovedHitlDecisions = buildAutoApprovedHitlResumeDecisions({
    connectorContext: input.connectorToolContext,
    hitlInterrupts,
  });
  if (
    autoApprovedHitlDecisions &&
    input.autoApprovedHitlResumeCount < input.maxAutoApprovedHitlResumes
  ) {
    const autoApprovedHitlResumeCount = input.autoApprovedHitlResumeCount + 1;
    logger.info(
      "Agent HITL interrupt already has approved connector execution refs; resuming without a duplicate confirmation",
      {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        userId: input.userId,
        decisionCount: autoApprovedHitlDecisions.length,
        autoApprovedHitlResumeCount,
      },
    );
    const stream = (await input.agent.stream(
      new Command({
        resume: commandResumeFromHitlDecisions({
          decisions: autoApprovedHitlDecisions,
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

  for (const interruptRequest of hitlInterrupts) {
    for (const [index, action] of interruptRequest.actionRequests.entries()) {
      const observedToolCall = matchInterruptedToolCall({
        action,
        index,
        observedToolCalls,
        usedToolCallIds,
      });
      const reviewConfig =
        interruptRequest.reviewConfigs.find(
          (config) => config.actionName === action.name,
        ) ?? interruptRequest.reviewConfigs[index];
      const confirmation = await createHitlConfirmation({
        action,
        connectorContext: input.connectorToolContext,
        hitlInterruptId: interruptRequest.id,
        reviewConfig,
        toolCallId: observedToolCall.id,
      });
      const latencyMs = 0;
      const nextToolCall: ToolCallTrace = {
        id: observedToolCall.id,
        tool: action.name,
        input: action.args,
        output: confirmation,
        status: "approval_requested",
        latencyMs,
        error: null,
        sequence:
          runtime.toolCallsById.get(observedToolCall.id)?.sequence ??
          runtime.resolveToolCallSequence(observedToolCall.id),
      };
      if (!runtime.toolCallsById.has(observedToolCall.id)) {
        runtime.toolCallOrder.push(observedToolCall.id);
      }
      runtime.toolCallsById.set(observedToolCall.id, nextToolCall);
      runtime.renderBlocks.appendTool(observedToolCall.id);
      const runningToolCall: ToolCallTrace = {
        ...nextToolCall,
        output: null,
        status: "running",
      };
      yield {
        type: "tool-call-start",
        id: observedToolCall.id,
        tool: action.name,
        input: action.args,
        toolCall: runningToolCall,
      };
      yield {
        type: "tool-call-result",
        id: observedToolCall.id,
        tool: action.name,
        input: action.args,
        output: confirmation,
        latencyMs,
        toolCall: nextToolCall,
      };
      yield {
        type: "tool-call-end",
        id: observedToolCall.id,
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
        toolCallId: observedToolCall.id,
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
      usage: runtime.usage,
      finishReason: "tool_confirmation_requested",
      reasoning: runtime.modelReasoning,
      retrieval: runtime.latestToolRetrieval,
      citations: [],
      availableCitations: runtime.citationRegistry.list(),
      retrievalCalls: runtime.collectRetrievalCalls(),
      toolCalls: runtime.collectToolCalls(),
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
