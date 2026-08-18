import { Command } from "@langchain/langgraph";
import {
  AGENT_TOOL_NAMES,
  hasAgentToolCapability,
  isAgentToolDomain,
} from "@sourceweft/agent-tool-registry";
import { ContentError } from "../../../content/errors";
import { logger } from "../../../../shared/logger";

import type { LlmExecutionConfig } from "../../../content/model-gateway-audit";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { BillingScope } from "../../../../shared/model-gateway/index";
import type { TraceContext } from "../../../llm-observability";
import type { AgentCheckpointRef, PreparedThreadTurn } from "../..";
import type { RunCancellationGate } from "../../run-cancellation";
import {
  createMessageRenderBlockBuilder,
  finalizeMessageRenderBlocks,
} from "../../turn/render-blocks";
import { toObjectRecord } from "./content";
import {
  checkpointHasPendingTasks,
  checkpointRefFromConfig,
  getAgentStateOrNull,
  resolveAgentBaseConfig,
  resolveHitlInterruptCheckpoint,
  type AgentRunnableConfig,
} from "./checkpoint";
import {
  commandSuccessFailureText,
  isCommandSuccessSatisfied,
  resolveFinalAssistantText,
  shouldSuppressLeakedCommandSpecText,
  shouldSuppressRawToolCallText,
} from "./command-success";
import { handleCustomStreamChunk } from "./custom-stream-handler";
import { buildFinalOutcome } from "./final-outcome";
import { handleAskUserStreamChunk } from "./ask-user-stream-handler";
import { payloadHasAskUserInterrupt } from "../middleware/ask-user";
import {
  handleHitlStreamChunk,
  type HitlStreamHandlerResult,
} from "./hitl-stream-handler";
import { handleMessagesStreamChunk } from "./message-stream-handler";
import {
  isSubagentNamespace,
  recordToolCallNamespace,
  resolveToolProducer,
} from "./subagent-namespace";
import {
  handleToolEventStreamChunk,
  handleToolEndStreamChunk,
  handleToolErrorStreamChunk,
  handleToolStartStreamChunk,
} from "./tool-stream-handler";
import type { DeepAgentTurnEvent } from "./events";
export type { DeepAgentTurnEvent, DeepAgentTurnOutcome } from "./events";
import { createModelReasoningSegmentId } from "./thinking";
import {
  getMcpToolDisplayName,
  normalizeToolInput,
  shouldBindAgentTool,
} from "./tool-utils";
import {
  collectToolOutputRecords,
  extractGeneratedImageArtifacts,
  extractToolOutputText,
  extractWebFetchUrls,
  FILESYSTEM_TOOL_PRESENTERS,
  filesystemScope,
  GENERATED_IMAGE_ALT,
  getConnectorToolErrorTextContentError,
  getConnectorToolOutputContentError,
  getFilesystemToolDescription,
  getFilesystemToolEndTitle,
  getFilesystemToolStartTitle,
  hasPresentationArtifactUrl,
  normalizeToolOutputString,
  parseJsonObjectText,
} from "./output-normalizer";
import {
  buildDeepAgentTodosStep,
  createTraceSequenceAllocator,
  isDeepAgentsWriteTodosTool,
  parseDeepAgentTodos,
  resolveDeepAgentTodosStepStatus,
  resolveToolsStreamToolCall,
} from "./tool-tracker";
import {
  buildAutoApprovedHitlResume,
  buildAutoApprovedHitlResumeDecisions,
  commandResumeFromHitlDecisions,
  commandResumeFromToolApprovalResume,
  shouldSilenceEmptyApprovalResume,
} from "./hitl-handler";
import {
  buildArtifactGenerationStep,
  buildPresentationProgressThinkingEvent,
  buildPresentationProgressThinkingStep,
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
} from "./progress-events";
export {
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
} from "./progress-events";
import { openTurnBillingScope } from "./turn-billing-scope";
import {
  buildToolCollection,
  buildRuntimePromptContext,
  buildFilesystemBackend,
  buildSandboxRuntimeForPreparedTurn,
  buildThreadAgentAssembly,
  type ToolCollection,
  type ThreadAgentAssembly,
} from "./turn-assembly";
import { createTurnRuntime } from "./turn-runtime";
import { buildAgentRuntimeContext } from "../prompts/agent-runtime-context";

const MAX_AUTO_APPROVED_SANDBOX_HITL_RESUMES = 8;

export const testExports = {
  buildAgentRuntimeContext,
  createMessageRenderBlockBuilder,
  buildArtifactGenerationStep,
  buildPresentationProgressThinkingStep,
  buildPresentationProgressThinkingEvent,
  buildDeepAgentTodosStep,
  shouldSuppressRawToolCallText,
  shouldSuppressLeakedCommandSpecText,
  isDeepAgentsWriteTodosTool,
  parseDeepAgentTodos,
  resolveDeepAgentTodosStepStatus,
  extractGeneratedImageArtifacts,
  finalizeMessageRenderBlocks,
  getFilesystemToolDescription,
  getFilesystemToolEndTitle,
  getFilesystemToolStartTitle,
  getConnectorToolOutputContentError,
  getConnectorToolErrorTextContentError,
  createModelReasoningSegmentId,
  commandResumeFromToolApprovalResume,
  commandResumeFromHitlDecisions,
  resolveHitlInterruptCheckpoint,
  resolveAgentBaseConfig,
  shouldBindAgentTool,
  resolveFinalAssistantText,
  shouldSilenceEmptyApprovalResume,
  createTraceSequenceAllocator,
  buildAutoApprovedHitlResume,
  buildAutoApprovedHitlResumeDecisions,
  buildFinalOutcome,
  isCommandSuccessSatisfied,
};

export async function* invokeDeepAgentTurn(input: {
  prepared: PreparedThreadTurn;
  billing: ContentBillingPort;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
  operation?: "chat.stream" | "chat.complete";
  /**
   * Hands the turn's billing scope to the caller as soon as it exists.
   *
   * The caller needs it on the failure path: when a turn throws partway
   * through, no outcome is ever produced, and the scope is the only thing still
   * holding what was already metered.
   */
  onBillingScope?: (scope: BillingScope) => void;
  /**
   * Refuses capability writes once the run is cancelled. The durable worker
   * builds it from the run's cancel poll; absent on paths with no run.
   */
  runCancellation?: RunCancellationGate;
  /**
   * Aborts the LLM stream (and signal-aware tools) mid-turn on cancel. Threaded
   * into `agent.stream`'s runConfig so a Stop interrupts work rather than only
   * blocking its output.
   */
  abortSignal?: AbortSignal;
}): AsyncGenerator<DeepAgentTurnEvent> {
  const runtime = createTurnRuntime({ prepared: input.prepared });
  const {
    toolCallsById,
    toolCallOrder,
    observedToolCallsById,
    reasoningSegments,
    resolveToolCallSequence,
    collectToolCalls,
    setThinkingStep,
  } = runtime;

  // Maps each streamed tool event's subgraph namespace to its tool call id, so a
  // `task` delegate's child tool events can be correlated back to the parent
  // `task` call (its namespace is the child's parent prefix). Persists across the
  // streamLoop restarts a HITL resume triggers. Only populated under
  // `subgraphs: true`; empty otherwise.
  const taskCallIdByNamespaceKey = new Map<string, string>();

  // Declare variables that need to be accessible in finally and after try/finally
  let mcpToolRuntime!: ToolCollection["mcpToolRuntime"];
  let agent!: ThreadAgentAssembly["agent"];
  let beforeAssistantCheckpoint: AgentCheckpointRef | null = null;
  let beforeInputCheckpoint: AgentCheckpointRef | null = null;
  let finalCheckpoint: AgentCheckpointRef | null = null;
  let runConfig!: ThreadAgentAssembly["runConfig"];
  let sandboxRuntime: Awaited<
    ReturnType<typeof buildSandboxRuntimeForPreparedTurn>
  > = null;

  try {
    const filesystemBackend = buildFilesystemBackend({
      prepared: input.prepared,
      runtime,
    });
    sandboxRuntime = await buildSandboxRuntimeForPreparedTurn({
      prepared: input.prepared,
      filesystemBackend,
    });
    const toolCollection = await buildToolCollection({
      prepared: input.prepared,
      billing: input.billing,
      filesystemBackend,
      llm: input.llm,
      traceContext: input.traceContext,
      runtime,
      sandboxRuntime,
      runCancellation: input.runCancellation,
    });
    const { connectorToolContext, mcpToolRuntime: mcpRuntime } = toolCollection;
    mcpToolRuntime = mcpRuntime;
    const runtimePromptContext = await buildRuntimePromptContext({
      prepared: input.prepared,
      toolCollection,
      sandboxRuntime,
    });

    // The scope spans the whole turn: agent creation, the initial stream, every
    // tool-boundary re-entry, and HITL resumptions all settle against it.
    const billedModel = await openTurnBillingScope({
      prepared: input.prepared,
      billing: input.billing,
      llm: input.llm,
      traceContext: input.traceContext,
      runtime,
    });
    if (runtime.billingScope) {
      input.onBillingScope?.(runtime.billingScope);
    }

    const agentAssembly = await buildThreadAgentAssembly({
      prepared: input.prepared,
      llm: input.llm,
      traceContext: input.traceContext,
      toolCollection,
      filesystemBackend,
      sandboxRuntime,
      runtimePrompt: runtimePromptContext.runtimePrompt,
      model: billedModel,
      abortSignal: input.abortSignal,
    });
    const { visibleSources, selectedSourcesOmitted } = runtimePromptContext;

    const {
      agent: assembledAgent,
      agentMessages,
      baseConfig,
      runConfig: assembledRunConfig,
      runAgentStream,
    } = agentAssembly;
    agent = assembledAgent;
    runConfig = assembledRunConfig;
    const beforeInputState =
      input.prepared.agentMode === "continue"
        ? await getAgentStateOrNull(agent, baseConfig as AgentRunnableConfig)
        : null;
    beforeInputCheckpoint =
      input.prepared.agentMode === "fork"
        ? input.prepared.agentBaseCheckpoint
        : checkpointRefFromConfig(
            (beforeInputState as { config?: unknown } | null)?.config,
          );
    beforeAssistantCheckpoint =
      input.prepared.agentMode === "replay"
        ? input.prepared.agentBaseCheckpoint
        : null;
    finalCheckpoint = null;

    const suppressModelReasoning = input.llm?.thinking?.mode === "off";

    let stream =
      input.prepared.agentMode === "replay"
        ? input.prepared.toolApprovalResume
          ? await agent.stream(
              new Command({
                resume: commandResumeFromToolApprovalResume(
                  input.prepared.toolApprovalResume,
                ),
              }),
              runConfig as AgentRunnableConfig,
            )
          : (() => {
              throw new ContentError(
                400,
                "AGENT_HITL_RESUME_REQUIRED",
                "DeepAgents HITL replay requires a resume decision payload.",
              );
            })()
        : await runAgentStream(agentMessages);
    let autoApprovedHitlResumeCount = 0;
    const maxAutoApprovedHitlResumes = Math.max(
      1,
      input.prepared.toolApprovalResume?.sourceweft?.connectorActions?.length ??
        0,
      input.prepared.toolApprovalResume?.sourceweft?.sandboxActions?.length
        ? MAX_AUTO_APPROVED_SANDBOX_HITL_RESUMES
        : 0,
    );
    streamLoop: while (true) {
      for await (const streamChunk of stream as AsyncGenerator<unknown>) {
        if (!Array.isArray(streamChunk) || streamChunk.length < 2) {
          continue;
        }

        // Under LangGraph `subgraphs: true` each chunk is
        // `[namespace, mode, payload]`; a bare graph yields `[mode, payload]`.
        // Detecting the namespace by shape tolerates both, so the loop does not
        // depend on how the stream was configured.
        const hasNamespace = Array.isArray(streamChunk[0]);
        if (hasNamespace && streamChunk.length < 3) {
          continue;
        }
        const namespace = hasNamespace ? (streamChunk[0] as unknown[]) : [];
        const mode = hasNamespace ? streamChunk[1] : streamChunk[0];
        const payload = hasNamespace ? streamChunk[2] : streamChunk[1];

        // A `task` delegate's events reach the client only to group its tool
        // cards. Every other sub-agent event (model text, reasoning, checkpoints,
        // HITL updates) is dropped here so a delegate can never pollute the main
        // answer or the parent's checkpoint/interrupt bookkeeping. Main-agent
        // events (namespace without a `tools:` segment) always pass through.
        const subagentEvent = isSubagentNamespace(namespace);
        if (subagentEvent && mode !== "tools") {
          continue;
        }

        if (mode === "checkpoints") {
          const checkpoint = checkpointRefFromConfig(
            (toObjectRecord(payload) ?? {}).config,
          );
          if (checkpoint) {
            if (
              !beforeAssistantCheckpoint &&
              checkpointHasPendingTasks(payload)
            ) {
              beforeAssistantCheckpoint = checkpoint;
            }
            finalCheckpoint = checkpoint;
          }
          continue;
        }

        if (mode === "messages") {
          yield* handleMessagesStreamChunk({
            payload,
            commandSuccessCriteria: input.prepared.commandSuccessCriteria,
            runtime,
            suppressModelReasoning,
            prepared: input.prepared,
            billing: input.billing,
            llm: input.llm,
            operation: input.operation ?? "chat.stream",
          });
          continue;
        }

        if (mode === "updates") {
          // A question interrupt (askUser calling `interrupt()`) has no
          // actionRequests/reviewConfigs, so the approval handler would treat it
          // as "continue" and strand the checkpoint. Route it first.
          if (payloadHasAskUserInterrupt(payload)) {
            const askUserResult = yield* handleAskUserStreamChunk({
              agent,
              beforeInputCheckpoint,
              finalCheckpoint,
              payload,
              runConfig,
              runtime,
              threadId: input.prepared.thread.id,
              userId: input.prepared.userId,
              workspaceId: input.prepared.workspace.id,
            });
            if (askUserResult.kind === "done") {
              return;
            }
            continue;
          }
          const result: HitlStreamHandlerResult = yield* handleHitlStreamChunk({
            agent,
            autoApprovedHitlResumeCount,
            beforeAssistantCheckpoint,
            beforeInputCheckpoint,
            billing: input.billing,
            connectorToolContext,
            finalCheckpoint,
            llm: input.llm,
            maxAutoApprovedHitlResumes,
            prepared: input.prepared,
            payload,
            runConfig,
            runtime,
            threadId: input.prepared.thread.id,
            userId: input.prepared.userId,
            workspaceId: input.prepared.workspace.id,
          });
          if (result.kind === "replace-stream") {
            stream = result.stream;
            finalCheckpoint = result.finalCheckpoint;
            beforeAssistantCheckpoint = result.beforeAssistantCheckpoint;
            autoApprovedHitlResumeCount = result.autoApprovedHitlResumeCount;
            continue streamLoop;
          }
          if (result.kind === "done") {
            return;
          }
          continue;
        }

        if (mode === "custom") {
          yield* handleCustomStreamChunk({ payload, runtime });
          continue;
        }

        if (mode !== "tools") {
          continue;
        }

        const producer = subagentEvent
          ? resolveToolProducer(namespace, {
              toolCallsById,
              taskCallIdByNamespaceKey,
            })
          : undefined;
        const toolCallSnapshot = resolveToolsStreamToolCall({
          pendingToolStreamsByRunId: runtime.pendingToolStreamsByRunId,
          payload,
          ...(producer ? { producer } : {}),
          resolveToolCallSequence,
          toolCallOrder,
          toolCallsById,
        });
        if (!toolCallSnapshot) {
          continue;
        }
        // Remember this event's namespace → tool call id (main events included),
        // so a later child event can resolve its parent `task` call by prefix.
        recordToolCallNamespace(
          namespace,
          toolCallSnapshot.toolCallId,
          taskCallIdByNamespaceKey,
        );
        const { event } = toolCallSnapshot;

        if (event === "on_tool_start") {
          yield* handleToolStartStreamChunk({
            prepared: input.prepared,
            runtime,
            snapshot: toolCallSnapshot,
            traceContext: input.traceContext,
          });
          continue;
        }

        if (event === "on_tool_event") {
          yield* handleToolEventStreamChunk({
            runtime,
            snapshot: toolCallSnapshot,
          });
          continue;
        }

        if (event === "on_tool_end") {
          yield* handleToolEndStreamChunk({
            prepared: input.prepared,
            runtime,
            snapshot: toolCallSnapshot,
            traceContext: input.traceContext,
            ...(sandboxRuntime
              ? {
                  getSandboxOperationTimeline:
                    sandboxRuntime.getOperationTimeline,
                }
              : {}),
          });
          continue;
        }

        if (event === "on_tool_error") {
          yield* handleToolErrorStreamChunk({
            prepared: input.prepared,
            runtime,
            snapshot: toolCallSnapshot,
            traceContext: input.traceContext,
            ...(sandboxRuntime
              ? {
                  getSandboxOperationTimeline:
                    sandboxRuntime.getOperationTimeline,
                }
              : {}),
          });
        }
      }
      if (
        input.prepared.agentMode === "replay" ||
        isCommandSuccessSatisfied({
          criteria: input.prepared.commandSuccessCriteria,
          toolCalls: collectToolCalls(),
        })
      ) {
        break;
      }
      break;
    }
  } catch (error) {
    throw error;
  } finally {
    try {
      await mcpToolRuntime?.close();
    } catch (error) {
      logger.warn("Failed to close MCP tool runtime after agent turn", {
        workspaceId: input.prepared.workspace.id,
        threadId: input.prepared.thread.id,
        userId: input.prepared.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  yield* buildFinalOutcome({
    agent,
    beforeAssistantCheckpoint,
    beforeInputCheckpoint,
    finalCheckpoint,
    prepared: input.prepared,
    runConfig,
    runtime,
  });
}
