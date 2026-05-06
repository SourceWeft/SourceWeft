import { CompositeBackend } from "deepagents";
import { buildAgentConfig, createThreadAgent } from "..";
import {
  AgentCitationRegistry,
} from "../citation-registry";
import { DatabaseKnowledgeBackend } from "../database-fs-backend";
import {
  createRetrievalTool,
} from "../tools/retrieval-tool";
import { SelectedSkillsBackend } from "../../skills/backend";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { TraceContext } from "../../../../shared/llm-observability";
import { endSpan, startSpan } from "../../../../shared/llm-observability";
import { contentRetrievalService } from "../../retrieval/service";
import type {
  AgentCheckpointRef,
  PreparedThreadTurn,
  RetrievalCallTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../../threads";
import {
  extractTextDeltasFromMessageChunk,
  extractFinishReasonFromMessageChunk,
  extractProviderFieldsFromMessageChunk,
  extractReasoningFromMessageChunk,
  extractUsageFromMessageChunk,
  resolveAssistantContentFromUpdatesChunk,
  sanitizeSseValue,
  toObjectRecord,
} from "./content";
import { normalizeAssistantCitations } from "./citations";
import type { DeepAgentTurnEvent } from "./events";
import type { DeepAgentTurnOutcome } from "./events";
export type { DeepAgentTurnEvent, DeepAgentTurnOutcome } from "./events";
import { listThinkingSteps, upsertThinkingStep } from "./thinking";
import {
  normalizeErrorText,
  normalizeToolInput,
  resolveToolCallId,
  type ToolCallStatus,
} from "./tool-utils";
import { logger } from "../../../../shared/logger";

function checkpointRefToConfig(checkpoint: AgentCheckpointRef) {
  return {
    configurable: {
      thread_id: checkpoint.threadId,
      checkpoint_id: checkpoint.checkpointId,
      checkpoint_ns: checkpoint.checkpointNs ?? "",
    },
  };
}

function checkpointRefFromConfig(value: unknown): AgentCheckpointRef | null {
  const config = toObjectRecord(value);
  const configurable = toObjectRecord(config?.configurable);
  if (!configurable) {
    return null;
  }

  const threadId = typeof configurable.thread_id === "string"
    ? configurable.thread_id
    : null;
  const checkpointId = typeof configurable.checkpoint_id === "string"
    ? configurable.checkpoint_id
    : null;
  if (!threadId || !checkpointId) {
    return null;
  }

  const checkpointNs = typeof configurable.checkpoint_ns === "string"
    ? configurable.checkpoint_ns
    : undefined;

  return checkpointNs === undefined
    ? { threadId, checkpointId }
    : { threadId, checkpointId, checkpointNs };
}

function checkpointHasPendingTasks(value: unknown) {
  const record = toObjectRecord(value);
  return Array.isArray(record?.next) && record.next.length > 0;
}

type AgentRunnableConfig = Awaited<ReturnType<typeof createThreadAgent>> extends {
  stream: (input: unknown, config?: infer Config) => unknown;
}
  ? NonNullable<Config>
  : Record<string, unknown>;

async function getAgentStateOrNull(
  agent: Awaited<ReturnType<typeof createThreadAgent>>,
  config: AgentRunnableConfig,
) {
  try {
    return await agent.getState(config);
  } catch {
    return null;
  }
}

function addUsage(
  current: DeepAgentTurnOutcome["usage"],
  next: DeepAgentTurnOutcome["usage"],
): DeepAgentTurnOutcome["usage"] {
  if (!next) {
    return current;
  }

  const sum = (left?: number, right?: number) =>
    left === undefined && right === undefined
      ? undefined
      : (left ?? 0) + (right ?? 0);

  return {
    inputTokens: sum(current?.inputTokens, next.inputTokens),
    outputTokens: sum(current?.outputTokens, next.outputTokens),
    totalTokens: sum(current?.totalTokens, next.totalTokens),
    cacheReadTokens: sum(current?.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(current?.cacheWriteTokens, next.cacheWriteTokens),
  };
}

function appendReasoningChunk(current: string | undefined, next: string) {
  if (!current) {
    return next;
  }
  if (next === current) {
    return current;
  }
  if (next.startsWith(current)) {
    return next;
  }
  return `${current}${next}`;
}

async function runToolRetrieval(input: {
  prepared: PreparedThreadTurn;
  query: string;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
}) {
  return contentRetrievalService.runRetrieval({
    workspaceId: input.prepared.workspace.id,
    teamId: input.prepared.workspace.organizationId,
    threadId: input.prepared.thread.id,
    userId: input.prepared.userId,
    userMessageId: input.prepared.userMessage.id,
    queryText: input.query,
    sourceIds: input.prepared.sourceIds,
    idempotencyKey: input.prepared.llmIdempotencyKey,
    llm: input.llm,
    traceContext: input.traceContext,
  });
}

function compactTraceText(value: string, maxLength = 96) {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatToolInputItems(input: Record<string, unknown>) {
  const entries = ["query", "path", "pattern", "glob"]
    .map((key) => {
      const value = input[key];
      return typeof value === "string" && value.trim().length > 0
        ? `${key}: ${compactTraceText(value)}`
        : null;
    })
    .filter((item): item is string => item !== null);

  return entries.slice(0, 3);
}

function resolveFilesystemPath(input: Record<string, unknown>) {
  for (const key of ["path", "file_path", "filePath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function filesystemScope(input: Record<string, unknown>) {
  return resolveFilesystemPath(input).startsWith("/skills") ? "skills" : "sources";
}

function getFilesystemToolStartTitle(toolName: string, input: Record<string, unknown>) {
  const skillScoped = filesystemScope(input) === "skills";
  if (toolName === "ls") {
    return skillScoped ? "Listing selected skills" : "Listing selected sources";
  }
  if (toolName === "glob") {
    return skillScoped ? "Finding matching skill files" : "Finding matching sources";
  }
  if (toolName === "read_file") {
    return skillScoped ? "Reading skill instructions" : "Reading source content";
  }
  if (toolName === "grep") {
    return skillScoped ? "Searching skill instructions" : "Searching exact terms";
  }
  return null;
}

function getFilesystemToolEndTitle(toolName: string, input: Record<string, unknown>) {
  const skillScoped = filesystemScope(input) === "skills";
  if (toolName === "ls") {
    return skillScoped ? "Listed selected skills" : "Listed selected sources";
  }
  if (toolName === "glob") {
    return skillScoped ? "Found matching skill files" : "Found matching sources";
  }
  if (toolName === "read_file") {
    return skillScoped ? "Read skill instructions" : "Read source content";
  }
  if (toolName === "grep") {
    return skillScoped ? "Searched skill instructions" : "Searched exact terms";
  }
  return null;
}

function extractToolOutputText(output: unknown) {
  if (typeof output === "string") {
    return output;
  }

  const record = toObjectRecord(output);
  if (!record) {
    return null;
  }

  if (typeof record.content === "string") {
    return record.content;
  }

  const kwargs = toObjectRecord(record.kwargs) ?? toObjectRecord(record.lc_kwargs);
  const content = kwargs?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const itemRecord = toObjectRecord(item);
        return typeof itemRecord?.text === "string" ? itemRecord.text : null;
      })
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  return null;
}

export function normalizeToolOutputForObservability(toolName: string, output: unknown) {
  if (toolName !== "read_file") {
    return output;
  }

  const outputText = extractToolOutputText(output);
  if (outputText) {
    return { content: outputText };
  }

  const record = toObjectRecord(output);
  if (typeof record?.error === "string") {
    return { error: record.error };
  }

  return output;
}

function extractToolPayloadInput(toolPayload: Record<string, unknown>) {
  for (const candidate of [toolPayload.input, toolPayload.args]) {
    const normalized = normalizeToolInput(candidate);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  const data = toObjectRecord(toolPayload.data);
  if (!data) {
    return {};
  }

  for (const candidate of [data.input, data.args]) {
    const normalized = normalizeToolInput(candidate);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }
  }

  return {};
}

function getFilesystemToolMetadata(toolName: string, output: unknown) {
  const record = toObjectRecord(output);
  const metadata: Record<string, unknown> = {};

  if (record && Array.isArray(record.files)) {
    metadata.resultCount = record.files.length;
  }
  if (record && Array.isArray(record.matches)) {
    metadata.matchCount = record.matches.length;
  }
  const outputText = extractToolOutputText(output);
  if (outputText) {
    const chunkMatches = outputText.match(/--- chunk |^Chunk:/gm);
    if (chunkMatches && chunkMatches.length > 0) {
      metadata.chunkCount = chunkMatches.length;
    }
    metadata.truncated = outputText.includes("Output truncated.");
  }

  if (toolName === "read_file" && metadata.chunkCount === undefined) {
    metadata.chunkCount = 1;
  }

  return metadata;
}

function getFilesystemToolDescription(
  toolName: string,
  metadata: Record<string, unknown>,
  input?: Record<string, unknown>,
) {
  const noun = input && filesystemScope(input) === "skills" ? "skill" : "source";
  if (toolName === "ls" && typeof metadata.resultCount === "number") {
    return `Listed ${metadata.resultCount} entries.`;
  }
  if (toolName === "glob" && typeof metadata.resultCount === "number") {
    return `Found ${metadata.resultCount} matching paths.`;
  }
  if (toolName === "grep" && typeof metadata.matchCount === "number") {
    return `Found ${metadata.matchCount} text matches.`;
  }
  if (toolName === "read_file" && typeof metadata.chunkCount === "number") {
    return `Read ${metadata.chunkCount} ${noun} ${metadata.chunkCount === 1 ? "chunk" : "chunks"}.`;
  }
  return undefined;
}

function extractReasoningSummaryFromProviderFields(
  providerFields: Record<string, unknown> | undefined,
) {
  if (!providerFields) {
    return null;
  }

  const candidates = [
    providerFields.reasoning_summary,
    providerFields.reasoningSummary,
    providerFields.reasoning,
    providerFields.summary,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }

    const record = toObjectRecord(candidate);
    if (record) {
      const text =
        typeof record.summary === "string"
          ? record.summary
          : typeof record.text === "string"
            ? record.text
            : typeof record.content === "string"
              ? record.content
              : null;
      if (text && text.trim().length > 0) {
        return text.trim();
      }
    }
  }

  return null;
}

export async function* invokeDeepAgentTurn(input: {
  prepared: PreparedThreadTurn;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const retrievalCallsById = new Map<string, RetrievalCallTrace>();
  const retrievalsByToolCallId = new Map<
    string,
    Awaited<ReturnType<typeof runToolRetrieval>>
  >();
  const retrievalCallOrder: string[] = [];
  const toolCallsById = new Map<string, ToolCallTrace>();
  const toolCallOrder: string[] = [];
  const toolStartedAtById = new Map<string, number>();
  const thinkingStepsById = new Map<string, ThinkingStepTrace>();
  const thinkingStepOrder: string[] = [];
  const reasoningSegments: DeepAgentTurnOutcome["reasoningSegments"] = [];
  const runStartedAt = Date.now();
  const citationRegistry = new AgentCitationRegistry();
  let latestToolRetrieval: Awaited<ReturnType<typeof runToolRetrieval>> | null =
    null;
  let assistantContent = "";
  let fallbackAssistantContent: string | null = null;
  let usage: DeepAgentTurnOutcome["usage"];
  let finishReason: string | undefined;
  let modelReasoning: string | undefined;
  let providerFields: Record<string, unknown> | undefined;
  let hasStreamedText = false;
  let hasTextSinceLastToolBoundary = false;
  let lastEmittedCitationCount = 0;
  let eventSequence = 0;
  let currentReasoningSegment: DeepAgentTurnOutcome["reasoningSegments"][number] | null = null;
  let nextReasoningContext:
    | { phase: "initial" }
    | { phase: "after_tool"; toolCallId: string; tool: string } = {
      phase: "initial",
    };

  const nextSequence = () => {
    eventSequence += 1;
    return eventSequence;
  };

  const setThinkingStep = (step: Omit<ThinkingStepTrace, "sequence">) => {
    const existing = thinkingStepsById.get(step.id);
    return upsertThinkingStep({
      stepsById: thinkingStepsById,
      stepOrder: thinkingStepOrder,
      step: {
        ...step,
        sequence: existing?.sequence ?? nextSequence(),
      },
    });
  };

  const appendReasoningSegment = (text: string) => {
    if (!currentReasoningSegment) {
      currentReasoningSegment = {
        id: `model-reasoning-${reasoningSegments.length + 1}`,
        text: "",
        sequence: nextSequence(),
        durationMs: 0,
        phase: nextReasoningContext.phase,
        ...(nextReasoningContext.phase === "after_tool"
          ? {
              toolCallId: nextReasoningContext.toolCallId,
              tool: nextReasoningContext.tool,
            }
          : {}),
      };
      reasoningSegments.push(currentReasoningSegment);
    }

    currentReasoningSegment.durationMs = Date.now() - runStartedAt;
    currentReasoningSegment.text = appendReasoningChunk(
      currentReasoningSegment.text,
      text,
    ) ?? currentReasoningSegment.text;

    return currentReasoningSegment;
  };

  const getNewCitationSnapshot = () => {
    const citations = citationRegistry.list();
    if (citations.length <= lastEmittedCitationCount) {
      return null;
    }

    lastEmittedCitationCount = citations.length;
    return citations;
  };

  const recordRetrieval = (input: {
    callId: string;
    query: string;
    retrieval: Awaited<ReturnType<typeof runToolRetrieval>>;
    latencyMs: number;
  }) => {
    latestToolRetrieval = input.retrieval;

    if (!retrievalCallsById.has(input.callId)) {
      retrievalCallOrder.push(input.callId);
    }

    const retrievalCall: RetrievalCallTrace = {
      id: input.callId,
      tool: "search_sources",
      query: input.query,
      hitCount: input.retrieval.fusedCandidates.length,
      latencyMs: input.latencyMs,
    };
    retrievalCallsById.set(input.callId, retrievalCall);
    retrievalsByToolCallId.set(input.callId, input.retrieval);

    return new Map(
      input.retrieval.fusedCandidates.map((candidate) => {
        const citation = citationRegistry.addRetrievalCandidate(candidate);
        return [candidate.chunkId, citation] as const;
      }),
    );
  };

  const buildRetrievalChunks = (input: {
    retrieval: Awaited<ReturnType<typeof runToolRetrieval>>;
    citationByChunkId: Map<string, ReturnType<AgentCitationRegistry["addRetrievalCandidate"]>>;
  }) =>
    input.retrieval.fusedCandidates.map((candidate, index) => ({
      citation:
        input.citationByChunkId.get(candidate.chunkId)?.citation ?? `c${index + 1}`,
      chunkId: candidate.chunkId,
      content: candidate.content,
      sourceTitle: input.citationByChunkId.get(candidate.chunkId)?.sourceTitle,
    }));

  const retrievalTool = createRetrievalTool({
    searchSources: async (query, runtime) => {
      const retrievalStartedAt = Date.now();
      const retrieval = await runToolRetrieval({
        prepared: input.prepared,
        query,
        llm: input.llm,
        traceContext: runtime?.toolCallId && input.traceContext
          ? {
              ...input.traceContext,
              parentSpanId: resolveToolCallId({
                toolCallId: runtime.toolCallId,
                toolName: "search_sources",
                fallbackIndex: retrievalCallOrder.length + 1,
              }),
            }
          : input.traceContext,
      });
      const callId = resolveToolCallId({
        toolCallId: runtime?.toolCallId,
        toolName: "search_sources",
        fallbackIndex: retrievalCallOrder.length + 1,
      });
      const citationByChunkId = recordRetrieval({
        callId,
        query,
        retrieval,
        latencyMs: Date.now() - retrievalStartedAt,
      });
      return buildRetrievalChunks({ retrieval, citationByChunkId });
    },
  });

  const databaseBackend = new DatabaseKnowledgeBackend({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    sourceIds: input.prepared.sourceIds,
    citationRegistry,
  });
  const skillsBackend = input.prepared.enabledSkills.length > 0
    ? new SelectedSkillsBackend(input.prepared.enabledSkills)
    : null;
  const backend = skillsBackend
    ? new CompositeBackend(databaseBackend, { "/skills/": skillsBackend })
    : databaseBackend;

  const agent = await createThreadAgent({
    modelAlias: input.prepared.modelAlias,
    gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
    tools: [retrievalTool],
    backend,
    skills: skillsBackend ? ["/skills/"] : undefined,
    execution: {
      executionMode: input.llm?.executionMode,
      providerHint: input.llm?.providerHint,
      byok: input.llm?.byok,
      thinking: input.llm?.thinking,
      metadata: {
        traceId: input.traceContext?.traceId,
        parentSpanId: input.traceContext?.parentSpanId,
        profileAlias: input.prepared.profileAlias,
        modelAlias: input.prepared.modelAlias,
        teamId: input.prepared.workspace.organizationId,
        workspaceId: input.prepared.workspace.id,
        userId: input.prepared.userId,
        threadId: input.prepared.thread.id,
        messageId: input.prepared.userMessage.id,
        observationName: "agent_generation",
        feature: "chat",
        team_id: input.prepared.workspace.organizationId,
        workspace_id: input.prepared.workspace.id,
        user_id: input.prepared.userId,
        thread_id: input.prepared.thread.id,
        message_id: input.prepared.userMessage.id,
        selected_skill_ids: input.prepared.skillIds,
        selected_skill_count: input.prepared.enabledSkills.length,
      },
    },
  });

  const agentMessages = [
    {
      role: "user" as const,
      content: input.prepared.messageContent,
    },
  ];

  const baseConfig = input.prepared.agentBaseCheckpoint
    ? checkpointRefToConfig(input.prepared.agentBaseCheckpoint)
    : buildAgentConfig(input.prepared.agentRunThreadId);
  const beforeInputState = input.prepared.agentMode === "continue"
    ? await getAgentStateOrNull(agent, baseConfig as AgentRunnableConfig)
    : null;
  const beforeInputCheckpoint = input.prepared.agentMode === "fork"
    ? input.prepared.agentBaseCheckpoint
    : checkpointRefFromConfig(
        (beforeInputState as { config?: unknown } | null)?.config,
      );
  let beforeAssistantCheckpoint = input.prepared.agentMode === "replay"
    ? input.prepared.agentBaseCheckpoint
    : null;
  let finalCheckpoint: AgentCheckpointRef | null = null;

  const runConfig = {
    ...baseConfig,
    configurable: {
      ...((baseConfig as { configurable?: Record<string, unknown> }).configurable ?? {}),
      team_id: input.prepared.workspace.organizationId,
      workspace_id: input.prepared.workspace.id,
      user_id: input.prepared.userId,
      sourceweft_thread_id: input.prepared.thread.id,
      selected_skill_ids: input.prepared.skillIds,
      selected_skill_count: input.prepared.enabledSkills.length,
    },
    streamMode: ["messages", "tools", "updates", "checkpoints"],
  } satisfies AgentRunnableConfig;

  if (input.prepared.enabledSkills.length > 0) {
    yield {
      type: "thinking-step",
      step: setThinkingStep({
        id: "selected-skills",
        kind: "state",
        title: "Loaded selected skills",
        status: "completed",
        items: input.prepared.enabledSkills.map((skill) => skill.name),
        description: `${input.prepared.enabledSkills.length} skill${input.prepared.enabledSkills.length === 1 ? "" : "s"} available under /skills.`,
        metadata: {
          skillIds: input.prepared.skillIds,
          skillNames: input.prepared.enabledSkills.map((skill) => skill.name),
        },
      }),
    };
  }

  const streamInput = input.prepared.agentMode === "replay"
    ? null
    : { messages: agentMessages };
  const stream = await agent.stream(streamInput, runConfig as AgentRunnableConfig);
  const suppressModelReasoning = input.llm?.thinking?.mode === "off";

  for await (const streamChunk of stream as AsyncGenerator<unknown>) {
    if (!Array.isArray(streamChunk) || streamChunk.length < 2) {
      continue;
    }

    const mode = streamChunk[0];
    const payload = streamChunk[1];

    if (mode === "checkpoints") {
      const checkpoint = checkpointRefFromConfig(
        (toObjectRecord(payload) ?? {}).config,
      );
      if (checkpoint) {
        if (!beforeAssistantCheckpoint && checkpointHasPendingTasks(payload)) {
          beforeAssistantCheckpoint = checkpoint;
        }
        finalCheckpoint = checkpoint;
      }
      continue;
    }

    if (mode === "messages") {
      if (!Array.isArray(payload) || payload.length < 1) {
        continue;
      }

      const messageChunk = payload[0];
      const messageMetadata = payload[1];
      usage = addUsage(usage, extractUsageFromMessageChunk(messageChunk));
      finishReason = extractFinishReasonFromMessageChunk(messageChunk) ?? finishReason;
      providerFields = extractProviderFieldsFromMessageChunk(messageChunk) ?? providerFields;
      const nextReasoning =
        extractReasoningFromMessageChunk(messageChunk) ??
        extractReasoningFromMessageChunk(messageMetadata) ??
        extractReasoningFromMessageChunk(payload);
      if (nextReasoning && !suppressModelReasoning) {
        modelReasoning = appendReasoningChunk(modelReasoning, nextReasoning);
        const segment = appendReasoningSegment(nextReasoning);
        yield {
          type: "reasoning",
          reasoning: nextReasoning,
          segment,
        };
      }
      const deltas = extractTextDeltasFromMessageChunk(messageChunk);
      for (const delta of deltas) {
        if (!delta) {
          continue;
        }
        assistantContent += delta;
        hasStreamedText = true;
        hasTextSinceLastToolBoundary = true;
        yield {
          type: "text-delta",
          delta,
        };
      }
      continue;
    }

    if (mode === "updates") {
      const assistantFromUpdates = resolveAssistantContentFromUpdatesChunk(payload);
      if (assistantFromUpdates && assistantFromUpdates.trim().length > 0) {
        fallbackAssistantContent = assistantFromUpdates.trim();
      }
      continue;
    }

    if (mode !== "tools") {
      continue;
    }

    const toolPayload = toObjectRecord(payload);
    if (!toolPayload) {
      continue;
    }

    const event = typeof toolPayload.event === "string" ? toolPayload.event : "";
    const toolName =
      typeof toolPayload.name === "string" && toolPayload.name.length > 0
        ? toolPayload.name
        : "tool";
    const toolCallId = resolveToolCallId({
      toolCallId:
        typeof toolPayload.toolCallId === "string"
          ? toolPayload.toolCallId
          : undefined,
      toolName,
      fallbackIndex: toolCallOrder.length + 1,
    });

    if (!toolCallsById.has(toolCallId)) {
      toolCallOrder.push(toolCallId);
      toolCallsById.set(toolCallId, {
        id: toolCallId,
        tool: toolName,
        input: {},
        output: null,
        status: "running" as ToolCallStatus,
        latencyMs: null,
        error: null,
        sequence: nextSequence(),
      });
    }

    const currentToolCall = toolCallsById.get(toolCallId);
    if (!currentToolCall) {
      continue;
    }

    if (event === "on_tool_start") {
      currentReasoningSegment = null;
      const normalizedInput = extractToolPayloadInput(toolPayload);
      toolStartedAtById.set(toolCallId, Date.now());
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
      const nextToolCall: ToolCallTrace = {
        ...currentToolCall,
        tool: toolName,
        input: normalizedInput,
        status: "running",
        error: null,
      };
      toolCallsById.set(toolCallId, nextToolCall);
      if (hasTextSinceLastToolBoundary) {
        yield {
          type: "text-interrupted",
          reason: "tool-call",
          toolCallId,
          tool: toolName,
        };
        assistantContent += "\n";
        yield {
          type: "text-delta",
          delta: "\n",
        };
        hasTextSinceLastToolBoundary = false;
      }
      yield {
        type: "tool-call-start",
        id: toolCallId,
        tool: toolName,
        input: normalizedInput,
        toolCall: nextToolCall,
      };
      if (toolName === "search_sources") {
        const query =
          typeof normalizedInput.query === "string"
            ? normalizedInput.query.trim()
            : "";
        yield {
          type: "thinking-step",
          step: setThinkingStep({
            id: `search_sources:${toolCallId}`,
            kind: "state",
            title: "Searching sources",
            status: "in_progress",
            items: [],
            description: query.length > 0 ? `Query: ${compactTraceText(query)}` : undefined,
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
            step: setThinkingStep({
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
      continue;
    }

    if (event === "on_tool_event") {
      const toolData = toolPayload.data;
      const nextToolCall: ToolCallTrace = {
        ...currentToolCall,
        tool: toolName,
        output: toolData,
        status: "running",
        error: null,
      };
      toolCallsById.set(toolCallId, nextToolCall);
      yield {
        type: "tool-call-event",
        id: toolCallId,
        tool: toolName,
        data: toolData,
        toolCall: nextToolCall,
      };
      continue;
    }

    if (event === "on_tool_end") {
      currentReasoningSegment = null;
      nextReasoningContext = {
        phase: "after_tool",
        toolCallId,
        tool: toolName,
      };
      const retrievalCall = retrievalCallsById.get(toolCallId);
      const toolRetrieval = retrievalsByToolCallId.get(toolCallId) ?? null;
      const startedAt = toolStartedAtById.get(toolCallId);
      const normalizedInput = extractToolPayloadInput(toolPayload);
      const measuredLatency =
        typeof startedAt === "number" ? Date.now() - startedAt : null;
      const latencyMs = retrievalCall?.latencyMs ?? measuredLatency;
      const output = retrievalCall
        ? {
            query: retrievalCall.query,
            hitCount: retrievalCall.hitCount,
          }
        : normalizeToolOutputForObservability(toolName, toolPayload.output);
      const nextToolCall: ToolCallTrace = {
        ...currentToolCall,
        tool: toolName,
        input: Object.keys(currentToolCall.input).length > 0
          ? currentToolCall.input
          : normalizedInput,
        output,
        status: "completed",
        latencyMs,
        error: null,
      };
      toolCallsById.set(toolCallId, nextToolCall);
      if (input.traceContext) {
        await endSpan({
          traceId: input.traceContext.traceId,
          teamId: input.traceContext.teamId,
          workspaceId: input.traceContext.workspaceId,
          spanId: toolCallId,
          status: "ok",
          latencyMs,
          output,
          metadata: {
            toolName,
            ...(retrievalCall
              ? { query: retrievalCall.query, hitCount: retrievalCall.hitCount }
              : {}),
          },
        });
      }
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
      yield {
        type: "tool-call-end",
        id: toolCallId,
        tool: toolName,
        latencyMs,
        status: "completed",
        toolCall: nextToolCall,
      };
      if (toolName === "search_sources") {
        const query = retrievalCall?.query ?? "";
        yield {
          type: "thinking-step",
          step: setThinkingStep({
            id: `search_sources:${toolCallId}`,
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
        const title = getFilesystemToolEndTitle(toolName, nextToolCall.input);
        if (title) {
          const metadata = {
            ...getFilesystemToolMetadata(toolName, output),
            latencyMs,
            toolCallId,
            tool: toolName,
          };
          yield {
            type: "thinking-step",
            step: setThinkingStep({
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
      const citationSnapshot = getNewCitationSnapshot();
      if (citationSnapshot) {
        yield {
          type: "citations",
          citations: citationSnapshot,
        };
      }
      continue;
    }

    if (event === "on_tool_error") {
      currentReasoningSegment = null;
      nextReasoningContext = {
        phase: "after_tool",
        toolCallId,
        tool: toolName,
      };
      const startedAt = toolStartedAtById.get(toolCallId);
      const latencyMs =
        typeof startedAt === "number"
          ? Date.now() - startedAt
          : currentToolCall.latencyMs;
      const errorText = normalizeErrorText(toolPayload.error);
      const nextToolCall: ToolCallTrace = {
        ...currentToolCall,
        tool: toolName,
        status: "error",
        latencyMs,
        error: errorText,
      };
      toolCallsById.set(toolCallId, nextToolCall);
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
      const title = getFilesystemToolEndTitle(toolName, nextToolCall.input);
      if (title) {
        yield {
          type: "thinking-step",
          step: setThinkingStep({
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
  }

  const streamedAssistantText = assistantContent.trim();
  let assistantText =
    assistantContent.trim().length > 0
      ? assistantContent.trim()
      : fallbackAssistantContent && fallbackAssistantContent.trim().length > 0
        ? fallbackAssistantContent.trim()
        : "Model returned an empty response.";

  const finalRetrieval = latestToolRetrieval;
  const finalCitations = citationRegistry.list();
  const reasoningSummary = extractReasoningSummaryFromProviderFields(providerFields);

  if (reasoningSummary) {
    yield {
      type: "thinking-step",
      step: setThinkingStep({
        id: "reasoning-summary",
        kind: "reasoning_summary",
        title: "Reasoning summary",
        status: "completed",
        items: [],
        description: compactTraceText(reasoningSummary, 280),
      }),
    };
  }

  yield {
    type: "thinking-step",
    step: setThinkingStep({
      id: "verify",
      kind: "verification",
      title: "Checking citations",
      status: "in_progress",
      items: [],
      description: "Normalizing citation markers before saving the answer.",
    }),
  };

  const citationNormalization = normalizeAssistantCitations({
    assistantText,
    citations: finalCitations,
  });
  assistantText = citationNormalization.text;
  const usedCitations = citationNormalization.citations;
  const availableCitationCount = finalCitations.length;
  const usedCitationCount = usedCitations.length;
  const removedCitationCount = citationNormalization.invalidKeys.length;
  const missingInlineCitationMarkers =
    availableCitationCount > 0 && citationNormalization.markerCount === 0;

  yield {
    type: "thinking-step",
    step: setThinkingStep({
      id: "verify",
      kind: "verification",
      title: "Checking citations",
      status: "completed",
      items: [],
      description: [
        `Used ${usedCitationCount} of ${availableCitationCount} available citations`,
        missingInlineCitationMarkers ? "no inline citation markers found" : null,
        citationNormalization.removedInvalidCitations
          ? `removed ${removedCitationCount} unsupported markers`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · "),
      metadata: {
        availableCitationCount,
        usedCitationCount,
        citationMarkerCount: citationNormalization.markerCount,
        validCitationMarkerCount: citationNormalization.validMarkerCount,
        ...(missingInlineCitationMarkers ? { missingInlineCitationMarkers: true } : {}),
        ...(removedCitationCount > 0
          ? { removedCitationCount }
          : {}),
      },
    }),
  };

  yield {
    type: "citations",
    citations: usedCitations,
    availableCitations: finalCitations,
  };

  if (!hasStreamedText) {
    yield {
      type: "text-delta",
      delta: sanitizeSseValue(assistantText),
    };
  }

  const retrievalCalls = retrievalCallOrder
    .map((callId) => retrievalCallsById.get(callId))
    .filter((call): call is RetrievalCallTrace => Boolean(call));

  const toolCalls = toolCallOrder
    .map((callId) => toolCallsById.get(callId))
    .filter((call): call is ToolCallTrace => Boolean(call))
    .map((call) => {
      if (call.status !== "running") {
        return call;
      }

      const startedAt = toolStartedAtById.get(call.id);
      return {
        ...call,
        status: "completed" as const,
        latencyMs:
          call.latencyMs ??
          (typeof startedAt === "number" ? Date.now() - startedAt : null),
      };
    });

  const finalState = finalCheckpoint
    ? null
    : await getAgentStateOrNull(agent, runConfig);
  finalCheckpoint ??= checkpointRefFromConfig(
    (finalState as { config?: unknown } | null)?.config,
  );

  yield {
    type: "done",
    outcome: {
      assistantContent: assistantText,
      usage,
      finishReason,
      reasoning: modelReasoning,
      retrieval: finalRetrieval,
      citations: usedCitations,
      availableCitations: finalCitations,
      retrievalCalls,
      toolCalls,
      thinkingSteps: listThinkingSteps({
        stepsById: thinkingStepsById,
        stepOrder: thinkingStepOrder,
      }),
      reasoningSegments,
      agentCheckpoint: {
        beforeInput: beforeInputCheckpoint,
        beforeAssistant: beforeAssistantCheckpoint,
        final: finalCheckpoint,
      },
    },
  };
}
