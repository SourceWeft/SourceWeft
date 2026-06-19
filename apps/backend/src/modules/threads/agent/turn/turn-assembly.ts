import { createThreadAgent } from "..";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { LlmExecutionConfig } from "../../../content/model-gateway-audit";
import type { PreparedThreadTurn } from "../..";
import { SelectedSkillsBackend } from "../../../skills/backend";
import {
  buildConnectorActionToolset,
  type ConnectorActionToolContext,
} from "../../../connectors/agent-tools";
import type {
  ConnectorActionApprovalCursor,
  ConnectorActionExecutionCursor,
} from "../../../connectors/agent-tool-idempotency";
import { buildConnectorActionApprovalScope } from "../../../connectors/agent-tool-idempotency";
import type { SandboxActionExecutionCursor } from "./hitl-handler";
import { mcpService } from "../../../mcp";
import type { TraceContext } from "../../../llm-observability";
import { logger } from "../../../../shared/logger";
import { DatabaseKnowledgeBackend } from "../database-fs-backend";
import {
  listVirtualFsSources,
  type VirtualFsSource,
} from "../database-vfs-store";
import {
  createDefaultFilesystemMounts,
  createSandboxFilesystemMount,
} from "../filesystem-capabilities";
import { MountedAgentFilesystemBackend } from "@sourceweft/builtin-vfs";
import {
  CompositeBackend,
  StateBackend,
  type BackendFactory,
  type BackendProtocolV2,
  type SandboxBackendProtocolV2,
} from "deepagents";
import {
  createCapabilityAgentToolsForTurn,
  type AgentTurnTool,
} from "../capability-agent-tools";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { WorkingFilesBackend } from "../working-files-backend";
import { agentSandboxService } from "../sandbox-service/service";
import type { AgentSandboxRuntimeForTurn } from "@sourceweft/builtin-tool-sandbox";
import { buildAgentRuntimeContext } from "../prompts/agent-runtime-context";
import type { ArtifactToolRuntimePromptProvider } from "../prompts/tool-prompt-provider";
import { commandExecutionPolicyFor } from "./command-success";
import type { AgentRunnableConfig } from "./checkpoint";
import { resolveAgentBaseConfig } from "./checkpoint";
import type { TurnRuntime } from "./turn-runtime";
import { PrefixedBackendAdapter } from "../composite-backend-adapter";
import { filterAllowedTools, isToolDenied } from "./tool-utils";

const MAX_RUNTIME_SOURCE_REFERENCES = 50;

function sandboxExecuteToolCallIdFromResume(
  resume: PreparedThreadTurn["toolApprovalResume"],
) {
  return (
    resume?.sourceweft?.sandboxExecuteToolCallId ??
    resume?.sourceweft?.sandboxActions?.find(
      (action) => action.toolName === AGENT_TOOL_NAMES.execute,
    )?.toolCallId
  );
}

export interface FilesystemBackendInput {
  prepared: PreparedThreadTurn;
  runtime: TurnRuntime;
}

export interface FilesystemBackend {
  backend: MountedAgentFilesystemBackend;
  knowledgeBackend: DatabaseKnowledgeBackend;
  workingFilesBackend: WorkingFilesBackend;
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
    knowledgeBackend: databaseBackend,
    workingFilesBackend,
    filesystemMounts,
    skillsBackend,
  };
}

export function filesystemMountsForPrompt(input: {
  filesystemBackend: FilesystemBackend;
  sandboxRuntime: AgentSandboxRuntimeForTurn | null;
}) {
  if (!input.sandboxRuntime) {
    return input.filesystemBackend.filesystemMounts;
  }
  const sandboxRoot =
    input.sandboxRuntime.pathPolicy.workspaceRoot ||
    input.sandboxRuntime.pathPolicy.defaultCwd ||
    "/workspace";
  return [
    ...input.filesystemBackend.filesystemMounts,
    createSandboxFilesystemMount({ root: sandboxRoot }),
  ];
}

export function buildAgentBackend(input: {
  filesystemBackend: FilesystemBackend;
  executeToolCallId?: string | null;
  sandboxRuntime: AgentSandboxRuntimeForTurn | null;
}): BackendProtocolV2 {
  const { executeToolCallId, filesystemBackend, sandboxRuntime } = input;
  if (!sandboxRuntime) {
    return filesystemBackend.backend;
  }

  const defaultBackend = executeToolCallId
    ? new SandboxExecuteToolCallBackend(
        sandboxRuntime.backend,
        executeToolCallId,
      )
    : sandboxRuntime.backend;

  return new CompositeBackend(defaultBackend, {
    "/conversation_history/": new PrefixedBackendAdapter(
      "/conversation_history",
      new StateBackend(),
    ),
    "/large_tool_results/": new PrefixedBackendAdapter(
      "/large_tool_results",
      new StateBackend(),
    ),
    "/kb/": new PrefixedBackendAdapter(
      "/kb",
      filesystemBackend.knowledgeBackend,
    ),
    "/workfiles/": new PrefixedBackendAdapter(
      "/workfiles",
      filesystemBackend.workingFilesBackend,
    ),
    ...(filesystemBackend.skillsBackend
      ? { "/skills/": filesystemBackend.skillsBackend }
      : {}),
  });
}

class SandboxExecuteToolCallBackend implements SandboxBackendProtocolV2 {
  readonly id: string;

  constructor(
    private readonly backend: AgentSandboxRuntimeForTurn["backend"],
    private readonly toolCallId: string,
  ) {
    this.id = backend.id;
  }

  ls(path: string) {
    return this.backend.ls(path);
  }

  read(filePath: string, offset?: number, limit?: number) {
    return this.backend.read(filePath, offset, limit);
  }

  readRaw(filePath: string) {
    return this.backend.readRaw(filePath);
  }

  grep(pattern: string, path?: string | null, glob?: string | null) {
    return this.backend.grep(pattern, path, glob);
  }

  glob(pattern: string, path?: string) {
    return this.backend.glob(pattern, path);
  }

  write(filePath: string, content: string) {
    return this.backend.write(filePath, content);
  }

  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ) {
    return this.backend.edit(filePath, oldString, newString, replaceAll);
  }

  uploadFiles(files: Array<[string, Uint8Array]>) {
    if (!this.backend.uploadFiles) {
      throw new Error("Backend does not support uploadFiles");
    }
    return this.backend.uploadFiles(files);
  }

  downloadFiles(paths: string[]) {
    if (!this.backend.downloadFiles) {
      throw new Error("Backend does not support downloadFiles");
    }
    return this.backend.downloadFiles(paths);
  }

  execute(command: string) {
    return this.backend.execute(command, { toolCallId: this.toolCallId });
  }
}

export function buildAgentBackendFactory(input: {
  filesystemBackend: FilesystemBackend;
  sandboxRuntime: AgentSandboxRuntimeForTurn | null;
}): BackendFactory {
  return (runtime) => {
    const runtimeRecord =
      runtime && typeof runtime === "object"
        ? (runtime as unknown as { toolCallId?: unknown })
        : null;
    const toolCallId =
      typeof runtimeRecord?.toolCallId === "string"
        ? runtimeRecord.toolCallId
        : null;
    return buildAgentBackend({
      ...input,
      executeToolCallId: toolCallId,
    });
  };
}

export interface RuntimePromptContextInput {
  prepared: PreparedThreadTurn;
  toolCollection: ToolCollection;
  sandboxRuntime: AgentSandboxRuntimeForTurn | null;
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
  const { webTools, artifactTools, mcpTools, promptProviders } = toolCollection;

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

  const sandboxPromptProvider = sandboxRuntime
    ? () => sandboxRuntime.buildRuntimePrompt()
    : undefined;

  const runtimePrompt = buildAgentRuntimeContext({
    availableWebTools: webTools.map((tool) => tool.name),
    availableArtifactTools: artifactTools.map((tool) => tool.name),
    artifactToolRuntimePromptProviders: promptProviders,
    availableMcpTools: mcpTools.map((tool) => tool.name),
    artifactIntent: prepared.artifactIntent,
    runtimeTools: prepared.runtimeTools,
    commandSuccessCriteria: prepared.commandSuccessCriteria,
    enabledSkills: prepared.enabledSkills,
    invokedSkillIds: prepared.invokedSkillIds,
    toolRuntimePromptProviders: sandboxPromptProvider
      ? [sandboxPromptProvider]
      : [],
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
  filesystemBackend?: FilesystemBackend;
  llm?: LlmExecutionConfig;
  traceContext?: TraceContext;
  runtime: TurnRuntime;
  sandboxRuntime: AgentSandboxRuntimeForTurn | null;
}

export interface ToolCollection {
  capabilityTools: AgentTurnTool[];
  webTools: AgentTurnTool[];
  artifactTools: AgentTurnTool[];
  promptProviders: ArtifactToolRuntimePromptProvider[];
  connectorActionTools: Awaited<
    ReturnType<typeof buildConnectorActionToolset>
  >["tools"];
  connectorInterruptOn: Awaited<
    ReturnType<typeof buildConnectorActionToolset>
  >["interruptOn"];
  mcpTools: Awaited<
    ReturnType<typeof mcpService.buildLangChainToolsForTurn>
  >["tools"];
  connectorToolContext: ConnectorActionToolContext;
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
  sandboxRuntime: AgentSandboxRuntimeForTurn | null;
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
}): AgentSandboxRuntimeForTurn | null {
  const { prepared, filesystemBackend } = input;
  const sandboxRuntime = isToolDenied(prepared, AGENT_TOOL_NAMES.execute)
    ? null
    : agentSandboxService.createRuntimeForTurn({
        filesystem: filesystemBackend.backend,
        context: {
          teamId: prepared.workspace.organizationId,
          workspaceId: prepared.workspace.id,
          threadId: prepared.thread.id,
          userId: prepared.userId,
          messageId: prepared.userMessage.id,
          runId: prepared.runTraceId,
          sandboxExecuteToolCallId: sandboxExecuteToolCallIdFromResume(
            prepared.toolApprovalResume,
          ),
        },
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

  const filesystemBackend = buildFilesystemBackend({
    prepared,
    runtime,
  });

  const sandboxRuntime = buildSandboxRuntimeForPreparedTurn({
    prepared,
    filesystemBackend,
  });

  const toolCollection = await buildToolCollection({
    prepared,
    billing,
    filesystemBackend,
    llm,
    traceContext,
    runtime,
    sandboxRuntime,
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
    capabilityTools,
    connectorActionTools,
    connectorInterruptOn,
    mcpTools,
    mcpToolRuntime,
  } = toolCollection;
  const { skillsBackend } = filesystemBackend;
  const promptFilesystemMounts = filesystemMountsForPrompt({
    filesystemBackend,
    sandboxRuntime,
  });
  const backend = buildAgentBackendFactory({
    filesystemBackend,
    sandboxRuntime,
  });
  const boundTools = [
    ...filterAllowedTools(prepared, capabilityTools),
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
    ...connectorInterruptOn,
  };
  if (sandboxRuntime) {
    agentSandboxService.warnIfHitlBypassed({
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
    filesystemMounts: promptFilesystemMounts,
    skills: skillsBackend ? ["/skills/"] : undefined,
    runtimePrompt,
    chatProfileConfig: prepared.chatProfile.configJson,
    commandExecutionPolicy: commandExecutionPolicyFor(prepared),
    contextCompressionReportKey: prepared.userMessage.id,
    traceContext,
    toolObservabilityContext: {
      runId: prepared.runTraceId,
      teamId: prepared.workspace.organizationId,
      workspaceId: prepared.workspace.id,
      threadId: prepared.thread.id,
      userId: prepared.userId,
      userMessageId: prepared.userMessage.id,
    },
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
        selected_skill_ids: prepared.enabledSkills.map(
          (skill) => skill.workspaceSkillId,
        ),
        skill_ids: prepared.enabledSkills.map(
          (skill) => skill.workspaceSkillId,
        ),
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
      selected_skill_ids: prepared.enabledSkills.map(
        (skill) => skill.workspaceSkillId,
      ),
      skill_ids: prepared.enabledSkills.map((skill) => skill.workspaceSkillId),
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
  const {
    prepared,
    billing,
    filesystemBackend,
    llm,
    traceContext,
    runtime,
    sandboxRuntime,
  } = input;

  const capabilityAgentTools = await createCapabilityAgentToolsForTurn({
    prepared,
    billing,
    filesystemBackend,
    llm,
    traceContext,
    runtime,
    sandboxRuntime,
  });

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
  const sandboxActionExecutionCursor: SandboxActionExecutionCursor | undefined =
    prepared.toolApprovalResume?.sourceweft?.sandboxActions?.length
      ? {
          refs: prepared.toolApprovalResume.sourceweft.sandboxActions,
          value: 0,
        }
      : undefined;
  const connectorToolContext = {
    actionApprovalCursor,
    actionExecutionCursor,
    actionApprovalScope,
    approvedSandboxToolCallId: sandboxExecuteToolCallIdFromResume(
      prepared.toolApprovalResume,
    ),
    sandboxActionExecutionCursor,
    sourceUserMessageId: prepared.userMessage.id,
    ...(prepared.assistantMessageId
      ? { sourceAssistantMessageId: prepared.assistantMessageId }
      : {}),
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    userId: prepared.userId,
  };
  const connectorActionToolset =
    await buildConnectorActionToolset(connectorToolContext);
  const connectorActionTools = filterAllowedTools(
    prepared,
    connectorActionToolset.tools,
  );

  const mcpToolRuntime =
    prepared.mcpInstallIds.length > 0
      ? await mcpService.buildLangChainToolsForTurn({
          workspaceId: prepared.workspace.id,
          userId: prepared.userId,
          threadId: prepared.thread.id,
          runId: prepared.runTraceId,
          installIds: prepared.mcpInstallIds,
        })
      : null;
  const mcpTools = mcpToolRuntime?.tools ?? [];

  return {
    capabilityTools: [...capabilityAgentTools.tools],
    webTools: [...capabilityAgentTools.webTools],
    artifactTools: [...capabilityAgentTools.artifactTools],
    promptProviders: [...capabilityAgentTools.promptProviders],
    connectorActionTools,
    connectorInterruptOn: connectorActionToolset.interruptOn,
    mcpTools,
    connectorToolContext,
    mcpToolRuntime,
  };
}
