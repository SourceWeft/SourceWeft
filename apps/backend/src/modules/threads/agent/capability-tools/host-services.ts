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
import {
  completeArtifact,
  openArtifact,
  publishArtifact,
} from "../../../artifacts/publish";
import {
  enqueueDeliverableJob,
  type DeliverableJobPayload,
} from "../../../content/queue";
import { artifactStorage } from "../../../sources/storage";
import { guardCancellableWrite } from "../../run-cancellation";
import { logger } from "../../../../shared/logger";
import { createAgentToolModelGatewayService } from "../../../../shared/model-gateway";
import { runToolRetrieval } from "../turn/retrieval-runner";
import type { TurnRuntime } from "../turn/turn-runtime";
import { currentSourceWeftToolCallContext } from "../middleware/tool-call-context";
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

export function recordPublishedArtifactOutput(input: {
  origin: {
    producer: { kind: "main" | "subagent"; subagentType?: string };
    sourceToolCallId: string;
    threadRunId: string;
  };
  result: { artifactId: string; versionId: string };
  runtime: Pick<TurnRuntime, "renderBlocks">;
}) {
  input.runtime.renderBlocks.appendArtifactOutput({
    artifactId: input.result.artifactId,
    artifactVersionId: input.result.versionId,
    ...input.origin,
  });
}

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
    runCancellation,
  } = input;

  function requireArtifactOutputOrigin() {
    const call = currentSourceWeftToolCallContext();
    if (!prepared.threadRunId || !call?.toolCallId) {
      throw new Error(
        "ARTIFACT_OUTPUT_CONTEXT_REQUIRED: publishing a chat artifact requires a durable thread run and tool call id",
      );
    }
    return {
      producer: call.producer,
      sourceToolCallId: call.toolCallId,
      threadRunId: prepared.threadRunId,
    };
  }

  function recordArtifactOutput(
    origin: ReturnType<typeof requireArtifactOutputOrigin>,
    result: { artifactId: string; versionId: string },
  ) {
    recordPublishedArtifactOutput({
      origin,
      result,
      runtime,
    });
  }

  return {
    artifacts: {
      /**
       * The one way an artifact is published, handed to every capability. It
       * names no artifact type: what is written is whatever the spec says.
       *
       * Every write below is wrapped by {@link guardCancellableWrite} so a tool
       * that finished its work after the user pressed Stop cannot still commit
       * an artifact. The wrapper is a pass-through when no gate is wired.
       */
      publishArtifact: async (publishInput) => {
        const origin = requireArtifactOutputOrigin();
        await runCancellation?.throwIfCancelled("publishing the artifact");
        const result = await publishArtifact(publishInput);
        recordArtifactOutput(origin, result);
        return result;
      },
      /**
       * The two-phase half of the same door, for a capability whose artifact
       * outlives the call that asked for it.
       */
      openArtifact: guardCancellableWrite(
        runCancellation,
        "opening the artifact",
        openArtifact,
      ),
      /**
       * Publish over an existing ready artifact as its next version — an edit
       * republishing over itself. `expectedStatuses: ["ready"]` is what keeps
       * this from closing someone else's pending row.
       */
      republishArtifact: async (republishInput: {
        context: Parameters<typeof completeArtifact>[0]["context"];
        artifactId: string;
        spec: Parameters<typeof completeArtifact>[0]["spec"];
        expectedVersionNo?: number;
      }) => {
        const origin = requireArtifactOutputOrigin();
        await runCancellation?.throwIfCancelled("republishing the artifact");
        const result = await completeArtifact({
          artifactId: republishInput.artifactId,
          context: republishInput.context,
          spec: republishInput.spec,
          expectedStatuses: ["ready"],
          ...(republishInput.expectedVersionNo !== undefined
            ? { expectedVersionNo: republishInput.expectedVersionNo }
            : {}),
        });
        recordArtifactOutput(origin, result);
        return result;
      },
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
      createPendingArtifact: async (
        artifactType: string,
        pendingInput: Omit<PendingArtifactRecordInput, "artifactType">,
      ) => {
        await runCancellation?.throwIfCancelled("creating the artifact");
        return createPendingArtifactRecord({
          ...pendingInput,
          artifactType:
            artifactType as PendingArtifactRecordInput["artifactType"],
        });
      },
      createReadyArtifact: async (
        artifactType: string,
        recordInput: Omit<ReadyArtifactRecordInput, "artifactType">,
      ) => {
        await runCancellation?.throwIfCancelled("creating the artifact");
        return createReadyArtifactRecord({
          ...recordInput,
          artifactType:
            artifactType as ReadyArtifactRecordInput["artifactType"],
        });
      },
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
      enqueueDeliverableJob: async (job: {
        readonly jobName: string;
        readonly jobId: string;
        readonly payload: Record<string, unknown>;
      }) => {
        // A late cancel must not still detach a background render job onto the
        // deliverables queue, which would outlive the cancelled turn.
        await runCancellation?.throwIfCancelled("enqueueing the deliverable");
        const origin = requireArtifactOutputOrigin();
        return enqueueDeliverableJob({
          jobName: job.jobName,
          jobId: job.jobId,
          payload: {
            ...job.payload,
            artifactOutputOrigin: origin,
          } as DeliverableJobPayload,
        });
      },
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
