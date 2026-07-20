import type {
  AgentToolReusableArtifactQuery,
  AgentToolWebProvider,
} from "@sourceweft/contracts/agent-tools";
import {
  createPendingArtifactRecord,
  createReadyArtifactRecord,
  findArtifactRecord,
  findReusableArtifactRecord,
} from "../../../artifacts/repository";
import { openArtifact, publishArtifact } from "../../../artifacts/publish";
import {
  enqueueDeliverableJob,
  type DeliverableJobPayload,
} from "../../../content/queue";
import { artifactStorage } from "../../../sources/storage";
import { logger } from "../../../../shared/logger";
import { createAgentToolModelGatewayService } from "../../../../shared/model-gateway";
import { runToolRetrieval } from "../turn/retrieval-runner";
import type {
  CapabilityAgentToolHostServices,
  CapabilityAgentToolsForTurnInput,
} from "./types";

type ReadyArtifactRecordInput = Parameters<typeof createReadyArtifactRecord>[0];
type PendingArtifactRecordInput = Parameters<
  typeof createPendingArtifactRecord
>[0];
type ReusableArtifactRecordQuery = Parameters<
  typeof findReusableArtifactRecord
>[0];

/**
 * Everything the host lends a capability for the duration of a turn.
 *
 * The return type is annotated, not inferred, and that is load-bearing twice
 * over. It is the host's half of the contract in
 * `@sourceweft/contracts/agent-tools`, so dropping a member here breaks the
 * capabilities that read it at compile time. And because the annotation makes
 * this an object literal checked for excess properties, capability-specific
 * configuration cannot be smuggled into a bag every capability receives — the
 * mistake that once put a deck renderer's font base URL in front of every tool
 * in the process. Such a field belongs to its capability's own config.
 */
export function createCapabilityAgentToolHostServices(
  input: CapabilityAgentToolsForTurnInput,
  /**
   * Host-supplied services that have to be resolved before the bag is built.
   * The web provider comes from a capability entry module, so resolving it is
   * async; it is passed in rather than fetched here so this builder stays the
   * synchronous, excess-property-checked literal the architecture guard relies
   * on.
   */
  hostProviders: { webProvider: AgentToolWebProvider | null },
): CapabilityAgentToolHostServices {
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
       *
       * The type arrives as a plain string, because the contract may not name
       * the host's artifact-type union without naming capabilities. The cast
       * back to it is the boundary where that widening is undone; the column is
       * text, and a type no reader understands renders as an unknown artifact
       * rather than corrupting anything.
       */
      createPendingArtifact: (
        artifactType: string,
        pendingInput: Omit<PendingArtifactRecordInput, "artifactType">,
      ) =>
        createPendingArtifactRecord({
          ...pendingInput,
          artifactType:
            artifactType as PendingArtifactRecordInput["artifactType"],
        }),
      createReadyArtifact: (
        artifactType: string,
        recordInput: Omit<ReadyArtifactRecordInput, "artifactType">,
      ) =>
        createReadyArtifactRecord({
          ...recordInput,
          artifactType:
            artifactType as ReadyArtifactRecordInput["artifactType"],
        }),
      findArtifact: findArtifactRecord,
      /**
       * Reuse lookup. Which type, which statuses and what makes a row a match
       * are the caller's query, not the host's knowledge.
       */
      findReusableArtifact: (query: AgentToolReusableArtifactQuery) =>
        findReusableArtifactRecord(query as ReusableArtifactRecordQuery),
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
    modelGateway: createAgentToolModelGatewayService({
      billing,
      scope: {
        teamId: prepared.workspace.organizationId,
        workspaceId: prepared.workspace.id,
        actorUserId: prepared.userId,
        intent: { mode: "billed" },
        scopeKind: "thread-turn",
        scopeId: traceContext?.traceId ?? prepared.userMessage.id,
        threadId: prepared.thread.id,
        messageId: prepared.userMessage.id,
      },
    }),
    queue: {
      /**
       * Dispatch counterpart of the worker's pipeline registry: the capability
       * supplies the job name it declared in its manifest, the host supplies
       * the queue and its retry/idempotency policy. The payload is the
       * capability's own envelope, carried through uninterpreted — which is why
       * the contract types it as a plain record and the shape is only asserted
       * here, where the queue's envelope type lives.
       */
      enqueueDeliverableJob: (job: {
        readonly jobName: string;
        readonly jobId: string;
        readonly payload: Record<string, unknown>;
      }) =>
        enqueueDeliverableJob({
          jobName: job.jobName,
          jobId: job.jobId,
          payload: job.payload as DeliverableJobPayload,
        }),
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
    webProvider: hostProviders.webProvider,
  };
}
