import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  getCapabilityContributions,
  type DiscoveredCapabilityRecord,
} from "@sourceweft/capability-runtime";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContentBillingPort } from "../../content/billing-port";
import type { LlmExecutionConfig } from "../../content/model-gateway-audit";
import type { PreparedThreadTurn } from "..";
import {
  createPendingArtifactRecord,
  createReadyArtifactRecord,
  findArtifactRecord,
  findReusableArtifactRecord,
} from "../../artifacts/repository";
import { openArtifact, publishArtifact } from "../../artifacts/publish";
import { enqueueDeliverableJob } from "../../content/queue";
import { artifactStorage } from "../../sources/storage";
import { createDefaultWebProvider } from "../../sources/web-provider";
import { listCapabilityRecords } from "../turn/capability-command-workflows";
import { loadBuiltinCapabilityModule } from "@sourceweft/agent-tool-registry";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import type { TraceContext } from "../../llm-observability";
import {
  withBilledModelGateway,
  type BilledModelGateway,
} from "../../../shared/model-gateway";
import type { AgentToolModelCallOptions } from "@sourceweft/contracts/agent-tools";
import type { ModelProfileKind } from "../../content/types";
import type { ArtifactToolRuntimePromptProvider } from "./prompts/tool-prompt-provider";
import { runToolRetrieval } from "./turn/retrieval-runner";
import type { AgentSandboxRuntimeForTurn } from "@sourceweft/builtin-tool-sandbox";
import type { TurnRuntime } from "./turn/turn-runtime";
import type { FilesystemBackend } from "./turn/turn-assembly";
import {
  isToolDenied,
  resolveSourceUserMessageId,
  shouldBindAgentTool,
} from "./turn/tool-utils";

type ReadyArtifactRecordInput = Parameters<typeof createReadyArtifactRecord>[0];
type PendingArtifactRecordInput = Parameters<
  typeof createPendingArtifactRecord
>[0];

type CapabilityAgentToolCategory = "artifact" | "retrieval" | "web";

type CapabilityAgentToolEntry =
  | StructuredToolInterface
  | {
      readonly categories?: readonly CapabilityAgentToolCategory[];
      readonly tool: StructuredToolInterface;
    };

type CapabilityAgentToolFactoryResult =
  | readonly CapabilityAgentToolEntry[]
  | {
      readonly promptProviders?: readonly ArtifactToolRuntimePromptProvider[];
      readonly tools?: readonly CapabilityAgentToolEntry[];
    };

type CapabilityAgentToolModule = {
  readonly createCapabilityAgentTools?: (
    input: CapabilityAgentToolFactoryInput,
  ) =>
    | CapabilityAgentToolFactoryResult
    | Promise<CapabilityAgentToolFactoryResult>;
};

type CapabilityAgentToolFactoryInput = {
  readonly manifest: DiscoveredCapabilityRecord["manifest"];
  readonly toolIds: readonly string[];
  readonly context: Record<string, unknown>;
  readonly services: Record<string, unknown>;
};

export type AgentTurnTool = StructuredToolInterface;

export type CapabilityAgentToolsForTurnInput = {
  readonly billing: ContentBillingPort;
  readonly llm?: LlmExecutionConfig;
  readonly prepared: PreparedThreadTurn;
  readonly filesystemBackend?: FilesystemBackend;
  readonly runtime: TurnRuntime;
  readonly sandboxRuntime: AgentSandboxRuntimeForTurn | null;
  readonly traceContext?: TraceContext;
};

export type CapabilityAgentToolsForTurn = {
  readonly artifactTools: readonly AgentTurnTool[];
  readonly promptProviders: readonly ArtifactToolRuntimePromptProvider[];
  readonly retrievalTools: readonly AgentTurnTool[];
  readonly tools: readonly AgentTurnTool[];
  readonly webTools: readonly AgentTurnTool[];
};

const entryModuleCache = new Map<
  string,
  Promise<CapabilityAgentToolModule | null>
>();

export async function createCapabilityAgentToolsForTurn(
  input: CapabilityAgentToolsForTurnInput,
): Promise<CapabilityAgentToolsForTurn> {
  const records = await listCapabilityRecords();
  const services = createCapabilityAgentToolHostServices(input);
  const context = createCapabilityAgentToolTurnContext(input);
  const tools: AgentTurnTool[] = [];
  const artifactTools: AgentTurnTool[] = [];
  const retrievalTools: AgentTurnTool[] = [];
  const webTools: AgentTurnTool[] = [];
  const promptProviders: ArtifactToolRuntimePromptProvider[] = [];

  for (const record of records) {
    const toolIds = getCapabilityContributions(record.manifest).tools.map(
      (tool) => tool.id,
    );
    if (toolIds.length === 0) {
      continue;
    }
    const module = await loadCapabilityAgentToolModule(record);
    const factory = module?.createCapabilityAgentTools;
    if (!factory) {
      continue;
    }

    const result = await factory({
      manifest: record.manifest,
      toolIds,
      context,
      services,
    });
    const normalized = normalizeFactoryResult(result);
    for (const provider of normalized.promptProviders) {
      promptProviders.push(provider);
    }
    for (const entry of normalized.tools) {
      tools.push(entry.tool);
      if (entry.categories.includes("artifact")) {
        artifactTools.push(entry.tool);
      }
      if (entry.categories.includes("retrieval")) {
        retrievalTools.push(entry.tool);
      }
      if (entry.categories.includes("web")) {
        webTools.push(entry.tool);
      }
    }
  }

  return {
    artifactTools,
    promptProviders,
    retrievalTools,
    tools,
    webTools,
  };
}

function createCapabilityAgentToolTurnContext(
  input: CapabilityAgentToolsForTurnInput,
) {
  const { prepared, traceContext } = input;
  return {
    // Handed over whole and unread: each capability takes its own entry out of
    // it. The host carried three image-shaped fields here once.
    turnState: prepared.turnState,
    isToolDenied: (toolName: string) => isToolDenied(prepared, toolName),
    parentSpanId: traceContext?.parentSpanId,
    runtimeTools: prepared.runtimeTools,
    shouldBindAgentTool: (toolName: string) =>
      shouldBindAgentTool({ prepared, toolName }),
    sourceUserMessageId: resolveSourceUserMessageId(prepared),
    teamId: prepared.workspace.organizationId,
    threadId: prepared.thread.id,
    traceId: traceContext?.traceId,
    userId: prepared.userId,
    userMessageId: prepared.userMessage.id,
    webAccessEnabled: prepared.webAccessEnabled,
    workspaceId: prepared.workspace.id,
  };
}

function createCapabilityAgentToolHostServices(
  input: CapabilityAgentToolsForTurnInput,
) {
  const {
    prepared,
    billing,
    filesystemBackend,
    llm,
    runtime,
    sandboxRuntime,
    traceContext,
  } = input;

  return {
    artifacts: {
      /**
       * The one way an artifact is published, handed to every capability. It
       * names no artifact type: what is written is whatever the spec says.
       */
      publishArtifact,
      /**
       * The two-phase half of the same door, for a capability whose artifact
       * outlives the call that asked for it.
       */
      openArtifact,
      /**
       * The generic artifact-row primitives. Each takes the artifact type as a
       * parameter rather than carrying it in its name: a capability knows its
       * own type (it declared it in the manifest it is handed), the host does
       * not need to.
       */
      createPendingArtifact: (
        artifactType: PendingArtifactRecordInput["artifactType"],
        pendingInput: Omit<PendingArtifactRecordInput, "artifactType">,
      ) => createPendingArtifactRecord({ ...pendingInput, artifactType }),
      createReadyArtifact: (
        artifactType: ReadyArtifactRecordInput["artifactType"],
        recordInput: Omit<ReadyArtifactRecordInput, "artifactType">,
      ) => createReadyArtifactRecord({ ...recordInput, artifactType }),
      findArtifact: findArtifactRecord,
      /**
       * Reuse lookup. Which type, which statuses and what makes a row a match
       * are the caller's query, not the host's knowledge.
       */
      findReusableArtifact: (
        query: Parameters<typeof findReusableArtifactRecord>[0],
      ) => findReusableArtifactRecord(query),
    },
    citationRegistry: runtime.citationRegistry,
    filesystem: filesystemBackend
      ? {
          downloadFiles: (paths: readonly string[]) =>
            filesystemBackend.backend.downloadFiles([...paths]),
          readRaw: (filePath: string) =>
            filesystemBackend.backend.readRaw(filePath),
        }
      : undefined,
    logger,
    llm,
    modelGateway: {
      /**
       * Hands tool runtimes a gateway that bills for itself.
       *
       * The runtime supplies the billing identity per call — including an
       * idempotency key derived from an id it allocates before the call — so
       * settlement happens with the model call rather than after the artifact
       * is published. Previously a failure between the two left the tokens
       * burned and nothing charged.
       */
      getClient: async (gatewayConfigId: string) => ({
        images: {
          generate: (
            request: Parameters<BilledModelGateway["images"]["generate"]>[0],
            options: AgentToolModelCallOptions,
          ) =>
            withBilledModelGateway(
              {
                billing,
                gatewayConfigId,
                context: {
                  teamId: prepared.workspace.organizationId,
                  workspaceId: prepared.workspace.id,
                  actorUserId: prepared.userId,
                  feature: "artifact.image",
                  intent: { mode: "billed" },
                  scopeKind: "thread-turn",
                  scopeId:
                    traceContext?.traceId ?? prepared.userMessage.id,
                  threadId: prepared.thread.id,
                  messageId: prepared.userMessage.id,
                },
              },
              (gateway) =>
                gateway.images.generate(request, {
                  traceId: options.traceId,
                  operation: options.operation,
                  modelKind: options.modelKind as ModelProfileKind,
                  gatewayConfigId: options.gatewayConfigId,
                  profileAlias: options.profileAlias,
                  modelAlias: options.modelAlias,
                  referenceId: options.referenceId,
                  idempotencyKey: options.idempotencyKey,
                  llm: options.llm as LlmExecutionConfig | undefined,
                  billingMetadata: options.billingMetadata,
                }),
            ),
        },
      }),
    },
    queue: {
      /**
       * Dispatch counterpart of the worker's pipeline registry: the capability
       * supplies the job name it declared in its manifest, the host supplies
       * the queue and its retry/idempotency policy.
       */
      enqueueDeliverableJob,
    },
    retrieval: {
      searchSources: async (
        query: string,
        toolCallRuntime?: { toolCallId?: string; toolName?: string },
      ) => {
        const retrievalStartedAt = Date.now();
        const toolName = toolCallRuntime?.toolName ?? "capability_tool";
        const langchainToolCallId = toolCallRuntime?.toolCallId?.trim();
        const retrieval = await runToolRetrieval({
          prepared,
          query,
          llm,
          billing,
          traceContext:
            langchainToolCallId && traceContext
              ? {
                  ...traceContext,
                  parentSpanId: langchainToolCallId,
                }
              : traceContext,
        });
        const retrievalCallId =
          langchainToolCallId ??
          `retrieval:${toolName}:${runtime.retrievalCallOrder.length + 1}`;
        const citationByChunkId = runtime.recordRetrieval({
          callId: retrievalCallId,
          query,
          retrieval,
          latencyMs: Date.now() - retrievalStartedAt,
        });
        return runtime.buildRetrievalChunks({ retrieval, citationByChunkId });
      },
    },
    sandbox: sandboxRuntime
      ? {
          allowedReadRoots: sandboxRuntime.pathPolicy.readWriteRoots,
          downloadCurrentFile: (downloadInput: { sandboxPath: string }) =>
            sandboxRuntime.downloadFile(downloadInput),
        }
      : undefined,
    storage: artifactStorage,
    webProvider: createDefaultWebProvider(),
  };
}

function normalizeFactoryResult(result: CapabilityAgentToolFactoryResult) {
  if (Array.isArray(result)) {
    return {
      promptProviders: [],
      tools: result.map(normalizeToolEntry),
    };
  }
  const resultObject = result as Exclude<
    CapabilityAgentToolFactoryResult,
    readonly CapabilityAgentToolEntry[]
  >;
  return {
    promptProviders: [...(resultObject.promptProviders ?? [])],
    tools: (resultObject.tools ?? []).map(normalizeToolEntry),
  };
}

function normalizeToolEntry(entry: CapabilityAgentToolEntry): {
  readonly categories: readonly CapabilityAgentToolCategory[];
  readonly tool: AgentTurnTool;
} {
  if ("tool" in entry) {
    return {
      categories: entry.categories ?? [],
      tool: entry.tool,
    };
  }
  return {
    categories: [],
    tool: entry,
  };
}

function loadCapabilityAgentToolModule(record: DiscoveredCapabilityRecord) {
  const cacheKey = record.packageName ?? record.manifestPath;
  const cached = entryModuleCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const promise = importCapabilityAgentToolModule(record);
  // Never let a failure stick: a cached null (or rejection) would disable the
  // capability for the whole process lifetime on one transient error.
  promise
    .then((module) => {
      if (!module) {
        entryModuleCache.delete(cacheKey);
      }
    })
    .catch(() => {
      entryModuleCache.delete(cacheKey);
    });
  entryModuleCache.set(cacheKey, promise);
  return promise;
}

async function importCapabilityAgentToolModule(
  record: DiscoveredCapabilityRecord,
): Promise<CapabilityAgentToolModule | null> {
  const builtin = loadBuiltinCapabilityModule(record.packageName);
  if (builtin) {
    // Builtins ship with the backend: a load failure here is a deployment
    // fault, not a degraded optional capability. Fail loudly rather than
    // silently serving a turn with no tools bound.
    return (await builtin()) as CapabilityAgentToolModule;
  }

  try {
    if (record.packageName) {
      return (await import(record.packageName)) as CapabilityAgentToolModule;
    }
    if (record.manifest.entry) {
      const entryPath = resolve(record.rootDir, record.manifest.entry);
      return (await import(
        pathToFileURL(entryPath).href
      )) as CapabilityAgentToolModule;
    }
  } catch (error) {
    logger.warn("Failed to load capability agent tool entry", {
      capabilityId: record.manifest.id,
      packageName: record.packageName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}
