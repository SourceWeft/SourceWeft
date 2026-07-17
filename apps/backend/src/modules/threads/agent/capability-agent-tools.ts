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
  createFileArtifactRecord,
  createImageArtifactRecord,
  createPendingVideoPresentationArtifactRecord,
  findArtifactRecord,
  findReusableVideoPresentationArtifactRecord,
  markArtifactReady,
  createSlidesArtifactRecord,
} from "../../artifacts/repository";
import { meterBillableModelUsage } from "../../content/model-billing";
import { enqueueVideoPresentationGenerateJob } from "../../content/queue";
import {
  buildArtifactStorageKey,
  getContentStorageBucketName,
  uploadArtifactObject,
} from "../../sources/storage";
import { createDefaultWebProvider } from "../../sources/web-provider";
import { listCapabilityRecords } from "../turn/capability-command-workflows";
import { config } from "../../../shared/config";
import { logger } from "../../../shared/logger";
import type { TraceContext } from "../../llm-observability";
import { getModelGatewayClient } from "../../../shared/model-gateway/client";
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
    artifactIntent: prepared.artifactIntent,
    imageProfile: prepared.imageProfile,
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
  const fontAssetBaseUrl = config.visualDeck.fontAssetBaseUrl;

  return {
    artifacts: {
      createFileArtifactRecord,
      createImageArtifactRecord,
      createPendingVideoPresentationArtifactRecord,
      findVideoPresentationArtifactRecord: findArtifactRecord,
      findReusableVideoPresentationArtifactRecord,
      markArtifactReady,
      createSlidesArtifactRecord,
    },
    billing: {
      meterModelUsage: (meterInput: Record<string, unknown>) =>
        meterBillableModelUsage({ billing, ...meterInput } as never),
    },
    citationRegistry: runtime.citationRegistry,
    fontAssetBaseUrl,
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
      getClient: getModelGatewayClient,
    },
    queue: {
      enqueueVideoPresentationRenderJob: enqueueVideoPresentationGenerateJob,
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
    storage: {
      buildArtifactStorageKey,
      getContentStorageBucketName,
      uploadArtifactObject,
    },
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
  let promise = entryModuleCache.get(cacheKey);
  if (!promise) {
    promise = importCapabilityAgentToolModule(record);
    entryModuleCache.set(cacheKey, promise);
  }
  return promise;
}

async function importCapabilityAgentToolModule(
  record: DiscoveredCapabilityRecord,
): Promise<CapabilityAgentToolModule | null> {
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
