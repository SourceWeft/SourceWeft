import { Command } from "@langchain/langgraph";
import {
  AGENT_TOOL_NAMES,
  isPatternScopeToolName,
  isReadToolOutputToolName,
  isWebFetchToolName,
  isWebSearchToolName,
  isAgentToolDomain,
} from "../tool-registry";
import { ContentError } from "../../errors";

import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { ContentBillingPort } from "../../billing-port";
import type { TraceContext } from "../../../../shared/llm-observability";
import type { AgentCheckpointRef, PreparedThreadTurn } from "../../threads";
import {
  createMessageRenderBlockBuilder,
  finalizeMessageRenderBlocks,
} from "../../threads/turn/render-blocks";
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
import {
  handleHitlStreamChunk,
  type HitlStreamHandlerResult,
} from "./hitl-stream-handler";
import { handleMessagesStreamChunk } from "./message-stream-handler";
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
  buildAutoApprovedHitlResumeDecisions,
  commandResumeFromHitlDecisions,
  commandResumeFromToolApprovalResume,
  shouldSilenceEmptyApprovalResume,
} from "./hitl-handler";
import {
  resolveDirectToolCommand,
  runDirectToolCommand,
} from "./direct-tool-executor";
import {
  buildPresentationGenerationStep,
  buildPresentationProgressThinkingEvent,
  buildPresentationProgressThinkingStep,
  isPresentationGenerationCommand,
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
  normalizeGeneratedVideoPresentationProgressEvent,
} from "./progress-events";
export {
  normalizeGeneratedImageProgressEvent,
  normalizeGeneratedPresentationProgressEvent,
  normalizeGeneratedVideoPresentationProgressEvent,
} from "./progress-events";
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
import { buildAgentRuntimePrompt } from "../prompts/runtime-prompt";

export const testExports = {
  buildAgentRuntimePrompt,
  createMessageRenderBlockBuilder,
  buildPresentationGenerationStep,
  buildPresentationProgressThinkingStep,
  buildPresentationProgressThinkingEvent,
  buildDeepAgentTodosStep,
  shouldSuppressRawToolCallText,
  shouldSuppressLeakedCommandSpecText,
  isDeepAgentsWriteTodosTool,
  parseDeepAgentTodos,
  resolveDeepAgentTodosStepStatus,
  isPresentationGenerationCommand,
  normalizeGeneratedVideoPresentationProgressEvent,
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
  resolveDirectToolCommand,
  buildAutoApprovedHitlResumeDecisions,
  isCommandSuccessSatisfied,
};

export async function* invokeDeepAgentTurn(input: {
  prepared: PreparedThreadTurn;
  billing: ContentBillingPort;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
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

  // Declare variables that need to be accessible in finally and after try/finally
  let mcpToolRuntime!: ToolCollection["mcpToolRuntime"];
  let agent!: ThreadAgentAssembly["agent"];
  let beforeAssistantCheckpoint: AgentCheckpointRef | null = null;
  let beforeInputCheckpoint: AgentCheckpointRef | null = null;
  let finalCheckpoint: AgentCheckpointRef | null = null;
  let runConfig!: ThreadAgentAssembly["runConfig"];

  // Build tool collection first to check for direct command
  try {
    const toolCollection = await buildToolCollection({
      prepared: input.prepared,
      billing: input.billing,
      llm: input.llm,
      traceContext: input.traceContext,
      runtime,
    });
    const {
      retrievalTool,
      webTools,
      artifactTools,
      presentationTools,
      videoPresentationTools,
      connectorActionTools,
      mcpTools,
      connectorToolContext,
      mcpToolRuntime: mcpRuntime,
    } = toolCollection;
    mcpToolRuntime = mcpRuntime;

    const toolCommand = resolveDirectToolCommand(input.prepared);
    if (toolCommand) {
      yield* runDirectToolCommand({
        commandSuccessFailureText,
        artifactTools,
        normalizeGeneratedImageProgressEvent,
        prepared: input.prepared,
        reasoningSegments,
        resolveToolCallSequence,
        isCommandSuccessSatisfied,
        toolCommand,
        traceContext: input.traceContext,
        usage: runtime.usage,
      });
      return;
    }

    // Build remaining assembly only for non-direct-command turns
    const filesystemBackend = buildFilesystemBackend({
      prepared: input.prepared,
      runtime,
    });
    const sandboxRuntime = buildSandboxRuntimeForPreparedTurn({
      prepared: input.prepared,
      filesystemBackend,
    });
    const runtimePromptContext = await buildRuntimePromptContext({
      prepared: input.prepared,
      toolCollection,
      sandboxRuntime,
    });
    const agentAssembly = await buildThreadAgentAssembly({
      prepared: input.prepared,
      llm: input.llm,
      traceContext: input.traceContext,
      toolCollection,
      filesystemBackend,
      sandboxRuntime,
      runtimePrompt: runtimePromptContext.runtimePrompt,
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

    if (input.prepared.enabledSkills.length > 0) {
      yield {
        type: "thinking-step",
        step: setThinkingStep({
          id: "selected-skills",
          kind: "state",
          title: "Loaded skills",
          status: "completed",
          items: input.prepared.enabledSkills.map((skill) => skill.name),
          description: `${input.prepared.enabledSkills.length} skill${input.prepared.enabledSkills.length === 1 ? "" : "s"} available under /skills.`,
          metadata: {
            invokedSkillIds: input.prepared.invokedSkillIds,
            selectedSkillIds: input.prepared.selectedSkillIds,
            skillIds: input.prepared.skillIds,
            skillNames: input.prepared.enabledSkills.map((skill) => skill.name),
          },
        }),
      };
    }

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
    );
    streamLoop: while (true) {
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
          });
          continue;
        }

        if (mode === "updates") {
          const result: HitlStreamHandlerResult = yield* handleHitlStreamChunk({
            agent,
            autoApprovedHitlResumeCount,
            beforeAssistantCheckpoint,
            beforeInputCheckpoint,
            connectorToolContext,
            finalCheckpoint,
            maxAutoApprovedHitlResumes,
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

        const toolCallSnapshot = resolveToolsStreamToolCall({
          payload,
          resolveToolCallSequence,
          toolCallOrder,
          toolCallsById,
        });
        if (!toolCallSnapshot) {
          continue;
        }
        const { event } = toolCallSnapshot;

        if (event === "on_tool_start") {
          yield* handleToolStartStreamChunk({
            artifactIntent: input.prepared.artifactIntent,
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
          });
          continue;
        }

        if (event === "on_tool_error") {
          yield* handleToolErrorStreamChunk({
            prepared: input.prepared,
            runtime,
            snapshot: toolCallSnapshot,
            traceContext: input.traceContext,
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
  } finally {
    await mcpToolRuntime?.close();
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
