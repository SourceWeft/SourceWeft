import { AGENT_TOOL_NAMES } from "../tool-registry";
import type { TraceContext } from "../../../../shared/llm-observability";
import { endSpan, startSpan } from "../../../../shared/llm-observability";
import type { CommandSuccessCriteria, PreparedThreadTurn, ToolCallTrace } from "../../threads";
import { createMessageRenderBlockBuilder, finalizeMessageRenderBlocks } from "../../threads/turn/render-blocks";
import type { DeepAgentTurnEvent, DeepAgentTurnOutcome } from "./events";
import { sanitizeSseValue } from "./content";
import { normalizeErrorText, resolveToolCallId } from "./tool-utils";
import {
  compactTraceText,
  normalizeToolOutputForObservability,
} from "./output-normalizer";
import { GENERATED_IMAGE_PROGRESS_EVENT_TYPE } from "../tools/generate-image-tool";
import type { createGenerateImageTool } from "../tools/generate-image-tool";

export type ResolvedDirectImageToolCommand = {
  name: typeof AGENT_TOOL_NAMES.generateImage;
  prompt: string;
};

export type ResolvedDirectToolCommand = ResolvedDirectImageToolCommand;

export function resolveDirectToolCommand(
  input: PreparedThreadTurn,
): ResolvedDirectImageToolCommand | null {
  if (
    input.command?.kind === "tool" &&
    input.command.toolName === AGENT_TOOL_NAMES.generateImage &&
    input.command.workflow?.execution === "direct" &&
    input.generateImageTool?.mode === "generate" &&
    input.artifactIntent.shouldInjectTool &&
    input.imageProfile
  ) {
    return {
      name: AGENT_TOOL_NAMES.generateImage,
      prompt: input.command.arguments?.trim() || input.messageContent.trim(),
    };
  }

  return null;
}

type GenerateImageToolInvoker = ReturnType<typeof createGenerateImageTool>;

export async function* runDirectToolCommand(input: Omit<
  Parameters<typeof runDirectGenerateImageCommand>[0],
  "generateImageTool" | "toolCommand"
> & {
  artifactTools: GenerateImageToolInvoker[];
  toolCommand: ResolvedDirectToolCommand;
}): AsyncGenerator<DeepAgentTurnEvent> {
  if (input.toolCommand.name === AGENT_TOOL_NAMES.generateImage) {
    yield* runDirectGenerateImageCommand({
      ...input,
      generateImageTool: input.artifactTools.find(
        (candidate) => candidate.name === AGENT_TOOL_NAMES.generateImage,
      ),
      toolCommand: input.toolCommand,
    });
  }
}

type GeneratedImageProgressEvent = {
  toolCallId: string;
  tool: string;
  data: Record<string, unknown>;
};

export async function* runDirectGenerateImageCommand(input: {
  commandSuccessFailureText: (
    criteria: CommandSuccessCriteria,
    toolCalls?: ToolCallTrace[],
  ) => string;
  generateImageTool: GenerateImageToolInvoker | undefined;
  normalizeGeneratedImageProgressEvent: (
    payload: unknown,
  ) => GeneratedImageProgressEvent | null;
  prepared: PreparedThreadTurn;
  reasoningSegments: DeepAgentTurnOutcome["reasoningSegments"];
  resolveToolCallSequence: (toolCallId: string) => number;
  isCommandSuccessSatisfied: (input: {
    criteria: CommandSuccessCriteria;
    toolCalls: ToolCallTrace[];
  }) => boolean;
  toolCommand: ResolvedDirectImageToolCommand;
  traceContext?: TraceContext;
  usage: DeepAgentTurnOutcome["usage"];
}): AsyncGenerator<DeepAgentTurnEvent> {
  const renderBlocks = createMessageRenderBlockBuilder();
  const { generateImageTool, toolCommand } = input;
  if (!generateImageTool || toolCommand.prompt.length === 0) {
    const errorText = !generateImageTool
      ? "Image generation is not available for this turn."
      : "Image prompt is empty.";
    renderBlocks.appendText(errorText);
    yield {
      type: "text-delta",
      delta: sanitizeSseValue(errorText),
    };
    yield {
      type: "done",
      outcome: {
        assistantContent: errorText,
        usage: input.usage,
        retrieval: null,
        citations: [],
        availableCitations: [],
        retrievalCalls: [],
        toolCalls: [],
        renderBlocks: finalizeMessageRenderBlocks({
          blocks: renderBlocks.list(),
          finalText: errorText,
        }),
        thinkingSteps: [],
        reasoningSegments: input.reasoningSegments,
        agentCheckpoint: {
          beforeInput: null,
          beforeAssistant: null,
          resume: null,
          final: null,
        },
      },
    };
    return;
  }

  const toolCallId = resolveToolCallId({
    toolName: AGENT_TOOL_NAMES.generateImage,
    fallbackIndex: 1,
  });
  const normalizedInput = {
    prompt: toolCommand.prompt,
    title: compactTraceText(toolCommand.prompt, 80),
  };
  const startedAt = Date.now();
  const imageConfig =
    input.prepared.artifactIntent.kind === "image"
      ? input.prepared.artifactIntent.config
      : null;
  const initialToolCall: ToolCallTrace = {
    id: toolCallId,
    tool: AGENT_TOOL_NAMES.generateImage,
    input: normalizedInput,
    output: null,
    status: "running",
    latencyMs: null,
    error: null,
    sequence: input.resolveToolCallSequence(toolCallId),
  };
  if (input.traceContext) {
    await startSpan({
      ...input.traceContext,
      spanId: toolCallId,
      parentSpanId: input.traceContext.parentSpanId,
      name: `tool:${AGENT_TOOL_NAMES.generateImage}`,
      kind: "tool",
      operation: "tool.call",
      input: normalizedInput,
      metadata: {
        toolName: AGENT_TOOL_NAMES.generateImage,
        sequence: initialToolCall.sequence,
        source: "slash_command",
      },
    });
  }
  renderBlocks.appendGeneratedImage(toolCallId);
  yield {
    type: "tool-call-start",
    id: toolCallId,
    tool: AGENT_TOOL_NAMES.generateImage,
    input: normalizedInput,
    toolCall: initialToolCall,
  };

  let finalToolCall = initialToolCall;
  const emitDirectProgress = (
    stage: "preparing" | "generating" | "ready",
    metadata?: Record<string, unknown>,
  ) => {
    const progressEvent = input.normalizeGeneratedImageProgressEvent({
      type: GENERATED_IMAGE_PROGRESS_EVENT_TYPE,
      toolCallId,
      tool: AGENT_TOOL_NAMES.generateImage,
      prompt: normalizedInput.prompt,
      stage,
      title: normalizedInput.title,
      ...(imageConfig
        ? {
            aspectRatio: imageConfig.aspectRatio,
            quality: imageConfig.quality,
            style: imageConfig.style,
          }
        : {}),
      ...metadata,
    });
    if (!progressEvent) {
      return undefined;
    }
    const nextToolCall: ToolCallTrace = {
      ...finalToolCall,
      output: progressEvent.data,
      status: stage === "ready" ? finalToolCall.status : "running",
      error: null,
    };
    finalToolCall = nextToolCall;
    return {
      type: "tool-call-event" as const,
      id: toolCallId,
      tool: AGENT_TOOL_NAMES.generateImage,
      data: progressEvent.data,
      toolCall: nextToolCall,
    };
  };
  const preparingEvent = emitDirectProgress("preparing");
  if (preparingEvent) {
    yield preparingEvent;
  }
  try {
    const generatingEvent = emitDirectProgress("generating", {
      providerModel:
        input.prepared.generateImageTool?.execution?.providerModel ??
        input.prepared.generateImageTool?.execution?.modelAlias ??
        input.prepared.imageProfile?.profile.modelAlias,
    });
    if (generatingEvent) {
      yield generatingEvent;
    }
    const output = await generateImageTool.invoke(normalizedInput, {
      toolCall: { id: toolCallId },
    } as never);
    const latencyMs = Date.now() - startedAt;
    const normalizedOutput = normalizeToolOutputForObservability(
      AGENT_TOOL_NAMES.generateImage,
      output,
    );
    finalToolCall = {
      ...finalToolCall,
      output: normalizedOutput,
      status: "completed",
      latencyMs,
      error: null,
    };
    const readyEvent = emitDirectProgress("ready");
    if (readyEvent) {
      finalToolCall = {
        ...readyEvent.toolCall,
        output: normalizedOutput,
        status: "completed",
        latencyMs,
        error: null,
      };
      yield {
        ...readyEvent,
        toolCall: finalToolCall,
      };
    }
    if (input.traceContext) {
      await endSpan({
        traceId: input.traceContext.traceId,
        teamId: input.traceContext.teamId,
        workspaceId: input.traceContext.workspaceId,
        spanId: toolCallId,
        status: "ok",
        latencyMs,
        output: normalizedOutput,
        metadata: {
          toolName: AGENT_TOOL_NAMES.generateImage,
          source: "slash_command",
        },
      });
    }
    yield {
      type: "tool-call-result",
      id: toolCallId,
      tool: AGENT_TOOL_NAMES.generateImage,
      input: normalizedInput,
      output: normalizedOutput,
      latencyMs,
      toolCall: finalToolCall,
    };
    yield {
      type: "tool-call-end",
      id: toolCallId,
      tool: AGENT_TOOL_NAMES.generateImage,
      latencyMs,
      status: "completed",
      toolCall: finalToolCall,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const errorText = normalizeErrorText(error);
    finalToolCall = {
      ...initialToolCall,
      status: "error",
      latencyMs,
      error: errorText,
    };
    if (input.traceContext) {
      await endSpan({
        traceId: input.traceContext.traceId,
        teamId: input.traceContext.teamId,
        workspaceId: input.traceContext.workspaceId,
        spanId: toolCallId,
        status: "error",
        latencyMs,
        errorMessage: errorText,
        metadata: {
          toolName: AGENT_TOOL_NAMES.generateImage,
          source: "slash_command",
        },
      });
    }
    yield {
      type: "tool-call-error",
      id: toolCallId,
      tool: AGENT_TOOL_NAMES.generateImage,
      input: normalizedInput,
      error: errorText,
      latencyMs,
      toolCall: finalToolCall,
    };
    yield {
      type: "tool-call-end",
      id: toolCallId,
      tool: AGENT_TOOL_NAMES.generateImage,
      latencyMs,
      status: "error",
      toolCall: finalToolCall,
    };
  }

  const commandSatisfied = input.isCommandSuccessSatisfied({
    criteria: input.prepared.commandSuccessCriteria,
    toolCalls: [finalToolCall],
  });
  const assistantText = commandSatisfied
    ? "Image artifact created."
    : finalToolCall.error
      ? `Command failed because ${finalToolCall.error}`
      : input.commandSuccessFailureText(input.prepared.commandSuccessCriteria, [
          finalToolCall,
        ]);
  renderBlocks.appendText(assistantText);
  if (!commandSatisfied) {
    yield {
      type: "text-delta",
      delta: sanitizeSseValue(assistantText),
    };
  }
  const finalRenderBlocks = finalizeMessageRenderBlocks({
    blocks: renderBlocks.list(),
    finalText: assistantText,
  });
  yield {
    type: "done",
    outcome: {
      assistantContent: assistantText,
      usage: input.usage,
      retrieval: null,
      citations: [],
      availableCitations: [],
      retrievalCalls: [],
      toolCalls: [finalToolCall],
      ...(commandSatisfied
        ? {}
        : { finishReason: "command_success_criteria_failed" }),
      ...(finalRenderBlocks.length > 0 ? { renderBlocks: finalRenderBlocks } : {}),
      thinkingSteps: [],
      reasoningSegments: input.reasoningSegments,
      agentCheckpoint: {
        beforeInput: null,
        beforeAssistant: null,
        resume: null,
        final: null,
      },
    },
  };
}
