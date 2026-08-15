/**
 * Stream handler for proactive `askUser` questions.
 *
 * When the askUser tool calls `interrupt()`, the turn's `updates` stream carries
 * an `__interrupt__` whose value is an {@link AskUserInterruptValue} (discriminated
 * by `type:"ask_user"`, NOT the approval-shaped `{actionRequests,reviewConfigs}`).
 * The runner routes those here instead of to the approval handler.
 *
 * This surfaces the question on the existing tool-confirmation SSE channel (a
 * sibling `agentQuestionRequestSchema` forwarded verbatim by the event mapper),
 * then ends the turn with `finishReason:"user_question_requested"` bound to the
 * interrupt checkpoint. The answer resumes via the same replay route as
 * approvals — see `commandResumeFromToolApprovalResume`'s `askUser` branch.
 */

import type { AgentQuestionRequest } from "@sourceweft/contracts";
import type { AgentCheckpointRef, ToolCallTrace } from "../..";
import { finalizeMessageRenderBlocks } from "../../turn/render-blocks";
import { logger } from "../../../../shared/logger";
import {
  resolveHitlInterruptCheckpoint,
  resolvePendingInterruptCheckpoint,
  type AgentRunnableConfig,
} from "./checkpoint";
import type { DeepAgentTurnEvent } from "./events";
import { listThinkingSteps } from "./thinking";
import type { TurnRuntime } from "./turn-runtime";
import type { createThreadAgent } from "..";
import {
  isAskUserInterruptValue,
  type AskUserInterruptValue,
} from "../middleware/ask-user";

type Agent = Awaited<ReturnType<typeof createThreadAgent>>;

export const USER_QUESTION_FINISH_REASON = "user_question_requested";

export type AskUserStreamHandlerResult =
  | { kind: "continue" }
  | { kind: "done" };

type ExtractedAskUserInterrupt = {
  value: AskUserInterruptValue;
  interruptId?: string;
};

/** Pull ask_user interrupts (and their langgraph interrupt ids) from a payload. */
export function extractAskUserInterrupts(
  payload: unknown,
): ExtractedAskUserInterrupt[] {
  const interrupts = (payload as { __interrupt__?: unknown })?.__interrupt__;
  if (!Array.isArray(interrupts)) {
    return [];
  }
  const result: ExtractedAskUserInterrupt[] = [];
  for (const entry of interrupts) {
    const value = (entry as { value?: unknown })?.value;
    if (!isAskUserInterruptValue(value)) {
      continue;
    }
    const rawId = (entry as { id?: unknown })?.id;
    const interruptId =
      typeof rawId === "string" && rawId.trim().length > 0
        ? rawId.trim()
        : undefined;
    result.push(interruptId ? { value, interruptId } : { value });
  }
  return result;
}

/**
 * Stable, payload-derived id for a question request. Mirrors the HITL approach
 * (bind by interrupt/checkpoint identity, never by a transient tool-call id) so
 * a question raised inside a sub-agent subgraph could still be correlated.
 */
function askUserRequestId(input: {
  checkpointId: string;
  toolCallId: string;
  interruptId?: string;
}): string {
  return `askq:${input.interruptId ?? input.checkpointId}:${input.toolCallId}`;
}

export async function* handleAskUserStreamChunk(input: {
  agent: Agent;
  beforeInputCheckpoint: AgentCheckpointRef | null;
  finalCheckpoint: AgentCheckpointRef | null;
  payload: unknown;
  runConfig: AgentRunnableConfig;
  runtime: TurnRuntime;
  threadId: string;
  userId: string;
  workspaceId: string;
}): AsyncGenerator<DeepAgentTurnEvent, AskUserStreamHandlerResult> {
  const { runtime } = input;
  const askUserInterrupts = extractAskUserInterrupts(input.payload);
  if (askUserInterrupts.length === 0) {
    return { kind: "continue" };
  }

  // Close any open assistant text so the question renders on its own boundary.
  runtime.resetReasoningBoundary();
  if (runtime.hasTextSinceLastToolBoundary) {
    yield {
      type: "text-interrupted",
      reason: "tool-call",
      toolCallId: "user_question",
      tool: "user_question",
    };
    runtime.assistantContent += "\n";
    runtime.renderBlocks.appendText("\n");
    yield { type: "text-delta", delta: "\n" };
    runtime.hasTextSinceLastToolBoundary = false;
  }

  const interruptCheckpoint = await resolvePendingInterruptCheckpoint({
    agent: input.agent,
    config: input.runConfig,
  });
  const askUserCheckpoint = resolveHitlInterruptCheckpoint({
    pendingCheckpoint: interruptCheckpoint,
    observedCheckpoint: input.finalCheckpoint,
  });
  if (!askUserCheckpoint) {
    // No checkpoint to bind the answer to — cannot resume. Surface as an error
    // rather than silently stranding the turn (the pre-fix failure mode).
    logger.error("askUser interrupt had no pending checkpoint to bind", {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
    });
    return { kind: "continue" };
  }

  for (const { value, interruptId } of askUserInterrupts) {
    const toolCallId = value.toolCallId || "user_question";
    const requestId = askUserRequestId({
      checkpointId: askUserCheckpoint.checkpointId,
      toolCallId,
      interruptId,
    });
    const request: AgentQuestionRequest = {
      type: "user_question_request",
      schemaVersion: 1,
      id: requestId,
      toolCallId,
      questions: value.questions,
    };
    const input_ = { questions: value.questions } as Record<string, unknown>;
    const sequence =
      runtime.toolCallsById.get(toolCallId)?.sequence ??
      runtime.resolveToolCallSequence(toolCallId);
    const toolCall: ToolCallTrace = {
      id: toolCallId,
      tool: "askUser",
      input: input_,
      output: request,
      status: "approval_requested",
      latencyMs: 0,
      error: null,
      sequence,
    };
    if (!runtime.toolCallsById.has(toolCallId)) {
      runtime.toolCallOrder.push(toolCallId);
    }
    runtime.toolCallsById.set(toolCallId, toolCall);
    runtime.renderBlocks.appendTool(toolCallId);

    yield {
      type: "tool-call-start",
      id: toolCallId,
      tool: "askUser",
      input: input_,
      toolCall: { ...toolCall, output: null, status: "running" },
    };
    yield {
      type: "tool-call-result",
      id: toolCallId,
      tool: "askUser",
      input: input_,
      output: request,
      latencyMs: 0,
      toolCall,
    };
    yield {
      type: "tool-call-end",
      id: toolCallId,
      tool: "askUser",
      latencyMs: 0,
      status: "approval_requested",
      toolCall,
    };
    logger.info("Agent turn paused for askUser question", {
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      toolCallId,
      questionId: requestId,
    });
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
      finishReason: USER_QUESTION_FINISH_REASON,
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
        beforeAssistant: askUserCheckpoint,
        resume: askUserCheckpoint,
        final: askUserCheckpoint,
      },
    },
  };
  return { kind: "done" };
}
