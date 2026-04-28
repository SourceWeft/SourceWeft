import { buildAgentConfig, createThreadAgent } from "..";
import {
  AgentCitationRegistry,
} from "../citation-registry";
import { DatabaseKnowledgeBackend } from "../database-fs-backend";
import { createRetrievalTool } from "../tools/retrieval-tool";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import { contentRetrievalService } from "../../retrieval/service";
import type {
  PreparedThreadTurn,
  RetrievalCallTrace,
  ThinkingStepTrace,
  ToolCallTrace,
} from "../../threads";
import {
  extractTextDeltasFromMessageChunk,
  resolveAssistantContentFromUpdatesChunk,
  sanitizeSseValue,
  toObjectRecord,
} from "./content";
import { validateAssistantCitations } from "./citations";
import type { DeepAgentTurnEvent } from "./events";
export type { DeepAgentTurnEvent, DeepAgentTurnOutcome } from "./events";
import { listThinkingSteps, upsertThinkingStep } from "./thinking";
import {
  normalizeErrorText,
  normalizeToolInput,
  resolveToolCallId,
  type ToolCallStatus,
} from "./tool-utils";

async function runToolRetrieval(input: {
  prepared: PreparedThreadTurn;
  query: string;
  llm?: LlmExecutionConfig;
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
  });
}

function summarizeReviewedSources(
  retrieval: Awaited<ReturnType<typeof contentRetrievalService.runRetrieval>> | null,
) {
  if (!retrieval) {
    return [] as string[];
  }

  const titles: string[] = [];
  const seen = new Set<string>();
  for (const candidate of retrieval.fusedCandidates) {
    const key = candidate.sourceId;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    titles.push(candidate.sourceTitle || "Untitled source");
  }
  return titles;
}

export async function* invokeDeepAgentTurn(input: {
  prepared: PreparedThreadTurn;
  llm?: LlmExecutionConfig;
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
  const citationRegistry = new AgentCitationRegistry();
  let latestToolRetrieval: Awaited<ReturnType<typeof runToolRetrieval>> | null =
    null;
  let assistantContent = "";
  let fallbackAssistantContent: string | null = null;
  let hasStartedSynthesis = false;
  let hasStreamedText = false;
  let emittedCitationCount = 0;
  let eventSequence = 0;
  let evidenceToolStarted = false;
  const shouldBufferGroundedAnswer = input.prepared.sourceIds.length > 0;

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

  const emitNewCitations = function* (): Generator<DeepAgentTurnEvent> {
    const citations = citationRegistry.list();
    if (citations.length <= emittedCitationCount) {
      return;
    }
    emittedCitationCount = citations.length;
    yield {
      type: "citations",
      citations,
    };
  };

  yield {
    type: "thinking-step",
    step: setThinkingStep({
      id: "understand",
      title: "Understanding the question",
      status: "completed",
      items: [],
    }),
  };

  const retrievalTool = createRetrievalTool({
    retrieve: async (query, runtime) => {
      const retrievalStartedAt = Date.now();
      const retrieval = await runToolRetrieval({
        prepared: input.prepared,
        query,
        llm: input.llm,
      });
      latestToolRetrieval = retrieval;

      const callId = resolveToolCallId({
        toolCallId: runtime?.toolCallId,
        toolName: "retrieve",
        fallbackIndex: retrievalCallOrder.length + 1,
      });

      if (!retrievalCallsById.has(callId)) {
        retrievalCallOrder.push(callId);
      }

      const retrievalCall: RetrievalCallTrace = {
        id: callId,
        tool: "retrieve",
        query,
        hitCount: retrieval.fusedCandidates.length,
        latencyMs: Date.now() - retrievalStartedAt,
      };
      retrievalCallsById.set(callId, retrievalCall);
      retrievalsByToolCallId.set(callId, retrieval);

      const citationByChunkId = new Map(
        retrieval.fusedCandidates.map((candidate) => {
          const citation = citationRegistry.addRetrievalCandidate(candidate);
          return [candidate.chunkId, citation] as const;
        }),
      );
      return retrieval.fusedCandidates.map((candidate, index) => ({
        citation:
          citationByChunkId.get(candidate.chunkId)?.citation ?? `c${index + 1}`,
        chunkId: candidate.chunkId,
        content: candidate.content,
        sourceTitle: citationByChunkId.get(candidate.chunkId)?.sourceTitle,
      }));
    },
  });

  const databaseBackend = new DatabaseKnowledgeBackend({
    teamId: input.prepared.workspace.organizationId,
    workspaceId: input.prepared.workspace.id,
    sourceIds: input.prepared.sourceIds,
    citationRegistry,
  });

  const agent = await createThreadAgent({
    modelAlias: input.prepared.modelAlias,
    gatewayConfigId: input.prepared.chatProfile.gatewayConfigId,
    tools: [retrievalTool],
    backend: databaseBackend,
    execution: {
      executionMode: input.llm?.executionMode,
      providerHint: input.llm?.providerHint,
      byok: input.llm?.byok,
      metadata: {
        team_id: input.prepared.workspace.organizationId,
        workspace_id: input.prepared.workspace.id,
        user_id: input.prepared.userId,
        thread_id: input.prepared.thread.id,
        message_id: input.prepared.userMessage.id,
        feature: "chat",
      },
    },
  });

  const stream = await agent.stream(
    {
      messages: [
        {
          role: "user",
          content: input.prepared.messageContent,
        },
      ],
    },
    {
      ...buildAgentConfig(input.prepared.deepAgentThreadId, {
        team_id: input.prepared.workspace.organizationId,
        workspace_id: input.prepared.workspace.id,
        user_id: input.prepared.userId,
        thread_id: input.prepared.thread.id,
      }),
      streamMode: ["messages", "tools", "updates"],
    },
  );

  for await (const streamChunk of stream as AsyncGenerator<unknown>) {
    if (!Array.isArray(streamChunk) || streamChunk.length < 2) {
      continue;
    }

    const mode = streamChunk[0];
    const payload = streamChunk[1];

    if (mode === "messages") {
      if (!Array.isArray(payload) || payload.length < 1) {
        continue;
      }

      const messageChunk = payload[0];
      const deltas = extractTextDeltasFromMessageChunk(messageChunk);
      for (const delta of deltas) {
        if (!delta) {
          continue;
        }
        if (shouldBufferGroundedAnswer && !evidenceToolStarted) {
          continue;
        }
        if (!hasStartedSynthesis) {
          hasStartedSynthesis = true;
          yield {
            type: "thinking-step",
            step: setThinkingStep({
              id: "synthesize",
              title: "Synthesizing answer with citations",
              status: "in_progress",
              items: [],
            }),
          };
        }
        assistantContent += delta;
        hasStreamedText = true;
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
      const normalizedInput = normalizeToolInput(toolPayload.input);
      toolStartedAtById.set(toolCallId, Date.now());
      evidenceToolStarted = true;
      const nextToolCall: ToolCallTrace = {
        ...currentToolCall,
        tool: toolName,
        input: normalizedInput,
        status: "running",
        error: null,
      };
      toolCallsById.set(toolCallId, nextToolCall);
      yield {
        type: "tool-call-start",
        id: toolCallId,
        tool: toolName,
        input: normalizedInput,
        toolCall: nextToolCall,
      };
      if (toolName === "retrieve") {
        const query =
          typeof normalizedInput.query === "string"
            ? normalizedInput.query.trim()
            : "";
        yield {
          type: "thinking-step",
          step: setThinkingStep({
            id: "search",
            title: "Searching selected sources",
            status: "in_progress",
            items: query.length > 0 ? [`Query: ${query}`] : [],
          }),
        };
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
      const retrievalCall = retrievalCallsById.get(toolCallId);
      const toolRetrieval = retrievalsByToolCallId.get(toolCallId) ?? null;
      const startedAt = toolStartedAtById.get(toolCallId);
      const measuredLatency =
        typeof startedAt === "number" ? Date.now() - startedAt : null;
      const latencyMs = retrievalCall?.latencyMs ?? measuredLatency;
      const output = retrievalCall
        ? {
            hitCount: retrievalCall.hitCount,
          }
        : toolPayload.output;
      const nextToolCall: ToolCallTrace = {
        ...currentToolCall,
        tool: toolName,
        output,
        status: "completed",
        latencyMs,
        error: null,
      };
      toolCallsById.set(toolCallId, nextToolCall);
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
      yield* emitNewCitations();
      if (toolName === "retrieve") {
        const query = retrievalCall?.query ?? "";
        yield {
          type: "thinking-step",
          step: setThinkingStep({
            id: "search",
            title: "Searched selected sources",
            status: "completed",
            items: query.trim().length > 0 ? [`Query: ${query.trim()}`] : [],
          }),
        };

        const reviewedSources = summarizeReviewedSources(toolRetrieval);
        yield {
          type: "thinking-step",
          step: setThinkingStep({
            id: "review",
            title: `Reviewed ${reviewedSources.length} ${
              reviewedSources.length === 1 ? "file" : "files"
            }`,
            status: "completed",
            items: reviewedSources,
          }),
        };
      }
      continue;
    }

    if (event === "on_tool_error") {
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
      yield* emitNewCitations();
    }
  }

  let assistantText =
    assistantContent.trim().length > 0
      ? assistantContent.trim()
      : fallbackAssistantContent && fallbackAssistantContent.trim().length > 0
        ? fallbackAssistantContent.trim()
        : "Model returned an empty response.";

  const finalRetrieval = latestToolRetrieval;
  const finalCitations = citationRegistry.list();

  const citationValidation = validateAssistantCitations({
    assistantText,
    citations: finalCitations,
  });
  if (!citationValidation.valid) {
    assistantText =
      "I could not produce a grounded answer because the response referenced citation markers that were not returned by the workspace evidence tools. Please try again so I can gather citable evidence before answering.";
  }

  yield {
    type: "citations",
    citations: citationValidation.valid ? finalCitations : [],
  };

  if (!hasStreamedText) {
    yield {
      type: "text-delta",
      delta: sanitizeSseValue(assistantText),
    };
  }

  yield {
    type: "thinking-step",
    step: setThinkingStep({
      id: "synthesize",
      title: "Synthesized answer with citations",
      status: "completed",
      items: [],
    }),
  };

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

  yield {
    type: "done",
    outcome: {
      assistantContent: assistantText,
      retrieval: finalRetrieval,
      citations: citationValidation.valid ? finalCitations : [],
      retrievalCalls,
      toolCalls,
      thinkingSteps: listThinkingSteps({
        stepsById: thinkingStepsById,
        stepOrder: thinkingStepOrder,
      }),
    },
  };
}
