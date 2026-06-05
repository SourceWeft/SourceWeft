import { AGENT_TOOL_NAMES } from "../tool-registry";
import {
  isGeneratedImageArtifactToolName,
  isPresentationArtifactToolName,
  isRetrievalToolName,
  isVideoPresentationArtifactToolName,
  isWebToolName,
} from "../tool-registry";
import { GENERATED_IMAGE_PROGRESS_EVENT_TYPE } from "../tools/generate-image-tool";
import { GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE } from "../tools/generate-video-presentation-tool";
import {
  AGENT_TOOL_LOG_EVENTS,
  logAgentToolEvent,
  type AgentToolLogMetadata,
} from "../tools/tool-logging";
import type { TraceContext } from "../../../../shared/llm-observability";
import { endSpan, startSpan } from "../../../../shared/llm-observability";
import type { PreparedThreadTurn } from "../../threads";
import type { DeepAgentTurnEvent } from "./events";
import {
  buildGeneratedArtifactProgressToolCallEvent,
  buildPresentationGenerationStep,
  buildPresentationProgressThinkingEvent,
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
  normalizeGeneratedVideoPresentationProgressEvent,
} from "./progress-events";
import type { TurnRuntime } from "./turn-runtime";
import {
  applyToolsStreamToolEnd,
  applyToolsStreamToolError,
  applyToolsStreamToolEvent,
  applyToolsStreamToolStart,
  buildDeepAgentTodosStep,
  isDeepAgentsWriteTodosTool,
  parseDeepAgentTodos,
  type ToolsStreamToolCallSnapshot,
} from "./tool-tracker";
import {
  getMcpToolDisplayName,
  isMcpToolName,
  normalizeErrorText,
} from "./tool-utils";
import {
  compactTraceText,
  formatToolInputItems,
  getConnectorToolErrorTextContentError,
  getConnectorToolOutputContentError,
  getConnectorToolOutputError,
  getFilesystemToolDescription,
  getFilesystemToolEndTitle,
  getFilesystemToolMetadata,
  getFilesystemToolStartTitle,
  getWebToolEndTitle,
  getWebToolInputMetadata,
  getWebToolMetadata,
  getWebToolOutputError,
  getWebToolStartTitle,
  hasPresentationArtifactUrl,
  isPresentationArtifactInputRequiredOutput,
  normalizeToolOutputForObservability,
} from "./output-normalizer";

function buildAgentToolLogMetadata(input: {
  prepared: PreparedThreadTurn;
  toolName: string;
  toolCallId: string;
  durationMs?: number | null;
  error?: unknown;
  status?: string;
}): AgentToolLogMetadata {
  return {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    threadId: input.prepared.thread.id,
    userMessageId: input.prepared.userMessage.id,
    workspaceId: input.prepared.workspace.id,
    teamId: input.prepared.workspace.organizationId,
    userId: input.prepared.userId,
    durationMs: input.durationMs ?? undefined,
    error: input.error,
    status: input.status,
  };
}

export async function* handleToolStartStreamChunk(input: {
  artifactIntent: PreparedThreadTurn["artifactIntent"];
  prepared: PreparedThreadTurn;
  runtime: TurnRuntime;
  snapshot: ToolsStreamToolCallSnapshot;
  traceContext?: TraceContext;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { runtime, snapshot } = input;
  const {
    currentToolCall,
    normalizedInput,
    toolCallId,
    toolName,
  } = snapshot;

  runtime.currentReasoningSegment = null;
  runtime.toolStartedAtById.set(toolCallId, Date.now());
  logAgentToolEvent(
    "info",
    AGENT_TOOL_LOG_EVENTS.started,
    buildAgentToolLogMetadata({
      prepared: input.prepared,
      toolCallId,
      toolName,
      status: "running",
    }),
  );
  if (input.traceContext) {
    await startSpan({
      ...input.traceContext,
      spanId: toolCallId,
      parentSpanId: input.traceContext.parentSpanId,
      name: `tool:${toolName}`,
      kind: "tool",
      operation: "tool.call",
      input: normalizedInput,
      metadata: {
        toolName,
        sequence: currentToolCall.sequence,
      },
    });
  }
  const nextToolCall = applyToolsStreamToolStart({
    currentToolCall,
    normalizedInput,
    toolCallId,
    toolCallsById: runtime.toolCallsById,
    toolName,
  });
  if (isGeneratedImageArtifactToolName(toolName)) {
    const progressEvent = normalizeGeneratedImageProgressEvent({
      type: GENERATED_IMAGE_PROGRESS_EVENT_TYPE,
      toolCallId,
      tool: toolName,
      stage: "preparing",
      ...(typeof normalizedInput.title === "string" &&
      normalizedInput.title.trim().length > 0
        ? { title: normalizedInput.title.trim() }
        : {}),
      ...(input.artifactIntent?.kind === "image"
        ? {
            aspectRatio: input.artifactIntent.config?.aspectRatio,
            quality: input.artifactIntent.config?.quality,
            style: input.artifactIntent.config?.style,
          }
        : {}),
    });
    if (progressEvent) {
      const toolCallEvent = buildGeneratedArtifactProgressToolCallEvent({
        progressEvent,
        toolCallsById: runtime.toolCallsById,
      });
      if (toolCallEvent) {
        yield toolCallEvent;
      }
    }
  }
  if (isPresentationArtifactToolName(toolName)) {
    const progressEvent = normalizeGeneratedPresentationProgressEvent({
      type: "generate_pptx_progress",
      toolCallId,
      tool: toolName,
      stage: "planning",
      ...(typeof normalizedInput.title === "string" &&
      normalizedInput.title.trim().length > 0
        ? { title: normalizedInput.title.trim() }
        : {}),
    });
    if (progressEvent) {
      const toolCallEvent = buildGeneratedArtifactProgressToolCallEvent({
        progressEvent,
        toolCallsById: runtime.toolCallsById,
      });
      if (toolCallEvent) {
        yield toolCallEvent;
      }
      const progressThinkingEvent = buildPresentationProgressThinkingEvent({
        progressEvent,
        setThinkingStep: runtime.setThinkingStep,
      });
      if (progressThinkingEvent) {
        yield progressThinkingEvent;
      }
    }
  }
  if (isVideoPresentationArtifactToolName(toolName)) {
    const progressEvent = normalizeGeneratedVideoPresentationProgressEvent({
      type: GENERATED_VIDEO_PRESENTATION_PROGRESS_EVENT_TYPE,
      toolCallId,
      tool: toolName,
      stage: "planning",
      ...(typeof normalizedInput.title === "string" &&
      normalizedInput.title.trim().length > 0
        ? { title: normalizedInput.title.trim() }
        : {}),
    });
    if (progressEvent) {
      const toolCallEvent = buildGeneratedArtifactProgressToolCallEvent({
        progressEvent,
        toolCallsById: runtime.toolCallsById,
      });
      if (toolCallEvent) {
        yield toolCallEvent;
      }
    }
  }
  const shouldStreamVisibleToolCall = !isDeepAgentsWriteTodosTool(toolName);
  if (runtime.hasTextSinceLastToolBoundary && shouldStreamVisibleToolCall) {
    yield {
      type: "text-interrupted",
      reason: "tool-call",
      toolCallId,
      tool: toolName,
    };
    runtime.assistantContent += "\n";
    runtime.renderBlocks.appendText("\n");
    yield {
      type: "text-delta",
      delta: "\n",
    };
    runtime.hasTextSinceLastToolBoundary = false;
  }
  if (isGeneratedImageArtifactToolName(toolName)) {
    runtime.renderBlocks.appendGeneratedImage(toolCallId);
  }
  if (
    isPresentationArtifactToolName(toolName) ||
    isVideoPresentationArtifactToolName(toolName)
  ) {
    runtime.renderBlocks.appendGeneratedPresentation(toolCallId);
  }
  if (
    shouldStreamVisibleToolCall &&
    !isGeneratedImageArtifactToolName(toolName) &&
    !isPresentationArtifactToolName(toolName) &&
    !isVideoPresentationArtifactToolName(toolName)
  ) {
    runtime.renderBlocks.appendTool(toolCallId);
  }
  if (shouldStreamVisibleToolCall) {
    yield {
      type: "tool-call-start",
      id: toolCallId,
      tool: toolName,
      input: normalizedInput,
      toolCall: nextToolCall,
    };
  }
  if (toolName === AGENT_TOOL_NAMES.generatePptx) {
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep(
        buildPresentationGenerationStep({
          phase: "generating",
          toolCallId,
        }),
      ),
    };
  }
  if (isRetrievalToolName(toolName)) {
    const query =
      typeof normalizedInput.query === "string"
        ? normalizedInput.query.trim()
        : "";
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep({
        id: `${toolName}:${toolCallId}`,
        kind: "state",
        title: "Searching sources",
        status: "in_progress",
        items: [],
        description:
          query.length > 0 ? `Query: ${compactTraceText(query)}` : undefined,
        metadata: {
          toolCallId,
          tool: toolName,
        },
      }),
    };
  } else {
    const webTitle = getWebToolStartTitle(toolName);
    if (webTitle) {
      const metadata = {
        ...getWebToolInputMetadata(toolName, normalizedInput),
        toolCallId,
        tool: toolName,
      };
      yield {
        type: "thinking-step",
        step: runtime.setThinkingStep({
          id: `tool:${toolCallId}`,
          kind: "state",
          title: webTitle,
          status: "in_progress",
          items: formatToolInputItems(normalizedInput),
          metadata: {
            ...metadata,
          },
        }),
      };
    } else if (isMcpToolName(toolName)) {
      yield {
        type: "thinking-step",
        step: runtime.setThinkingStep({
          id: `tool:${toolCallId}`,
          kind: "state",
          title: `Calling MCP ${getMcpToolDisplayName(toolName)}`,
          status: "in_progress",
          items: formatToolInputItems(normalizedInput),
          metadata: {
            toolCallId,
            tool: toolName,
          },
        }),
      };
    } else {
      const title = getFilesystemToolStartTitle(toolName, normalizedInput);
      if (title) {
        yield {
          type: "thinking-step",
          step: runtime.setThinkingStep({
            id: `tool:${toolCallId}`,
            kind: "state",
            title,
            status: "in_progress",
            items: formatToolInputItems(normalizedInput),
            metadata: {
              toolCallId,
              tool: toolName,
            },
          }),
        };
      }
    }
  }
}

export async function* handleToolEventStreamChunk(input: {
  runtime: TurnRuntime;
  snapshot: ToolsStreamToolCallSnapshot;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { runtime, snapshot } = input;
  const { currentToolCall, toolCallId, toolName, toolPayload } = snapshot;
  const toolData = toolPayload.data;
  const nextToolCall = applyToolsStreamToolEvent({
    currentToolCall,
    output: toolData,
    toolCallId,
    toolCallsById: runtime.toolCallsById,
    toolName,
  });
  if (isDeepAgentsWriteTodosTool(toolName)) {
    return;
  }
  yield {
    type: "tool-call-event",
    id: toolCallId,
    tool: toolName,
    data: toolData,
    toolCall: nextToolCall,
  };
}

export async function* handleToolEndStreamChunk(input: {
  prepared: PreparedThreadTurn;
  runtime: TurnRuntime;
  snapshot: ToolsStreamToolCallSnapshot;
  traceContext?: TraceContext;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { runtime, snapshot } = input;
  const {
    currentToolCall,
    normalizedInput,
    toolCallId,
    toolName,
    toolPayload,
  } = snapshot;

  runtime.currentReasoningSegment = null;
  runtime.nextReasoningContext = {
    phase: "after_tool",
    toolCallId,
    tool: toolName,
  };
  const retrievalCall = runtime.retrievalCallsById.get(toolCallId);
  const startedAt = runtime.toolStartedAtById.get(toolCallId);
  const measuredLatency =
    typeof startedAt === "number" ? Date.now() - startedAt : null;
  const latencyMs = retrievalCall?.latencyMs ?? measuredLatency;
  const output = retrievalCall
    ? {
        query: retrievalCall.query,
        hitCount: retrievalCall.hitCount,
      }
    : normalizeToolOutputForObservability(toolName, toolPayload.output);
  const connectorContentError = getConnectorToolOutputContentError(output);
  const outputError =
    connectorContentError?.message ??
    getConnectorToolOutputError(output) ??
    (isWebToolName(toolName) ? getWebToolOutputError(output) : null);
  const toolStatus: "completed" | "error" = outputError
    ? "error"
    : "completed";
  if (toolStatus === "completed") {
    logAgentToolEvent(
      "info",
      AGENT_TOOL_LOG_EVENTS.completed,
      buildAgentToolLogMetadata({
        durationMs: latencyMs,
        prepared: input.prepared,
        status: toolStatus,
        toolCallId,
        toolName,
      }),
    );
  } else {
    logAgentToolEvent(
      "error",
      AGENT_TOOL_LOG_EVENTS.failed,
      buildAgentToolLogMetadata({
        durationMs: latencyMs,
        error: outputError,
        prepared: input.prepared,
        status: toolStatus,
        toolCallId,
        toolName,
      }),
    );
  }
  const nextToolCall = applyToolsStreamToolEnd({
    currentToolCall,
    error: outputError,
    latencyMs,
    normalizedInput,
    output,
    toolCallId,
    toolCallsById: runtime.toolCallsById,
    toolName,
    toolStatus,
  });
  const deepAgentTodos = isDeepAgentsWriteTodosTool(toolName)
    ? parseDeepAgentTodos(nextToolCall.input)
    : [];
  if (deepAgentTodos.length > 0) {
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep(
        buildDeepAgentTodosStep({
          toolCallId,
          todos: deepAgentTodos,
        }),
      ),
    };
  }
  if (input.traceContext) {
    await endSpan({
      traceId: input.traceContext.traceId,
      teamId: input.traceContext.teamId,
      workspaceId: input.traceContext.workspaceId,
      spanId: toolCallId,
      status: toolStatus === "error" ? "error" : "ok",
      latencyMs,
      output,
      ...(outputError ? { errorMessage: outputError } : {}),
      metadata: {
        toolName,
        ...(retrievalCall
          ? {
              query: retrievalCall.query,
              hitCount: retrievalCall.hitCount,
            }
          : {}),
      },
    });
  }
  if (connectorContentError) {
    throw connectorContentError;
  }
  if (toolStatus === "completed") {
    yield {
      type: "tool-call-result",
      id: toolCallId,
      tool: toolName,
      input: nextToolCall.input,
      output,
      latencyMs,
      toolCall: nextToolCall,
      ...(retrievalCall
        ? {
            query: retrievalCall.query,
            hitCount: retrievalCall.hitCount,
          }
        : {}),
    };
  }
  if (toolStatus === "error" && outputError) {
    yield {
      type: "tool-call-error",
      id: toolCallId,
      tool: toolName,
      input: nextToolCall.input,
      error: outputError,
      latencyMs,
      toolCall: nextToolCall,
    };
  }
  if (isDeepAgentsWriteTodosTool(toolName)) {
    return;
  }
  yield {
    type: "tool-call-end",
    id: toolCallId,
    tool: toolName,
    latencyMs,
    status: toolStatus,
    toolCall: nextToolCall,
  };
  if (toolName === AGENT_TOOL_NAMES.generatePptx) {
    const completed = toolStatus === "completed";
    const hasArtifact = completed && hasPresentationArtifactUrl(output);
    const needsContent =
      completed && isPresentationArtifactInputRequiredOutput(output);
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep(
        buildPresentationGenerationStep({
          error: outputError,
          latencyMs,
          phase: hasArtifact
            ? "completed"
            : needsContent
              ? "repairing"
              : "failed",
          toolCallId,
        }),
      ),
    };
  }
  if (isRetrievalToolName(toolName)) {
    const query = retrievalCall?.query ?? "";
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep({
        id: `${toolName}:${toolCallId}`,
        kind: "state",
        title: "Searching sources",
        status: "completed",
        items: [],
        description:
          typeof retrievalCall?.hitCount === "number"
            ? `Found ${retrievalCall.hitCount} relevant chunks.`
            : undefined,
        metadata: {
          query,
          hitCount: retrievalCall?.hitCount,
          latencyMs,
          toolCallId,
          tool: toolName,
        },
      }),
    };
  } else {
    const webTitle = getWebToolEndTitle(toolName);
    if (webTitle) {
      const metadata: Record<string, unknown> = {
        ...getWebToolInputMetadata(toolName, nextToolCall.input),
        ...getWebToolMetadata(toolPayload.output),
        latencyMs,
        toolCallId,
        tool: toolName,
      };
      yield {
        type: "thinking-step",
        step: runtime.setThinkingStep({
          id: `tool:${toolCallId}`,
          kind: "state",
          title: toolStatus === "error" ? `${webTitle} failed` : webTitle,
          status: "completed",
          items: formatToolInputItems(nextToolCall.input),
          description: outputError ?? undefined,
          metadata,
        }),
      };
    } else if (isMcpToolName(toolName)) {
      yield {
        type: "thinking-step",
        step: runtime.setThinkingStep({
          id: `tool:${toolCallId}`,
          kind: "state",
          title:
            toolStatus === "error"
              ? `MCP ${getMcpToolDisplayName(toolName)} failed`
              : `Called MCP ${getMcpToolDisplayName(toolName)}`,
          status: "completed",
          items: formatToolInputItems(nextToolCall.input),
          description: outputError ?? undefined,
          metadata: {
            latencyMs,
            toolCallId,
            tool: toolName,
          },
        }),
      };
    } else {
      const title = getFilesystemToolEndTitle(
        toolName,
        nextToolCall.input,
        output,
      );
      if (title) {
        const metadata = {
          ...getFilesystemToolMetadata(toolName, output),
          latencyMs,
          toolCallId,
          tool: toolName,
        };
        yield {
          type: "thinking-step",
          step: runtime.setThinkingStep({
            id: `tool:${toolCallId}`,
            kind: "state",
            title,
            status: "completed",
            items: formatToolInputItems(nextToolCall.input),
            description: getFilesystemToolDescription(
              toolName,
              metadata,
              nextToolCall.input,
            ),
            metadata,
          }),
        };
      }
    }
  }
  const citationSnapshot = runtime.getNewCitationSnapshot();
  if (citationSnapshot) {
    yield {
      type: "citations",
      citations: citationSnapshot,
    };
  }
}

export async function* handleToolErrorStreamChunk(input: {
  prepared: PreparedThreadTurn;
  runtime: TurnRuntime;
  snapshot: ToolsStreamToolCallSnapshot;
  traceContext?: TraceContext;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { runtime, snapshot } = input;
  const { currentToolCall, toolCallId, toolName, toolPayload } = snapshot;

  runtime.currentReasoningSegment = null;
  runtime.nextReasoningContext = {
    phase: "after_tool",
    toolCallId,
    tool: toolName,
  };
  const startedAt = runtime.toolStartedAtById.get(toolCallId);
  const latencyMs =
    typeof startedAt === "number"
      ? Date.now() - startedAt
      : currentToolCall.latencyMs;
  const errorText = normalizeErrorText(toolPayload.error);
  const connectorContentError = getConnectorToolErrorTextContentError(errorText);
  logAgentToolEvent(
    "error",
    AGENT_TOOL_LOG_EVENTS.failed,
    buildAgentToolLogMetadata({
      durationMs: latencyMs,
      error: errorText,
      prepared: input.prepared,
      status: "error",
      toolCallId,
      toolName,
    }),
  );
  const nextToolCall = applyToolsStreamToolError({
    currentToolCall,
    error: errorText,
    latencyMs,
    toolCallId,
    toolCallsById: runtime.toolCallsById,
    toolName,
  });
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
        toolName,
      },
    });
  }
  if (connectorContentError) {
    throw connectorContentError;
  }
  yield {
    type: "tool-call-error",
    id: toolCallId,
    tool: toolName,
    input: nextToolCall.input,
    error: errorText,
    latencyMs,
    toolCall: nextToolCall,
  };
  yield {
    type: "tool-call-end",
    id: toolCallId,
    tool: toolName,
    latencyMs,
    status: "error",
    toolCall: nextToolCall,
  };
  const webTitle = getWebToolEndTitle(toolName);
  const title = getFilesystemToolEndTitle(toolName, nextToolCall.input);
  if (webTitle) {
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep({
        id: `tool:${toolCallId}`,
        kind: "state",
        title: `${webTitle} failed`,
        status: "completed",
        items: formatToolInputItems(nextToolCall.input),
        description: errorText,
        metadata: {
          latencyMs,
          toolCallId,
          tool: toolName,
        },
      }),
    };
  } else if (title) {
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep({
        id: `tool:${toolCallId}`,
        kind: "state",
        title: `${title} failed`,
        status: "completed",
        items: formatToolInputItems(nextToolCall.input),
        description: errorText,
        metadata: {
          latencyMs,
          toolCallId,
          tool: toolName,
        },
      }),
    };
  }
}
