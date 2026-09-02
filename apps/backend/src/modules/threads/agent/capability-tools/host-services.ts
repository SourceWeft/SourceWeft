import { randomUUID } from "node:crypto";
import type {
  AgentToolReusableArtifactQuery,
  AgentToolWebProvider,
  AgentToolWorkBlobServices,
} from "@sourceweft/contracts/agent-tools";
import { AGENT_TOOL_HOST_LIMITS } from "@sourceweft/contracts/agent-tools";
import {
  createPendingArtifactRecord,
  createReadyArtifactRecord,
  findArtifactRecord,
  findReusableArtifactRecord,
} from "../../../artifacts/repository";
import { readAuthorizedCurrentArtifactVersion } from "../../../artifacts/authorized-version-service";
import { currentRunArtifactPublicationService } from "../../../artifacts/current-run-publication";
import {
  completeArtifact,
  openArtifact,
  publishArtifact,
} from "../../../artifacts/publish";
import {
  enqueueDeliverableJob,
  type DeliverableJobPayload,
} from "../../../content/queue";
import {
  deliverablesQueue,
  getDeliverablesQueueEvents,
} from "../../../../shared/queue";
import { artifactStorage } from "../../../sources/storage";
import { deleteArtifactObjectsByPrefix } from "../../../sources/storage";
import { guardCancellableWrite } from "../../run-cancellation";
import { logger } from "../../../../shared/logger";
import { probeAudioDurationSeconds } from "../../../../shared/audio-duration";
import { createAgentToolModelGatewayService } from "../../../../shared/model-gateway";
import { runToolRetrieval } from "../turn/retrieval-runner";
import type { TurnRuntime } from "../turn/turn-runtime";
import { currentSourceWeftToolCallContext } from "../middleware/tool-call-context";
import { requestChatThreadRunCancel } from "../../durable/repository";
import type {
  CapabilityAgentToolHostServices,
  CapabilityAgentToolsForTurnInput,
} from "./types";
import {
  createProtectedRunOperationCacheServices,
  createProtectedRunReceiptServices,
} from "../../durable/protected-agent-tool-state-repository";
import { createRunScopedWorkBlobService } from "./work-blob-service";

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

/** Publish first, then expose a card only for the committed result. */
export async function publishArtifactAndRecordOutput(input: {
  origin: Parameters<typeof recordPublishedArtifactOutput>[0]["origin"];
  publish: typeof publishArtifact;
  publishInput: Parameters<typeof publishArtifact>[0];
  runtime: Pick<TurnRuntime, "renderBlocks">;
}) {
  const result = await input.publish(input.publishInput);
  recordPublishedArtifactOutput({
    origin: input.origin,
    result,
    runtime: input.runtime,
  });
  return result;
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

  const protectedRunServices = prepared.threadRunId
    ? (() => {
        const scope = {
          runId: prepared.threadRunId,
          teamId: prepared.workspace.organizationId,
          workspaceId: prepared.workspace.id,
        };
        const assertRootToolCall = (assertInput: {
          toolName?: string;
          toolCallId?: string;
        }) => {
          const call = currentSourceWeftToolCallContext();
          if (
            !call ||
            call.producer.kind !== "main" ||
            !call.toolCallId ||
            (assertInput.toolName !== undefined &&
              call.toolName !== assertInput.toolName) ||
            (assertInput.toolCallId !== undefined &&
              call.toolCallId !== assertInput.toolCallId)
          ) {
            throw new Error(
              "PROTECTED_AGENT_TOOL_CONTEXT_MISMATCH: root tool identity is required",
            );
          }
        };
        const scopedWorkBlobs = createRunScopedWorkBlobService(scope);
        const requireRootWorkBlobCall = async <T>(
          operation: () => Promise<T>,
        ) => {
          assertRootToolCall({});
          return operation();
        };
        const workBlobs: AgentToolWorkBlobServices = {
          putIfAbsent: (workBlobInput) =>
            requireRootWorkBlobCall(() =>
              scopedWorkBlobs.putIfAbsent(workBlobInput),
            ),
          getVerified: (workBlobInput) =>
            requireRootWorkBlobCall(() =>
              scopedWorkBlobs.getVerified(workBlobInput),
            ),
          getBySemanticKey: (workBlobInput) =>
            requireRootWorkBlobCall(() =>
              scopedWorkBlobs.getBySemanticKey(workBlobInput),
            ),
          deleteScope: () =>
            requireRootWorkBlobCall(() => scopedWorkBlobs.deleteScope()),
        };
        const allocatedArtifactIds = new Set<string>();
        const currentRunArtifacts = {
          allocateArtifactId: () => {
            const artifactId = randomUUID();
            allocatedArtifactIds.add(artifactId);
            return artifactId;
          },
          cleanupPreallocatedArtifact: async (artifactId: string) => {
            assertRootToolCall({});
            if (!allocatedArtifactIds.has(artifactId)) {
              throw new Error("ARTIFACT_PREALLOCATION_NOT_OWNED");
            }
            await deleteArtifactObjectsByPrefix({
              prefix: `workspaces/${prepared.workspace.id}/artifacts/${artifactId}/`,
            });
            allocatedArtifactIds.delete(artifactId);
          },
          publishCommitted: async (
            publicationInput: Parameters<
              typeof currentRunArtifactPublicationService.publish
            >[0]["artifact"],
          ) => {
            const call = currentSourceWeftToolCallContext();
            assertRootToolCall({});
            if (
              publicationInput.mode.kind === "create" &&
              (!publicationInput.mode.artifactId ||
                !allocatedArtifactIds.has(publicationInput.mode.artifactId))
            ) {
              throw new Error("ARTIFACT_PREALLOCATION_NOT_OWNED");
            }
            const committed =
              await currentRunArtifactPublicationService.publish({
                context: {
                  actorUserId: prepared.userId,
                  producer: call!.producer,
                  runId: prepared.threadRunId!,
                  sourceToolCallId: call!.toolCallId!,
                  sourceToolName: call!.toolName,
                  teamId: prepared.workspace.organizationId,
                  workspaceId: prepared.workspace.id,
                },
                artifact: publicationInput,
              });
            if (
              committed.ok &&
              publicationInput.mode.kind === "create" &&
              committed.result.artifactId === publicationInput.mode.artifactId
            ) {
              allocatedArtifactIds.delete(publicationInput.mode.artifactId);
            }
            return committed.ok
              ? {
                  ok: true as const,
                  result: committed.result,
                  reused: committed.reused,
                  versionNo: committed.versionNo,
                }
              : committed;
          },
        };
        return {
          currentRunArtifacts,
          operationCache: createProtectedRunOperationCacheServices({
            scope,
            maxOperations: AGENT_TOOL_HOST_LIMITS.operationClaimMaxKeys,
            assertRootToolCall,
          }),
          receipts: createProtectedRunReceiptServices({
            scope,
            assertRootToolCall,
          }),
          workBlobs,
        };
      })()
    : null;

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
        return publishArtifactAndRecordOutput({
          origin,
          publish: publishArtifact,
          publishInput,
          runtime,
        });
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
        signal?: AbortSignal;
      }) => {
        const origin = requireArtifactOutputOrigin();
        await runCancellation?.throwIfCancelled("republishing the artifact");
        // The cancellation check above is a point-in-time read; a Stop
        // between it and the commit below would otherwise still land. Row-
        // locking the run inside the same transaction as the version write
        // is what currentRunArtifacts.publishCommitted and the worker's
        // deliverable-host path already do — this sibling call site is a
        // durable-run capability too, so it gets the same fence whenever a
        // run is actually in scope (a non-durable call has none to lock).
        const result = await completeArtifact({
          artifactId: republishInput.artifactId,
          context: republishInput.context,
          spec: republishInput.spec,
          expectedStatuses: ["ready"],
          ...(republishInput.expectedVersionNo !== undefined
            ? { expectedVersionNo: republishInput.expectedVersionNo }
            : {}),
          ...(prepared.threadRunId
            ? {
                publishRunFence: {
                  runId: prepared.threadRunId,
                  teamId: prepared.workspace.organizationId,
                  workspaceId: prepared.workspace.id,
                },
              }
            : {}),
          ...(republishInput.signal ? { signal: republishInput.signal } : {}),
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
    artifactVersions: {
      readAuthorizedCurrentVersion: (versionInput) =>
        readAuthorizedCurrentArtifactVersion({
          workspaceId: prepared.workspace.id,
          userId: prepared.userId,
          artifactId: versionInput.artifactId,
          expectedArtifactType: versionInput.expectedArtifactType,
        }),
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
    media: {
      probeAudioDurationSeconds: (mediaInput) =>
        probeAudioDurationSeconds({
          buffer: Buffer.from(mediaInput.bytes),
          mimeType: mediaInput.mimeType,
        }),
    },
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
    ...(protectedRunServices
      ? {
          operationCache: protectedRunServices.operationCache,
          receipts: protectedRunServices.receipts,
          workBlobs: protectedRunServices.workBlobs,
          currentRunArtifacts: protectedRunServices.currentRunArtifacts,
        }
      : {}),
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
        const queued = await enqueueDeliverableJob({
          jobName: job.jobName,
          jobId: job.jobId,
          payload: {
            ...job.payload,
            artifactOutputOrigin: origin,
          } as DeliverableJobPayload,
        });
        const cancel = async () => {
          await requestChatThreadRunCancel({
            runId: origin.threadRunId,
            teamId: prepared.workspace.organizationId,
            workspaceId: prepared.workspace.id,
          });
          const state = await queued.getState().catch(() => "unknown");
          if (
            state === "waiting" ||
            state === "delayed" ||
            state === "paused"
          ) {
            await queued.remove().catch(() => undefined);
          }
        };
        return {
          cancel,
          id: String(queued.id ?? job.jobId),
          waitUntilFinished: async (waitInput?: { timeoutMs?: number }) => {
            try {
              return await queued.waitUntilFinished(
                getDeliverablesQueueEvents(),
                waitInput?.timeoutMs,
              );
            } catch (error) {
              let deliverableJobState = await queued
                .getState()
                .catch(() => "unknown");
              const readCompletedResult = async () => {
                const completed = await deliverablesQueue.getJob(job.jobId);
                return completed
                  ? { found: true as const, value: completed.returnvalue }
                  : { found: false as const };
              };
              if (deliverableJobState === "completed") {
                const completed = await readCompletedResult();
                if (completed.found) return completed.value;
              }
              if (deliverableJobState !== "failed") {
                await cancel();
                deliverableJobState = await queued
                  .getState()
                  .catch(() => "unknown");
                if (deliverableJobState === "completed") {
                  const completed = await readCompletedResult();
                  if (completed.found) return completed.value;
                }
              }
              throw Object.assign(
                error instanceof Error
                  ? error
                  : new Error(String(error || "Deliverable job wait failed")),
                { deliverableJobState },
              );
            }
          },
        };
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
          allowedReadRoots: sandboxRuntime.trustedHost.allowedReadRoots,
          ensureCurrentSession: () =>
            sandboxRuntime.trustedHost.ensureCurrentSession(),
          uploadCurrentFiles: (files, options) =>
            sandboxRuntime.trustedHost.uploadCurrentFiles(files, options),
          listCurrentFiles: (listInput) =>
            sandboxRuntime.trustedHost.listCurrentFiles(listInput),
          downloadCurrentFile: (downloadInput) =>
            sandboxRuntime.trustedHost.downloadCurrentFile(downloadInput),
          executeCurrent: (executeInput) =>
            sandboxRuntime.trustedHost.executeCurrent(executeInput),
          captureCurrentTree: (captureInput) =>
            sandboxRuntime.trustedHost.captureCurrentTree(captureInput),
        }
      : undefined,
    storage: artifactStorage,
    webProvider: hostProviders.webProvider,
  };
}
