import { createThreadAgent } from "..";
import { createFileReader } from "../file-reader";
import type { AgentCitationRegistry } from "../citation-registry";
import { createFileDocumentTools } from "../file-document-tools";
import { workingFilesService } from "../../../working-files";
import { createViewImageTool, FileImageContext } from "../file-images";
import { assertThreadSourceSelection } from "../../source-selection-service";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { LlmExecutionConfig } from "../../../content/model-gateway-audit";
import type { PreparedThreadTurn } from "../..";
import type { RunCancellationGate } from "../../run-cancellation";
import { SelectedSkillsBackend } from "../../../skills/backend";
import {
  buildSkillAgentTools,
  createSkillToolInterruptConfigs,
} from "../../../skills/agent-tools";
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
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { StructuredToolInterface } from "@langchain/core/tools";
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
  filesystemPermissionsForMounts,
} from "../filesystem-capabilities";
import { MountedAgentFilesystemBackend } from "@sourceweft/builtin-vfs";
import {
  CompositeBackend,
  StateBackend,
  type BackendProtocolV2,
  type SandboxBackendProtocolV2,
  type SkillMetadata,
} from "deepagents";
import { Overwrite } from "@langchain/langgraph";
import {
  createCapabilityAgentToolsForTurn,
  type AgentTurnTool,
} from "../capability-agent-tools";
import {
  AGENT_TOOL_NAMES,
  getAgentToolDefinition,
} from "@sourceweft/agent-tool-registry";
import { WorkingFilesBackend } from "../working-files-backend";
import { agentSandboxService } from "../sandbox-service/service";
import { listArtifactSummaryRecords } from "../../../artifacts/repository";
import type { AgentSandboxRuntimeForTurn } from "@sourceweft/builtin-tool-sandbox";
import { buildSkillSandboxAssetPlans } from "../../../skills/sandbox-assets";
import { buildRequiredSandboxRuntimeAssetPlans } from "../../../../shared/sandbox-assets/plans";
import { config } from "../../../../shared/config";
import { createSourceWeftSubagentMiddlewareStack } from "../middleware";
import { createGeneralPurposeSubagent } from "../subagents/general-purpose";
import { createExploreSubagent } from "../subagents/explore";
import { createPlanSubagent } from "../subagents/plan";
import { filterToolsForPersona } from "../personas";
import { buildAgentRuntimeContext } from "../prompts/agent-runtime-context";
import type { ArtifactToolRuntimePromptProvider } from "../prompts/tool-prompt-provider";
import { commandExecutionPolicyFor } from "./command-success";
import type { AgentRunnableConfig } from "./checkpoint";
import { resolveAgentBaseConfig } from "./checkpoint";
import type { TurnRuntime } from "./turn-runtime";
import { PrefixedBackendAdapter } from "../composite-backend-adapter";
import {
  filterAllowedTools,
  filterCommandPolicyTools,
  filterInheritableAgentTools,
  getToolPermission,
  isToolDenied,
} from "./tool-utils";
import {
  INTERPRETER_MAX_TOOL_NAMES,
  type InterpreterReadToolName,
} from "@sourceweft/agent-interpreter";
import { createInterpreterMiddlewareForTurn } from "../interpreter";
import {
  currentSourceWeftToolCallId,
  currentSourceWeftToolInvocationSignal,
} from "../middleware";
import { ContentError } from "../../../content/errors";

const MAX_RUNTIME_SOURCE_REFERENCES = 50;

// The sandbox backend's operation-claim key when approval is enabled (NOT an
// approval-correlation id): the resumed `execute` claims its run under the
// approved args-ref's stable id. One key per turn build, mirroring the prior
// single-scalar behavior.
function sandboxExecuteToolCallIdFromResume(
  resume: PreparedThreadTurn["toolApprovalResume"],
) {
  return resume?.sourceweft?.sandboxActions?.find(
    (action) => action.toolName === AGENT_TOOL_NAMES.execute,
  )?.toolCallId;
}

export interface FilesystemBackendInput {
  prepared: PreparedThreadTurn;
  runtime: TurnRuntime;
}

export interface FilesystemBackend {
  citationRegistry: AgentCitationRegistry;
  backend: MountedAgentFilesystemBackend;
  knowledgeBackend: DatabaseKnowledgeBackend;
  workingFilesBackend: WorkingFilesBackend;
  localFiles: boolean;
  filesystemMounts: ReturnType<typeof createDefaultFilesystemMounts>;
  skillsBackend: SelectedSkillsBackend;
}

export function buildFilesystemBackend(
  input: FilesystemBackendInput,
): FilesystemBackend {
  const { prepared, runtime } = input;

  const databaseBackend = new DatabaseKnowledgeBackend({
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    sourceIds: prepared.sourceIds,
    validateScope: () => assertThreadSourceSelection({
      workspaceId: prepared.workspace.id,
      threadId: prepared.thread.id,
      userId: prepared.userId,
      revision: prepared.sourceSelectionRevision,
    }),
    citationRegistry: runtime.citationRegistry,
  });

  const workingFilesBackend = new WorkingFilesBackend({
    teamId: prepared.workspace.organizationId,
    workspaceId: prepared.workspace.id,
    threadId: prepared.thread.id,
    userId: prepared.userId,
    citationRegistry: runtime.citationRegistry,
  });

  // Always present, even with nothing enabled: `install_skill` mounts what it
  // installs into this backend so the skill is readable within the same turn.
  // The advertised mount list and the skills prompt section still follow what
  // the turn STARTED with, so a turn without skills keeps its prompt unchanged.
  const skillsBackend = new SelectedSkillsBackend(prepared.enabledSkills);

  const localFiles = prepared.thread.executionTarget?.kind === "local";
  const filesystemMounts = createDefaultFilesystemMounts({
    skillsEnabled: prepared.enabledSkills.length > 0,
  }).filter((mount) => !localFiles || mount.backendKind !== "workfiles");

  const backend = new MountedAgentFilesystemBackend({
    knowledge: databaseBackend,
    working: localFiles ? null : workingFilesBackend,
    skills: skillsBackend,
    mounts: filesystemMounts,
  });

  return {
    backend,
    citationRegistry: runtime.citationRegistry,
    knowledgeBackend: databaseBackend,
    workingFilesBackend,
    localFiles,
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
    {
      ...createSandboxFilesystemMount({ root: sandboxRoot }),
      ...(input.filesystemBackend.localFiles
        ? {
            label: "Files",
            citable: true,
            citationPolicy: "Use read_document, search_files or view_image for versioned File citations. These are references to task files, not Source Library evidence.",
            persisted: true,
            userVisible: true,
            threadScoped: false,
            purpose:
              "Physical files on the bound PC, shared by file tools and command execution. This directory is the only working-file store for this conversation.",
            writePolicy:
              "Write and edit files directly under this physical directory. No prepare or collect step is needed. External edits are visible on the next read.",
            pathPolicy:
              "Use real paths under this working directory. Files remain on this PC and are not automatically synchronized or published.",
          }
        : {}),
    },
  ];
}

export function buildAgentBackend(input: {
  filesystemBackend: FilesystemBackend;
  /** Test seam; production uses a LangGraph-context-aware StateBackend. */
  internalContextBackend?: BackendProtocolV2;
  executeToolCallId?: string | null;
  sandboxRuntime: AgentSandboxRuntimeForTurn | null;
}): BackendProtocolV2 {
  const {
    executeToolCallId,
    filesystemBackend,
    internalContextBackend = new StateBackend(),
    sandboxRuntime,
  } = input;
  const defaultBackend = sandboxRuntime
    ? new TurnScopedSandboxBackend(sandboxRuntime.backend, executeToolCallId)
    : filesystemBackend.backend;
  const sandboxRoot = sandboxRuntime
    ? sandboxRuntime.pathPolicy.workspaceRoot ||
      sandboxRuntime.pathPolicy.defaultCwd ||
      "/workspace"
    : "/";

  return new CompositeBackend(defaultBackend, {
    // Deep Agents uses these paths to preserve context that no longer fits in
    // the model request. They must be backed by LangGraph state even when the
    // turn has no execution sandbox; the mounted SourceWeft VFS deliberately
    // permits writes only under /files.
    "/conversation_history/": new PrefixedBackendAdapter(
      "/conversation_history",
      internalContextBackend,
    ),
    "/large_tool_results/": new PrefixedBackendAdapter(
      "/large_tool_results",
      internalContextBackend,
    ),
    "/kb/": new PrefixedBackendAdapter(
      "/kb",
      filesystemBackend.knowledgeBackend,
    ),
    ...(!filesystemBackend.localFiles
      ? {
          "/files/": new PrefixedBackendAdapter(
            "/files",
            filesystemBackend.workingFilesBackend,
          ),
        }
      : {}),
    "/skills/": filesystemBackend.skillsBackend,
    ...(sandboxRuntime
      ? {
          "/": new PrefixedBackendAdapter("/", defaultBackend),
          ...(sandboxRoot === "/"
            ? {}
            : {
                [`${sandboxRoot.replace(/\/+$/g, "")}/`]:
                  new PrefixedBackendAdapter(sandboxRoot, defaultBackend),
              }),
        }
      : {}),
  });
}

class TurnScopedSandboxBackend implements SandboxBackendProtocolV2 {
  readonly id: string;

  constructor(
    private readonly backend: AgentSandboxRuntimeForTurn["backend"],
    private readonly fallbackToolCallId: string | null = null,
  ) {
    this.id = backend.id;
  }

  ls(path: string) {
    return this.backend.ls(path, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  read(filePath: string, offset?: number, limit?: number) {
    return this.backend.read(filePath, offset, limit, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  readRaw(filePath: string) {
    return this.backend.readRaw(filePath, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  grep(
    pattern: string,
    path?: string | null,
    glob?: string | null,
    maxCount?: number | null,
  ) {
    return this.backend.grep(pattern, path, glob, maxCount, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  glob(pattern: string, path?: string) {
    return this.backend.glob(pattern, path, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  write(filePath: string, content: string) {
    return this.backend.write(filePath, content, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ) {
    return this.backend.edit(filePath, oldString, newString, replaceAll, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  uploadFiles(files: Array<[string, Uint8Array]>) {
    if (!this.backend.uploadFiles) {
      throw new Error("Backend does not support uploadFiles");
    }
    return this.backend.uploadFiles(files, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  downloadFiles(paths: string[]) {
    if (!this.backend.downloadFiles) {
      throw new Error("Backend does not support downloadFiles");
    }
    return this.backend.downloadFiles(paths, {
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }

  execute(command: string) {
    return this.backend.execute(command, {
      toolCallId: currentSourceWeftToolCallId() ?? this.fallbackToolCallId,
      signal: currentSourceWeftToolInvocationSignal(),
    });
  }
}

export function skillMetadataForTurn(
  skills: PreparedThreadTurn["enabledSkills"],
): SkillMetadata[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    path: `/skills/${skill.name}/SKILL.md`,
    ...(skill.tools?.length ? { allowedTools: [...skill.tools] } : {}),
  }));
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

  // Operational locators must survive history/tool-output compression. Read
  // only artifacts this user can see in this thread, not the whole workspace.
  const publishedArtifacts =
    artifactTools.length > 0
      ? (
          await listArtifactSummaryRecords({
            teamId: prepared.workspace.organizationId,
            workspaceId: prepared.workspace.id,
            threadId: prepared.thread.id,
            viewerUserId: prepared.userId,
            limit: 20,
          })
        ).items.filter((artifact) => artifact.status === "ready")
      : [];

  const runtimePrompt = buildAgentRuntimeContext({
    availableWebTools: webTools.map((tool) => tool.name),
    availableArtifactTools: artifactTools.map((tool) => tool.name),
    artifactToolRuntimePromptProviders: promptProviders,
    availableMcpTools: mcpTools.map((tool) => tool.name),
    turnState: prepared.turnState,
    runtimeTools: prepared.runtimeTools,
    commandSuccessCriteria: prepared.commandSuccessCriteria,
    enabledSkills: prepared.enabledSkills,
    invokedSkillIds: prepared.invokedSkillIds,
    skillCatalogAvailable: filterAllowedTools(
      prepared,
      toolCollection.skillTools,
    ).some((tool) => tool.name === "search_skills"),
    toolRuntimePromptProviders: sandboxPromptProvider
      ? [sandboxPromptProvider]
      : [],
    timezone: prepared.timezone,
    selectedSources: visibleSources,
    selectedSourcesOmitted,
    publishedArtifacts,
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
  runCancellation?: RunCancellationGate;
}

export interface ToolCollection {
  capabilityTools: AgentTurnTool[];
  skillTools: AgentTurnTool[];
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
  /** Billed chat model for this turn; see CreateThreadAgentParams.model. */
  model: BaseLanguageModel;
  /** Aborts `agent.stream` (LLM + signal-aware tools) when the run is cancelled. */
  abortSignal?: AbortSignal;
}

export interface ThreadAgentAssembly {
  agent: Awaited<ReturnType<typeof createThreadAgent>>;
  agentMessages: Array<{ role: "user"; content: unknown }>;
  baseConfig: AgentRunnableConfig;
  runConfig: AgentRunnableConfig;
  runAgentStream: (
    messages: Array<{ role: "user"; content: unknown }>,
  ) => Promise<unknown>;
}

/**
 * Skill-bundle staging request for the turn
 * (docs/architecture/sandbox-skill-staging.md). Null when no enabled skill
 * has a stageable bundle — the runtime then behaves exactly as before
 * staging existed; on images without a pre-created /skills the runtime
 * degrades safely per plan. Plans are prebuilt (KB-scale, content-cached) so
 * the callback the manager invokes at sandbox acquisition is trivially cheap.
 */
function skillAssetsForPreparedTurn(prepared: PreparedThreadTurn) {
  const plans = buildSkillSandboxAssetPlans(prepared.enabledSkills);
  if (plans.length === 0) {
    return null;
  }
  return {
    plans: async () => plans,
    logger: {
      info: (message: string, meta?: Record<string, unknown>) =>
        logger.info(message, meta),
      warn: (message: string, meta?: Record<string, unknown>) =>
        logger.warn(message, meta),
    },
  };
}

export async function buildSandboxRuntimeForPreparedTurn(input: {
  prepared: PreparedThreadTurn;
  filesystemBackend: FilesystemBackend;
}): Promise<AgentSandboxRuntimeForTurn | null> {
  const { prepared, filesystemBackend } = input;
  const skillAssets = skillAssetsForPreparedTurn(prepared);
  const sandboxCandidateTools = new Set([
    ...(prepared.command?.workflow?.defaultTools ?? []),
    ...Object.values(prepared.runtimeTools)
      .filter((runtimeTool) => runtimeTool.shouldBind)
      .map((runtimeTool) => runtimeTool.toolName),
  ]);
  const commandNeedsTrustedSandbox = [...sandboxCandidateTools].some(
    (toolName) => {
      const definition = getAgentToolDefinition(toolName);
      return (
        definition?.executionScope === "root_only" &&
        definition.capabilities.includes("sandbox_execute")
      );
    },
  );
  const requiredRuntimeAssetNames = [...sandboxCandidateTools].flatMap(
    (toolName) => getAgentToolDefinition(toolName)?.sandboxRuntimeAssets ?? [],
  );
  const requiredRuntimeAssetPlans = buildRequiredSandboxRuntimeAssetPlans(
    requiredRuntimeAssetNames,
  );
  const runtimeAssets =
    requiredRuntimeAssetPlans.length > 0
      ? {
          plans: async () => requiredRuntimeAssetPlans,
          logger: {
            info: (message: string, meta?: Record<string, unknown>) =>
              logger.info(message, meta),
            warn: (message: string, meta?: Record<string, unknown>) =>
              logger.warn(message, meta),
          },
        }
      : null;
  const sandboxRuntime =
    prepared.thread.executionTarget?.kind !== "local" &&
    isToolDenied(prepared, AGENT_TOOL_NAMES.execute) &&
    !commandNeedsTrustedSandbox
      ? null
      : await agentSandboxService.createRuntimeForTurn({
          executionTarget: prepared.thread.executionTarget ?? { kind: "cloud" },
          filesystem: filesystemBackend.backend,
          context: {
            localCaller: prepared.localCaller,
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
          artifacts: {
            // Workspace-scoped on purpose: an artifactId arriving from tool
            // input can only reach rows this turn's workspace could already see.
            readPrimaryBytes: async ({ artifactId, artifactVersionId }) => {
              try {
                const { contentArtifactsService } =
                  await import("../../../artifacts");
                const file = await contentArtifactsService.getArtifactFile({
                  workspaceId: prepared.workspace.id,
                  userId: prepared.userId,
                  artifactId,
                  artifactVersionId,
                });
                return {
                  bytes: file.body,
                  fileName: file.fileName,
                  ...("artifactVersionId" in file
                    ? {
                        artifactVersionId: file.artifactVersionId,
                        versionNo: file.versionNo,
                        contentDigest: file.contentDigest,
                      }
                    : {}),
                };
              } catch (error) {
                if (
                  error instanceof ContentError &&
                  (error.statusCode === 404 || error.statusCode === 403)
                )
                  return null;
                throw error;
              }
            },
          },
          ...(skillAssets ? { skillAssets } : {}),
          ...(runtimeAssets ? { runtimeAssets } : {}),
        });

  if (sandboxRuntime) {
    sandboxRuntime.tools = filterAllowedTools(prepared, sandboxRuntime.tools);
  }

  return sandboxRuntime;
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
    model,
    abortSignal,
  } = input;
  const {
    capabilityTools,
    skillTools,
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
  const backend = buildAgentBackend({
    filesystemBackend,
    sandboxRuntime,
    executeToolCallId: sandboxExecuteToolCallIdFromResume(
      prepared.toolApprovalResume,
    ),
  });
  const filesystemPermissions = filesystemPermissionsForMounts(
    promptFilesystemMounts,
  );
  const fileImages = new FileImageContext();
  const fileRoot = filesystemBackend.localFiles ? sandboxRuntime?.pathPolicy.workspaceRoot : "/files";
  const fileScopeId = JSON.stringify([prepared.workspace.organizationId, prepared.workspace.id, prepared.thread.id]);
  const fileReader = fileRoot ? createFileReader({
    backend, root: fileRoot, backendKind: filesystemBackend.localFiles ? "local_fs" : "cloud_vfs", scopeId: fileScopeId, signal: abortSignal,
    download: filesystemBackend.localFiles
      ? (path, signal) => sandboxRuntime!.trustedHost.downloadCurrentFile({ sandboxPath: path, signal })
      : async (path, signal) => { const { file, bytes } = await workingFilesService.readBytes({ workspaceId: prepared.workspace.id, threadId: prepared.thread.id, userId: prepared.userId, path, signal }); return { bytes, metadata: { fileId: file.id, origin: file.origin, revision: `sha256:${file.contentHash}` } }; },
  }) : null;
  const fileTools = fileReader && fileRoot ? [
    createViewImageTool({ read: fileReader, images: fileImages, signal: abortSignal, citationRegistry: filesystemBackend.citationRegistry, supportsImageInput: (prepared.chatProfile.configJson as Record<string, unknown> | null)?.supportsImageInput === true }),
    ...createFileDocumentTools({ read: fileReader, backend, root: fileRoot, scopeId: fileScopeId, signal: abortSignal, citationRegistry: filesystemBackend.citationRegistry,
      nativeSearch: filesystemBackend.localFiles ? async (paths, query, signal) => {
        const target = prepared.thread.executionTarget;
        if (target?.kind !== "local" || !sandboxRuntime) throw new ContentError(409, "LOCAL_FILES_UNAVAILABLE", "The bound computer is unavailable.");
        const result = await sandboxRuntime.backend.searchNativeFiles(paths, query, { literal: true, ignoreCase: true, firstPerFile: true, signal });
        return { matchedPaths: result.matches.map((match) => match.path), visitedPaths: result.visitedPaths, skipped: result.skipped };
      } : undefined,
    }),
  ] : [];
  // A persona-owned thread binds only the persona's allowlisted tools. The
  // permissions already deny registry tools it may not use; this pass also drops
  // connector, MCP, and sandbox tools, which are bound under their own names.
  const persona = prepared.persona ?? null;
  const boundTools = filterToolsForPersona(
    persona,
    filterCommandPolicyTools(prepared, [
      ...filterAllowedTools(prepared, fileTools),
      ...filterAllowedTools(prepared, capabilityTools),
      ...filterAllowedTools(prepared, skillTools),
      ...connectorActionTools,
      ...mcpTools,
      ...(sandboxRuntime?.tools ?? []),
    ]),
  );
  const inheritableTools = filterInheritableAgentTools(boundTools);
  const searchSourcesTool = boundTools.find(
    (candidate) => candidate.name === AGENT_TOOL_NAMES.searchSources,
  ) as StructuredToolInterface | undefined;
  const interpreterAllowedTools = INTERPRETER_MAX_TOOL_NAMES.filter(
    (toolName): toolName is InterpreterReadToolName =>
      getToolPermission(prepared, toolName) === "allow" &&
      (toolName !== AGENT_TOOL_NAMES.searchSources ||
        Boolean(searchSourcesTool)),
  );
  const interpreterMiddleware = createInterpreterMiddlewareForTurn({
    allowedTools: interpreterAllowedTools,
    backend: filesystemBackend.localFiles ? backend : filesystemBackend.backend,
    readRoots: filesystemBackend.localFiles
      ? [
          "/kb",
          ...(sandboxRuntime ? [sandboxRuntime.pathPolicy.workspaceRoot] : []),
        ]
      : undefined,
    context: {
      runId: prepared.runTraceId,
      teamId: prepared.workspace.organizationId,
      workspaceId: prepared.workspace.id,
      threadId: prepared.thread.id,
      turnId: prepared.userMessage.id,
      userId: prepared.userId,
    },
    searchSourcesTool,
    traceContext,
  });
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
    ...createSkillToolInterruptConfigs(),
  };
  if (sandboxRuntime) {
    agentSandboxService.warnIfHitlBypassed({
      interruptOn,
      boundSandboxToolNames: sandboxRuntime.tools.map((tool) => tool.name),
    });
  }

  const skills = prepared.enabledSkills.length > 0 ? ["/skills/"] : undefined;
  const childMiddleware = (subagentType: string) =>
    [fileImages.middleware(), ...createSourceWeftSubagentMiddlewareStack({
      backend,
      chatProfileConfig: prepared.chatProfile.configJson,
      model,
      traceContext,
      toolObservabilityContext: {
        runId: prepared.runTraceId,
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        threadId: prepared.thread.id,
        userId: prepared.userId,
        userMessageId: prepared.userMessage.id,
        subagentType,
      },
    })];

  // Define general-purpose explicitly so child retries, limits, summary policy,
  // billing model, skills, HITL, and observability do not depend on Deep Agents'
  // partial parent-middleware propagation. The roster mirrors Claude's Agent
  // tool: general-purpose (full) plus the read-only explore and plan delegates.
  const subagents = [
    createGeneralPurposeSubagent({
      availableTools: inheritableTools,
      interruptOn,
      middleware: childMiddleware("general-purpose"),
      skills,
    }),
    createExploreSubagent({
      availableTools: inheritableTools,
      backend,
      middleware: childMiddleware("explore"),
      workingDirectory: filesystemBackend.localFiles
        ? sandboxRuntime?.pathPolicy.workspaceRoot
        : undefined,
    }),
    createPlanSubagent({
      availableTools: inheritableTools,
      backend,
      middleware: childMiddleware("plan"),
      workingDirectory: filesystemBackend.localFiles
        ? sandboxRuntime?.pathPolicy.workspaceRoot
        : undefined,
    }),
  ];

  const agent = await createThreadAgent({
    model,
    modelAlias: prepared.modelAlias,
    providerModel: prepared.providerModel,
    gatewayConfigId: prepared.chatProfile.gatewayConfigId,
    tools: boundTools,
    subagents,
    backend,
    filesystemMounts: promptFilesystemMounts,
    skills,
    permissions: persona?.filesystemPermissions
      ? [...persona.filesystemPermissions]
      : filesystemPermissions,
    runtimePrompt,
    personaPrompt: persona?.systemPrompt,
    chatProfileConfig: prepared.chatProfile.configJson,
    commandExecutionPolicy: commandExecutionPolicyFor(prepared),
    extraMiddleware: [...interpreterMiddleware, fileImages.middleware()],
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
        skill_versions: prepared.enabledSkills.map((skill) => ({
          skillId: skill.workspaceSkillId,
          versionId: skill.skillVersionId,
          version: skill.version,
        })),
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
      skill_versions: prepared.enabledSkills.map((skill) => ({
        skillId: skill.workspaceSkillId,
        versionId: skill.skillVersionId,
        version: skill.version,
      })),
    },
    // Consumed via `agent.streamEvents(…, { version: "v3" })` (see
    // `runAgentStream`). v3 is built on `graph.stream({ subgraphs: true })`, so a
    // `task` delegate's tool events still arrive namespaced
    // `["tools:<branchId>", …]` and the runner reuses subagent-namespace.ts to
    // group each sub-agent's tool calls under its own card — the same
    // load-bearing guard drops every sub-agent event EXCEPT `tools`. `streamMode`
    // is no longer set: v3 exposes messages/tools/custom/updates/checkpoints on
    // one normalized ProtocolEvent stream.
    // Cancels the LLM stream and stops scheduling further steps when the run is
    // aborted. The tool-timeout middleware merges this signal into its Host
    // configurable side channel so tool cleanup can settle before invoke ends.
    ...(abortSignal ? { signal: abortSignal } : {}),
  } satisfies AgentRunnableConfig;

  const runAgentStream = (
    messages: Array<{ role: "user"; content: unknown }>,
  ) => {
    const stream = async () => {
      let effectiveRunConfig = runConfig as AgentRunnableConfig;
      if (skills) {
        const checkpointConfig = await agent.updateState(effectiveRunConfig, {
          skillsMetadata: new Overwrite(
            skillMetadataForTurn(prepared.enabledSkills),
          ),
        });
        if (!checkpointConfig || typeof checkpointConfig !== "object") {
          throw new ContentError(
            500,
            "SKILL_CHECKPOINT_UPDATE_FAILED",
            "Deep Agents did not return a checkpoint configuration after replacing turn skills",
            { recoverable: true },
          );
        }
        const checkpointRunConfig = checkpointConfig as AgentRunnableConfig;
        effectiveRunConfig = {
          ...runConfig,
          ...checkpointRunConfig,
          configurable: {
            ...((runConfig as { configurable?: Record<string, unknown> })
              .configurable ?? {}),
            ...((
              checkpointRunConfig as {
                configurable?: Record<string, unknown>;
              }
            ).configurable ?? {}),
          },
        } as AgentRunnableConfig;
      }
      return agent.streamEvents({ messages: messages as never }, {
        ...effectiveRunConfig,
        version: "v3",
      } as never) as Promise<unknown>;
    };
    return stream();
  };

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
    runCancellation,
  } = input;

  const capabilityAgentTools = await createCapabilityAgentToolsForTurn({
    prepared,
    billing,
    filesystemBackend,
    llm,
    traceContext,
    runtime,
    sandboxRuntime,
    runCancellation,
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
          ...(prepared.toolApprovalResume?.sourceweft?.mcpActions?.length
            ? { mcpActions: prepared.toolApprovalResume.sourceweft.mcpActions }
            : {}),
        })
      : null;
  const mcpTools = mcpToolRuntime?.tools ?? [];

  return {
    capabilityTools: [...capabilityAgentTools.tools],
    skillTools: buildSkillAgentTools({
      teamId: prepared.workspace.organizationId,
      workspaceId: prepared.workspace.id,
      userId: prepared.userId,
      ...(filesystemBackend
        ? {
            mountSkill: (skill) =>
              filesystemBackend.skillsBackend.addSkill(skill),
          }
        : {}),
    }),
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
