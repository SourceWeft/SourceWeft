import {
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { GENERATED_IMAGE_PROGRESS_EVENT_TYPE } from "@sourceweft/builtin-tool-generate-image";
import type { TraceContext } from "../../../llm-observability";
import type { PreparedThreadTurn } from "../..";
import type { DeepAgentTurnEvent } from "./events";
import {
  buildGeneratedArtifactProgressToolCallEvent,
  buildPresentationGenerationStep,
  buildPresentationProgressThinkingEvent,
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
  PUBLISH_SANDBOX_ARTIFACT_PROGRESS_EVENT_TYPE,
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
  getFilesystemToolClientMetadata,
  getFilesystemToolDescription,
  getFilesystemToolEndTitle,
  getFilesystemToolMetadata,
  getFilesystemToolOutputError,
  getFilesystemToolStartTitle,
  getWebToolEndTitle,
  getWebToolInputMetadata,
  getWebToolMetadata,
  getWebToolOutputError,
  getWebToolStartTitle,
  hasPresentationArtifactUrl,
  isPresentationArtifactInputRequiredOutput,
  normalizeToolOutputForObservability,
  redactFilesystemToolOutputForClient,
  sanitizeFilesystemToolInputForClient,
  type SkillInstructionDisplayOptions,
} from "./output-normalizer";

function getSkillInstructionDisplayOptions(
  prepared: PreparedThreadTurn,
): SkillInstructionDisplayOptions {
  const skillDisplayNamesBySlug = new Map<string, string>();
  for (const skill of prepared.enabledSkills ?? []) {
    if (skill.displayName && skill.displayName.trim().length > 0) {
      skillDisplayNamesBySlug.set(skill.name, skill.displayName.trim());
    }
  }
  return { skillDisplayNamesBySlug };
}

export async function* handleToolStartStreamChunk(input: {
  artifactIntent: PreparedThreadTurn["artifactIntent"];
  prepared: PreparedThreadTurn;
  runtime: TurnRuntime;
  snapshot: ToolsStreamToolCallSnapshot;
  traceContext?: TraceContext;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const { runtime, snapshot } = input;
  const skillDisplayOptions = getSkillInstructionDisplayOptions(input.prepared);
  const { currentToolCall, normalizedInput, toolCallId, toolName } = snapshot;
  const clientInput = sanitizeFilesystemToolInputForClient(
    toolName,
    normalizedInput,
    skillDisplayOptions,
  );

  runtime.resetReasoningBoundary();
  runtime.toolStartedAtById.set(
    toolCallId,
    snapshot.pendingStartedAt ?? Date.now(),
  );
  const nextToolCall = applyToolsStreamToolStart({
    currentToolCall,
    normalizedInput: clientInput,
    toolCallId,
    toolCallsById: runtime.toolCallsById,
    toolName,
  });
  if (hasAgentToolCapability(toolName, "generated_image_artifact")) {
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
  if (hasAgentToolCapability(toolName, "presentation_artifact")) {
    const progressEvent = normalizeGeneratedPresentationProgressEvent({
      type: PUBLISH_SANDBOX_ARTIFACT_PROGRESS_EVENT_TYPE,
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
  if (hasAgentToolCapability(toolName, "generated_image_artifact")) {
    runtime.renderBlocks.appendGeneratedImage(toolCallId);
  }
  if (
    shouldStreamVisibleToolCall &&
    !hasAgentToolCapability(toolName, "generated_image_artifact") &&
    !hasAgentToolCapability(toolName, "presentation_artifact")
  ) {
    runtime.renderBlocks.appendTool(toolCallId);
  }
  if (shouldStreamVisibleToolCall) {
    yield {
      type: "tool-call-start",
      id: toolCallId,
      tool: toolName,
      input: clientInput,
      toolCall: nextToolCall,
    };
  }
  if (hasAgentToolCapability(toolName, "presentation_artifact")) {
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep(
        buildPresentationGenerationStep({
          phase: "generating",
          tool: toolName,
          toolCallId,
        }),
      ),
    };
  }
  if (isAgentToolDomain(toolName, "retrieval")) {
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
          items: formatToolInputItems(normalizedInput, toolName),
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
          items: formatToolInputItems(normalizedInput, toolName),
          metadata: {
            toolCallId,
            tool: toolName,
          },
        }),
      };
    } else {
      const title = getFilesystemToolStartTitle(
        toolName,
        normalizedInput,
        skillDisplayOptions,
      );
      if (title) {
        yield {
          type: "thinking-step",
          step: runtime.setThinkingStep({
            id: `tool:${toolCallId}`,
            kind: "state",
            title,
            status: "in_progress",
            items: formatToolInputItems(normalizedInput, toolName),
            metadata: {
              ...getFilesystemToolClientMetadata(
                toolName,
                normalizedInput,
                skillDisplayOptions,
              ),
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
  const {
    currentToolCall,
    normalizedInput,
    toolCallId,
    toolName,
    toolPayload,
  } = snapshot;
  const toolData = redactFilesystemToolOutputForClient(
    toolName,
    normalizedInput,
    toolPayload.data,
  );
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
  const skillDisplayOptions = getSkillInstructionDisplayOptions(input.prepared);
  const {
    currentToolCall,
    normalizedInput,
    toolCallId,
    toolName,
    toolPayload,
  } = snapshot;

  runtime.resetReasoningBoundary();
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
    : normalizeToolOutputForObservability(
        toolName,
        toolPayload.output,
        normalizedInput,
      );
  const connectorContentError = getConnectorToolOutputContentError(output);
  const outputError =
    connectorContentError?.message ??
    getConnectorToolOutputError(output) ??
    getFilesystemToolOutputError(toolName, output) ??
    (isAgentToolDomain(toolName, "web") ? getWebToolOutputError(output) : null);
  const toolStatus: "completed" | "error" = outputError ? "error" : "completed";
  const nextToolCall = applyToolsStreamToolEnd({
    currentToolCall,
    error: outputError,
    latencyMs,
    normalizedInput: sanitizeFilesystemToolInputForClient(
      toolName,
      normalizedInput,
      skillDisplayOptions,
    ),
    output,
    toolCallId,
    toolCallsById: runtime.toolCallsById,
    toolName,
    toolStatus,
  });
  const completedPresentationArtifact =
    hasAgentToolCapability(toolName, "presentation_artifact") &&
    toolStatus === "completed" &&
    hasPresentationArtifactUrl(output);
  if (completedPresentationArtifact) {
    runtime.renderBlocks.appendGeneratedPresentation(toolCallId);
  }
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
  if (hasAgentToolCapability(toolName, "presentation_artifact")) {
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
          tool: toolName,
          toolCallId,
        }),
      ),
    };
  }
  if (isAgentToolDomain(toolName, "retrieval")) {
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
          items: formatToolInputItems(nextToolCall.input, toolName),
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
          items: formatToolInputItems(nextToolCall.input, toolName),
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
        skillDisplayOptions,
      );
      if (title) {
        const metadata = {
          ...getFilesystemToolClientMetadata(
            toolName,
            normalizedInput,
            skillDisplayOptions,
          ),
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
            items: formatToolInputItems(normalizedInput, toolName),
            description: getFilesystemToolDescription(
              toolName,
              metadata,
              normalizedInput,
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
  const skillDisplayOptions = getSkillInstructionDisplayOptions(input.prepared);
  const {
    currentToolCall,
    normalizedInput,
    toolCallId,
    toolName,
    toolPayload,
  } = snapshot;

  runtime.resetReasoningBoundary();
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
  const connectorContentError =
    getConnectorToolErrorTextContentError(errorText);
  const nextToolCall = applyToolsStreamToolError({
    currentToolCall: {
      ...currentToolCall,
      input: sanitizeFilesystemToolInputForClient(
        toolName,
        normalizedInput,
        skillDisplayOptions,
      ),
    },
    error: errorText,
    latencyMs,
    toolCallId,
    toolCallsById: runtime.toolCallsById,
    toolName,
  });
  if (connectorContentError) {
    throw connectorContentError;
  }
  yield {
    type: "tool-call-error",
    id: toolCallId,
    tool: toolName,
    input: sanitizeFilesystemToolInputForClient(
      toolName,
      nextToolCall.input,
      skillDisplayOptions,
    ),
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
  const title = getFilesystemToolEndTitle(
    toolName,
    normalizedInput,
    undefined,
    skillDisplayOptions,
  );
  if (webTitle) {
    yield {
      type: "thinking-step",
      step: runtime.setThinkingStep({
        id: `tool:${toolCallId}`,
        kind: "state",
        title: `${webTitle} failed`,
        status: "completed",
        items: formatToolInputItems(normalizedInput, toolName),
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
        items: formatToolInputItems(nextToolCall.input, toolName),
        description: errorText,
        metadata: {
          ...getFilesystemToolClientMetadata(
            toolName,
            normalizedInput,
            skillDisplayOptions,
          ),
          latencyMs,
          toolCallId,
          tool: toolName,
        },
      }),
    };
  }
}
