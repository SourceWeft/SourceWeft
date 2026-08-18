import {
  getAgentToolPresentation,
  getAgentToolTurnPreflight,
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import type { TraceContext } from "../../../llm-observability";
import type { PreparedThreadTurn } from "../..";
import type { DeepAgentTurnEvent } from "./events";
import {
  buildGeneratedArtifactProgressToolCallEvent,
  buildArtifactGenerationStep,
  buildPresentationProgressThinkingEvent,
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
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
  appendSandboxOperationTimeline,
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
  getArtifactProgressToolOutputError,
  getWebToolEndTitle,
  getWebToolInputMetadata,
  getWebToolMetadata,
  getWebToolOutputError,
  getWebToolStartTitle,
  extractToolOutputField,
  normalizeToolOutputForObservability,
  isSandboxOperationTimelineTool,
  redactFilesystemToolOutputForClient,
  sanitizeFilesystemToolInputForClient,
  type SkillInstructionDisplayOptions,
} from "./output-normalizer";
import { redactErrorMessage } from "../../../mcp/security";

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
  const imageProgressEventType = hasAgentToolCapability(
    toolName,
    "generated_image_artifact",
  )
    ? getAgentToolPresentation(toolName)?.progressEventTypes?.[0]
    : undefined;
  if (imageProgressEventType) {
    const progressEvent = normalizeGeneratedImageProgressEvent({
      type: imageProgressEventType,
      toolCallId,
      tool: toolName,
      stage: "preparing",
      ...(typeof normalizedInput.title === "string" &&
      normalizedInput.title.trim().length > 0
        ? { title: normalizedInput.title.trim() }
        : {}),
      // Whatever this tool's own preflight settled about the shape of the
      // result. Looked up by the name already in hand; never named here.
      ...(getAgentToolTurnPreflight(toolName)?.readProgressSeed?.(
        input.prepared.turnState[toolName],
      ) ?? {}),
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
  // The capability declares the event type its progress arrives under; the
  // handler does not need to know which capabilities exist.
  const progressEventType =
    getAgentToolPresentation(toolName)?.progressEventTypes?.[0];
  if (progressEventType) {
    const progressEvent = normalizeGeneratedPresentationProgressEvent({
      type: progressEventType,
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
  // Tool blocks report progress. A result block is recorded separately by the
  // artifact publisher only after a concrete version commits.
  if (shouldStreamVisibleToolCall) {
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
  // Any capability that reports a generation step gets one; buildArtifactGenerationStep
  // already returns null for the rest, so naming capabilities here would only
  // exclude future ones.
  {
    const step = buildArtifactGenerationStep({
      phase: "generating",
      toolCallId,
      toolName,
    });
    if (step) {
      yield {
        type: "thinking-step",
        step: runtime.setThinkingStep(step),
      };
    }
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
  getSandboxOperationTimeline?: () => Promise<readonly unknown[]>;
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
  const normalizedOutput = retrievalCall
    ? {
        query: retrievalCall.query,
        hitCount: retrievalCall.hitCount,
      }
    : normalizeToolOutputForObservability(
        toolName,
        toolPayload.output,
        normalizedInput,
      );
  const sandboxOperations =
    input.getSandboxOperationTimeline &&
    isSandboxOperationTimelineTool(toolName)
      ? await input.getSandboxOperationTimeline()
      : [];
  const output = appendSandboxOperationTimeline(
    toolName,
    normalizedOutput,
    sandboxOperations,
  );
  const connectorContentError = getConnectorToolOutputContentError(output);
  const outputError =
    connectorContentError?.message ??
    getConnectorToolOutputError(output) ??
    getArtifactProgressToolOutputError(output) ??
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
  // The artifact block is emitted at tool-start alongside the tool block; no
  // per-capability append on completion. The block's body reveals the result
  // once the artifact is ready.
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
  // The phase is the capability's to read — it owns the status vocabulary and
  // whether a URL alone counts as done. The host only asks.
  const completionPhase = getAgentToolPresentation(
    toolName,
  )?.artifactCompletionPhase?.({
    toolInput: nextToolCall.input,
    toolOutput: output,
    readOutputField: extractToolOutputField,
    status: toolStatus,
  });
  if (completionPhase) {
    const step = buildArtifactGenerationStep({
      error: outputError,
      latencyMs,
      phase: completionPhase,
      toolCallId,
      toolName,
    });
    if (step) {
      yield {
        type: "thinking-step",
        step: runtime.setThinkingStep(step),
      };
    }
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
  getSandboxOperationTimeline?: () => Promise<readonly unknown[]>;
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
  // MCP servers control their error text (and an auth failure may echo the
  // presented header), so mask likely secrets before broadcasting it to every
  // thread participant. Non-MCP tools are unaffected.
  const clientErrorText = toolName.startsWith("mcp__")
    ? redactErrorMessage(errorText)
    : errorText;
  const connectorContentError =
    getConnectorToolErrorTextContentError(errorText);
  const sandboxOperations =
    input.getSandboxOperationTimeline &&
    isSandboxOperationTimelineTool(toolName)
      ? await input.getSandboxOperationTimeline()
      : [];
  const nextToolCall = applyToolsStreamToolError({
    currentToolCall: {
      ...currentToolCall,
      output: appendSandboxOperationTimeline(
        toolName,
        currentToolCall.output,
        sandboxOperations,
      ),
      input: sanitizeFilesystemToolInputForClient(
        toolName,
        normalizedInput,
        skillDisplayOptions,
      ),
    },
    error: clientErrorText,
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
    error: clientErrorText,
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
