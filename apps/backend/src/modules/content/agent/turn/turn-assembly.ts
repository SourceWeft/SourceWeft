import { createThreadAgent } from "..";
import type { ContentBillingPort } from "../../billing-port";
import type { LlmExecutionConfig } from "../../model-gateway-audit";
import type { PreparedThreadTurn } from "../../threads";
import { listVirtualFsSources } from "../../virtual-fs/store";
import type { VirtualFsSource } from "../../virtual-fs/types";
import { createDefaultWebProvider } from "../../web";
import { SelectedSkillsBackend } from "../../skills/backend";
import { createConnectorActionInterruptConfigs } from "../../../connectors/agent-tools";
import { createConnectorActionTools } from "../../../connectors/agent-tools";
import type {
  ConnectorActionApprovalCursor,
  ConnectorActionExecutionCursor,
} from "../../../connectors/agent-tool-idempotency";
import { buildConnectorActionApprovalScope } from "../../../connectors/agent-tool-idempotency";
import { mcpService } from "../../../mcp";
import type { TraceContext } from "../../../../shared/llm-observability";
import { logger } from "../../../../shared/logger";
import { DatabaseKnowledgeBackend } from "../database-fs-backend";
import { createDefaultFilesystemMounts } from "../filesystem-capabilities";
import { MountedAgentFilesystemBackend } from "../mounted-fs-backend";
import { createGenerateImageTool } from "../tools/generate-image-tool";
import { createGeneratePptxTool } from "../tools/generate-pptx-tool";
import { createGenerateVideoPresentationTool } from "../tools/generate-video-presentation-tool";
import { createRetrievalTool } from "../tools/retrieval-tool";
import { createWebTools } from "../tools/web-tools";
import { AGENT_TOOL_NAMES } from "../tool-registry";
import { WorkingFilesBackend } from "../working-files-backend";
import { createSandboxRuntimeForTurn } from "../sandbox";
import { warnIfSandboxHitlBypassed } from "../sandbox/startup-log";
import type { SandboxRuntimeForTurn } from "../sandbox/runtime";
import { buildAgentRuntimePrompt } from "../prompts/runtime-prompt";
import { runToolRetrieval } from "./retrieval-runner";
import { commandExecutionPolicyFor } from "./command-success";
import type { AgentRunnableConfig } from "./checkpoint";
import { resolveAgentBaseConfig } from "./checkpoint";
import type { TurnRuntime } from "./turn-runtime";
import {
  filterAllowedTools,
  isToolDenied,
  resolveSourceUserMessageId,
  resolveToolCallId,
  shouldBindAgentTool,
} from "./tool-utils";

const MAX_RUNTIME_SOURCE_REFERENCES = 50;

export interface FilesystemBackendInput {
  prepared: PreparedThreadTurn;
  runtime: TurnRuntime;
}

export interface FilesystemBackend {
  backend: MountedAgentFilesystemBackend;
  filesystemMounts: ReturnType<typeof createDefaultFilesystemMounts>;
  skillsBackend: SelectedSkillsBackend | null;
}

export function buildFilesystemBackend(
  input: FilesystemBackendInput,
): FilesystemBackend {
  const { prepared, runtime } = input;

  const databaseBackend = new DatabaseKnowledgeBackend({
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    sourceIds: Array.from(
      new Set([...prepared.sourceIds, ...prepared.effectiveMentionedSourceIds]),
    ),
    citationRegistry: runtime.citationRegistry,
  });

  const workingFilesBackend = new WorkingFilesBackend({
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    threadId: prepared.thread.id,
    userId: prepared.userId,
    citationRegistry: runtime.citationRegistry,
  });

  const skillsBackend =
    prepared.enabledSkills.length > 0
      ? new SelectedSkillsBackend(prepared.enabledSkills)
      : null;

  const filesystemMounts = createDefaultFilesystemMounts({
    skillsEnabled: Boolean(skillsBackend),
  });

  const backend = new MountedAgentFilesystemBackend({
    knowledge: databaseBackend,
    working: workingFilesBackend,
    skills: skillsBackend,
    mounts: filesystemMounts,
  });

  return {
    backend,
    filesystemMounts,
    skillsBackend,
  };
}

export interface RuntimePromptContextInput {
  prepared: PreparedThreadTurn;
  toolCollection: ToolCollection;
  sandboxRuntime: SandboxRuntimeForTurn | null;
}

export interface RuntimePromptContext {
  runtimePrompt: string;
  visibleSources: VirtualFsSource[];
  selectedSourcesOmitted: number;
}

export async function buildRuntimePromptContext(
  input: RuntimePromptContextInput,
): Promise<RuntimePromptContext> {
  const { prepared, toolCollection, sandboxRuntime } = input;
  const {
    webTools,
    artifactTools,
    presentationTools,
    videoPresentationTools,
    mcpTools,
  } = toolCollection;

  const runtimeSourceReferences =
    prepared.sourceIds.length > 0
      ? await listVirtualFsSources({
          teamId: prepared.workspace.organizationId,
          workspaceId: prepared.workspace.id,
          sourceIds: prepared.sourceIds,
          limit: MAX_RUNTIME_SOURCE_REFERENCES + 1,
        }).catch((error) => {
          logger.warn("Failed to build selected source runtime manifest", {
            teamId: prepared.workspace.organizationId,
            workspaceId: prepared.workspace.id,
            sourceCount: prepared.sourceIds.length,
            error: error instanceof Error ? error.message : String(error),
          });
          return [] as VirtualFsSource[];
        })
      : [];
  const mentionedSourceReferences =
    prepared.effectiveMentionedSourceIds.length > 0
      ? await listVirtualFsSources({
          teamId: prepared.workspace.organizationId,
          workspaceId: prepared.workspace.id,
          sourceIds: prepared.effectiveMentionedSourceIds,
          limit: MAX_RUNTIME_SOURCE_REFERENCES + 1,
        }).catch((error) => {
          logger.warn("Failed to build mentioned source runtime manifest", {
            teamId: prepared.workspace.organizationId,
            workspaceId: prepared.workspace.id,
            sourceCount: prepared.effectiveMentionedSourceIds.length,
            error: error instanceof Error ? error.message : String(error),
          });
          return [] as VirtualFsSource[];
        })
      : [];
  const runtimeSourcesById = new Map<string, VirtualFsSource>();
  for (const source of [
    ...mentionedSourceReferences,
    ...runtimeSourceReferences,
  ]) {
    runtimeSourcesById.set(source.sourceId, source);
  }
  const runtimeSources = Array.from(runtimeSourcesById.values());
  const visibleSources = runtimeSources.slice(0, MAX_RUNTIME_SOURCE_REFERENCES);
  const selectedSourcesOmitted = Math.max(
    0,
    runtimeSources.length - visibleSources.length,
  );

  const runtimePrompt = buildAgentRuntimePrompt({
    availableWebTools: webTools.map((tool) => tool.name),
    availableArtifactTools: [
      ...artifactTools,
      ...presentationTools,
      ...videoPresentationTools,
    ].map((tool) => tool.name),
    availableMcpTools: mcpTools.map((tool) => tool.name),
    artifactIntent: prepared.artifactIntent,
    generatePptxTool: prepared.generatePptxTool,
    generateVideoPresentationTool: prepared.generateVideoPresentationTool,
    commandSuccessCriteria: prepared.commandSuccessCriteria,
    enabledSkills: prepared.enabledSkills,
    invokedSkillIds: prepared.invokedSkillIds,
    sandboxRuntime: sandboxRuntime
      ? {
          prepareToolAvailable: sandboxRuntime.tools.some(
            (tool) => tool.name === AGENT_TOOL_NAMES.prepareSandboxWorkspace,
          ),
          executeAvailable: true,
          collectToolAvailable: sandboxRuntime.tools.some(
            (tool) => tool.name === AGENT_TOOL_NAMES.collectSandboxOutputs,
          ),
        }
      : undefined,
    timezone: prepared.timezone,
    selectedSources: visibleSources,
    selectedSourcesOmitted,
  });

  return {
    runtimePrompt,
    visibleSources,
    selectedSourcesOmitted,
  };
}

export interface ToolCollectionInput {
  prepared: PreparedThreadTurn;
  billing: ContentBillingPort;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
  runtime: TurnRuntime;
}

export interface ToolCollection {
  retrievalTool: ReturnType<typeof createRetrievalTool>;
  webTools: ReturnType<typeof createWebTools>;
  artifactTools: ReturnType<typeof createGenerateImageTool>[];
  presentationTools: ReturnType<typeof createGeneratePptxTool>[];
  videoPresentationTools: ReturnType<
    typeof createGenerateVideoPresentationTool
  >[];
  connectorActionTools: Awaited<ReturnType<typeof createConnectorActionTools>>;
  mcpTools: Awaited<
    ReturnType<typeof mcpService.buildLangChainToolsForTurn>
  >["tools"];
  connectorToolContext: {
    actionApprovalCursor: ConnectorActionApprovalCursor;
    actionExecutionCursor: ConnectorActionExecutionCursor | undefined;
    actionApprovalScope: ReturnType<typeof buildConnectorActionApprovalScope>;
    teamId: string;
    workspaceId: string;
    userId: string;
  };
  mcpToolRuntime: Awaited<
    ReturnType<typeof mcpService.buildLangChainToolsForTurn>
  > | null;
}

export interface ThreadAgentAssemblyInput {
  prepared: PreparedThreadTurn;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
  toolCollection: ToolCollection;
  filesystemBackend: FilesystemBackend;
  sandboxRuntime: SandboxRuntimeForTurn | null;
  runtimePrompt: string;
}

export interface ThreadAgentAssembly {
  agent: Awaited<ReturnType<typeof createThreadAgent>>;
  agentMessages: Array<{ role: "user"; content: unknown }>;
  baseConfig: AgentRunnableConfig;
  runConfig: AgentRunnableConfig;
  runAgentStream: (
    messages: Array<{ role: "user"; content: unknown }>,
  ) => Promise<AsyncGenerator<unknown>>;
}

export interface TurnAssemblyInput {
  prepared: PreparedThreadTurn;
  billing: ContentBillingPort;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
  runtime: TurnRuntime;
}

export interface TurnAssembly {
  toolCollection: ToolCollection;
  runtimePromptContext: RuntimePromptContext;
  filesystemBackend: FilesystemBackend;
  agentAssembly: ThreadAgentAssembly;
}

export function buildSandboxRuntimeForPreparedTurn(input: {
  prepared: PreparedThreadTurn;
  filesystemBackend: FilesystemBackend;
}): SandboxRuntimeForTurn | null {
  const { prepared, filesystemBackend } = input;
  const sandboxRuntime = isToolDenied(prepared, AGENT_TOOL_NAMES.execute)
    ? null
    : createSandboxRuntimeForTurn({
        filesystem: filesystemBackend.backend,
      context: {
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        threadId: prepared.thread.id,
        userId: prepared.userId,
        messageId: prepared.userMessage.id,
        runId: prepared.runTraceId,
        sandboxExecuteToolCallId:
          prepared.toolApprovalResume?.sourceweft?.sandboxExecuteToolCallId,
      },
      enabledSkills: prepared.enabledSkills,
    });

  if (sandboxRuntime) {
    sandboxRuntime.tools = filterAllowedTools(prepared, sandboxRuntime.tools);
  }

  return sandboxRuntime;
}

export async function buildTurnAssembly(
  input: TurnAssemblyInput,
): Promise<TurnAssembly> {
  const { prepared, billing, llm, traceContext, runtime } = input;

  const toolCollection = await buildToolCollection({
    prepared,
    billing,
    llm,
    traceContext,
    runtime,
  });

  const filesystemBackend = buildFilesystemBackend({
    prepared,
    runtime,
  });

  const sandboxRuntime = buildSandboxRuntimeForPreparedTurn({
    prepared,
    filesystemBackend,
  });

  const runtimePromptContext = await buildRuntimePromptContext({
    prepared,
    toolCollection,
    sandboxRuntime,
  });

  const agentAssembly = await buildThreadAgentAssembly({
    prepared,
    llm,
    traceContext,
    toolCollection,
    filesystemBackend,
    sandboxRuntime,
    runtimePrompt: runtimePromptContext.runtimePrompt,
  });

  return {
    toolCollection,
    runtimePromptContext,
    filesystemBackend,
    agentAssembly,
  };
}

export async function buildThreadAgentAssembly(
  input: ThreadAgentAssemblyInput,
): Promise<ThreadAgentAssembly> {
  const {
    prepared,
    llm,
    traceContext,
    toolCollection,
    filesystemBackend,
    sandboxRuntime,
    runtimePrompt,
  } = input;
  const {
    retrievalTool,
    webTools,
    artifactTools,
    presentationTools,
    videoPresentationTools,
    connectorActionTools,
    mcpTools,
    mcpToolRuntime,
  } = toolCollection;
  const { filesystemMounts, skillsBackend } = filesystemBackend;
  const backend = sandboxRuntime?.backend ?? filesystemBackend.backend;
  const boundTools = [
    ...filterAllowedTools(prepared, [retrievalTool]),
    ...webTools,
    ...artifactTools,
    ...presentationTools,
    ...videoPresentationTools,
    ...connectorActionTools,
    ...mcpTools,
    ...(sandboxRuntime?.tools ?? []),
  ];
  const commandTargetToolName =
    prepared.commandSuccessCriteria.kind === "none"
      ? null
      : prepared.commandSuccessCriteria.toolName;

  if (
    prepared.command?.workflow?.execution === "agent" &&
    commandTargetToolName &&
    !boundTools.some((tool) => tool.name === commandTargetToolName)
  ) {
    throw new Error(
      `Command target tool '${commandTargetToolName}' was not bound before agent creation.`,
    );
  }

  const interruptOn = {
    ...(sandboxRuntime?.interruptOn ?? {}),
    ...(mcpToolRuntime?.interruptOn ?? {}),
    ...createConnectorActionInterruptConfigs(),
  };
  if (sandboxRuntime) {
    warnIfSandboxHitlBypassed({
      interruptOn,
      boundSandboxToolNames: sandboxRuntime.tools.map((tool) => tool.name),
    });
  }

  const agent = await createThreadAgent({
    modelAlias: prepared.modelAlias,
    providerModel: prepared.providerModel,
    gatewayConfigId: prepared.chatProfile.gatewayConfigId,
    tools: boundTools,
    backend,
    filesystemMounts,
    skills: skillsBackend ? ["/skills/"] : undefined,
    runtimePrompt,
    chatProfileConfig: prepared.chatProfile.configJson,
    commandExecutionPolicy: commandExecutionPolicyFor(prepared),
    contextCompressionReportKey: prepared.userMessage.id,
    traceContext,
    execution: {
      executionMode: llm?.executionMode,
      profileAlias:
        llm?.executionMode === "BYOK" ? undefined : prepared.profileAlias,
      providerHint: llm?.providerHint,
      byokModelId: llm?.byokModelId,
      credentialId: llm?.credentialId,
      byok: llm?.byok,
      thinking: llm?.thinking,
      metadata: {
        traceId: traceContext?.traceId,
        parentSpanId: traceContext?.parentSpanId,
        ...(llm?.executionMode === "BYOK"
          ? {}
          : { profileAlias: prepared.profileAlias }),
        modelAlias: prepared.modelAlias,
        providerModel: llm?.providerModel ?? prepared.providerModel,
        ...(llm?.executionMode === "BYOK"
          ? {
              executionMode: "BYOK",
              byokModelId: llm.byokModelId,
              credentialId: llm.credentialId,
              keySource: "byokCredential",
            }
          : { executionMode: llm?.executionMode ?? "GLOBAL" }),
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        userId: prepared.userId,
        threadId: prepared.thread.id,
        messageId: prepared.userMessage.id,
        observationName: "agent_generation",
        feature: "chat",
        team_id: prepared.workspace.organizationId,
        workspace_id: prepared.workspace.id,
        user_id: prepared.userId,
        thread_id: prepared.thread.id,
        message_id: prepared.userMessage.id,
        invoked_skill_ids: prepared.invokedSkillIds,
        selected_skill_ids: prepared.selectedSkillIds,
        skill_ids: prepared.skillIds,
        selected_skill_count: prepared.enabledSkills.length,
      },
    },
    interruptOn,
  });

  const agentMessages = [
    {
      role: "user" as const,
      content: prepared.agentMessageContent,
    },
  ];

  const baseConfig = resolveAgentBaseConfig({
    agentBaseCheckpoint: prepared.agentBaseCheckpoint,
    agentMode: prepared.agentMode,
    agentRunThreadId: prepared.agentRunThreadId,
  });

  const runConfig = {
    ...baseConfig,
    configurable: {
      ...((baseConfig as { configurable?: Record<string, unknown> })
        .configurable ?? {}),
      team_id: prepared.workspace.organizationId,
      workspace_id: prepared.workspace.id,
      user_id: prepared.userId,
      sourceweft_thread_id: prepared.thread.id,
      invoked_skill_ids: prepared.invokedSkillIds,
      selected_skill_ids: prepared.selectedSkillIds,
      skill_ids: prepared.skillIds,
      selected_skill_count: prepared.enabledSkills.length,
    },
    streamMode: ["messages", "tools", "updates", "checkpoints", "custom"],
  } satisfies AgentRunnableConfig;

  const runAgentStream = (
    messages: Array<{ role: "user"; content: unknown }>,
  ) =>
    agent.stream(
      { messages: messages as never },
      runConfig as AgentRunnableConfig,
    ) as Promise<AsyncGenerator<unknown>>;

  return {
    agent,
    agentMessages,
    baseConfig,
    runConfig,
    runAgentStream,
  };
}

export async function buildToolCollection(
  input: ToolCollectionInput,
): Promise<ToolCollection> {
  const { prepared, billing, llm, traceContext, runtime } = input;

  const retrievalTool = createRetrievalTool({
    searchSources: async (query, toolCallRuntime) => {
      const retrievalStartedAt = Date.now();
      const retrieval = await runToolRetrieval({
        prepared,
        query,
        llm,
        traceContext:
          toolCallRuntime?.toolCallId && traceContext
            ? {
                ...traceContext,
                parentSpanId: resolveToolCallId({
                  toolCallId: toolCallRuntime.toolCallId,
                  toolName: AGENT_TOOL_NAMES.searchSources,
                  fallbackIndex: runtime.retrievalCallOrder.length + 1,
                }),
              }
            : traceContext,
      });
      const callId = resolveToolCallId({
        toolCallId: toolCallRuntime?.toolCallId,
        toolName: AGENT_TOOL_NAMES.searchSources,
        fallbackIndex: runtime.retrievalCallOrder.length + 1,
      });
      const citationByChunkId = runtime.recordRetrieval({
        callId,
        query,
        retrieval,
        latencyMs: Date.now() - retrievalStartedAt,
      });
      return runtime.buildRetrievalChunks({ retrieval, citationByChunkId });
    },
  });

  const webProvider = createDefaultWebProvider();
  const webSearchAvailable =
    prepared.webSearchEnabled &&
    !isToolDenied(prepared, AGENT_TOOL_NAMES.webSearch);
  const webTools = webProvider
    ? createWebTools({
        provider: webProvider,
        citationRegistry: runtime.citationRegistry,
        searchEnabled: webSearchAvailable,
      }).filter((tool) => !isToolDenied(prepared, tool.name))
    : [];

  const artifactTools =
    prepared.artifactIntent.shouldInjectTool &&
    prepared.imageProfile &&
    !isToolDenied(prepared, AGENT_TOOL_NAMES.generateImage)
      ? [
          createGenerateImageTool({
            teamId: prepared.workspace.organizationId,
            workspaceId: prepared.workspace.id,
            threadId: prepared.thread.id,
            userId: prepared.userId,
            userMessageId: prepared.userMessage.id,
            traceId: traceContext?.traceId,
            parentSpanId: traceContext?.parentSpanId,
            profile: prepared.imageProfile.profile,
            execution: prepared.generateImageTool?.execution,
            config: prepared.artifactIntent.config,
            billing,
          }),
        ]
      : [];

  const presentationTools =
    shouldBindAgentTool({
      prepared,
      toolName: AGENT_TOOL_NAMES.generatePptx,
    }) &&
    prepared.generatePptxTool?.enabled !== false &&
    !isToolDenied(prepared, AGENT_TOOL_NAMES.generatePptx)
      ? [
          createGeneratePptxTool({
            defaultDesign: prepared.generatePptxTool?.design,
            defaultGenerationMode: prepared.generatePptxTool?.generationMode,
            defaultOutput: prepared.generatePptxTool?.output,
            defaultRendering: prepared.generatePptxTool?.rendering,
            teamId: prepared.workspace.organizationId,
            workspaceId: prepared.workspace.id,
            threadId: prepared.thread.id,
            userId: prepared.userId,
            userMessageId: prepared.userMessage.id,
          }),
        ]
      : [];

  const videoPresentationTools =
    shouldBindAgentTool({
      prepared,
      toolName: AGENT_TOOL_NAMES.generateVideoPresentation,
    }) &&
    prepared.generateVideoPresentationTool?.enabled !== false &&
    !isToolDenied(prepared, AGENT_TOOL_NAMES.generateVideoPresentation)
      ? [
          createGenerateVideoPresentationTool({
            defaultNarration: prepared.generateVideoPresentationTool?.narration,
            teamId: prepared.workspace.organizationId,
            workspaceId: prepared.workspace.id,
            threadId: prepared.thread.id,
            userId: prepared.userId,
            userMessageId: prepared.userMessage.id,
            sourceUserMessageId: resolveSourceUserMessageId(prepared),
            traceId: traceContext?.traceId,
            parentSpanId: traceContext?.parentSpanId,
          }),
        ]
      : [];

  const actionApprovalCursor: ConnectorActionApprovalCursor = { value: 0 };
  const actionApprovalScope =
    prepared.agentMode === "replay" && prepared.agentBaseCheckpoint
      ? buildConnectorActionApprovalScope({
          threadId: prepared.agentBaseCheckpoint.threadId,
          checkpointId: prepared.agentBaseCheckpoint.checkpointId,
        })
      : buildConnectorActionApprovalScope({
          threadId: prepared.agentRunThreadId,
        });
  const actionExecutionCursor: ConnectorActionExecutionCursor | undefined =
    prepared.toolApprovalResume?.sourceweft?.connectorActions?.length
      ? {
          refs: prepared.toolApprovalResume.sourceweft.connectorActions,
          value: 0,
        }
      : undefined;
  const connectorToolContext = {
    actionApprovalCursor,
    actionExecutionCursor,
    actionApprovalScope,
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    userId: prepared.userId,
  };
  const connectorActionTools = filterAllowedTools(
    prepared,
    await createConnectorActionTools(connectorToolContext),
  );

  const mcpToolSelection = prepared.mcpTools;
  const mcpToolRuntime =
    mcpToolSelection.enabled !== false && mcpToolSelection.installIds?.length
      ? await mcpService.buildLangChainToolsForTurn({
          workspaceId: prepared.workspace.id,
          userId: prepared.userId,
          threadId: prepared.thread.id,
          runId: prepared.runTraceId,
          installIds: mcpToolSelection.installIds,
          toolIds: mcpToolSelection.toolIds,
        })
      : null;
  const mcpTools = mcpToolRuntime?.tools ?? [];

  return {
    retrievalTool,
    webTools,
    artifactTools,
    presentationTools,
    videoPresentationTools,
    connectorActionTools,
    mcpTools,
    connectorToolContext,
    mcpToolRuntime,
  };
}
