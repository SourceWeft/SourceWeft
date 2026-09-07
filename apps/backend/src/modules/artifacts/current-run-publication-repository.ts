import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  artifacts,
  artifactVersions,
  chatThreadRuns,
  db,
  messages,
  threads,
} from "@sourceweft/db";
import type { CommittedArtifactToolResult } from "@sourceweft/contracts/agent-tools";
import type { MessageRenderBlock, ToolCallTrace } from "../threads/turn/types";
import { canViewContent } from "../workspace/content-visibility";
import { lockArtifactRequestKey } from "./idempotency-lock";
import { findArtifactRecordByRequestKeyWithExecutor } from "./repository";
import {
  lockWorkspaceAccessRowsWithExecutor,
  resolveWorkspaceAccessRecordWithExecutor,
} from "../workspace/store";
import { workspaceRoleSatisfies } from "../workspace/types";
import {
  committedArtifactBlockIdentityMatches,
  mergeCommittedArtifactRenderBlocks,
} from "../threads/render-block-projection";
import { updateExistingTracePartsFromToolCalls } from "../threads/durable/snapshot";
import { toObjectRecord } from "../../shared/records";

type ArtifactType = typeof artifacts.$inferSelect.artifactType;
type ArtifactOutputBlock = Extract<
  MessageRenderBlock,
  { type: "artifact_output" }
>;

const ACTIVE_PUBLICATION_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_for_approval",
] as const;

export type CurrentRunArtifactPublicationStage =
  | "after_run_lock"
  | "after_version_write"
  | "after_tool_output_write"
  | "after_message_write";

export type CurrentRunArtifactPublicationInput = {
  /** Host-injected identity. No field in this object is accepted from the model. */
  context: {
    actorUserId: string;
    producer: { kind: "main" | "subagent"; subagentType?: string };
    runId: string;
    sourceToolCallId: string;
    sourceToolName: string;
    teamId: string;
    workspaceId: string;
  };
  /**
   * Already-validated committed content. Storage coordinates, when present,
   * must have been returned by the host's upload port, never authored by the
   * model. This transaction does not upload or interpret capability payloads.
   */
  artifact: {
    artifactType: string;
    mode:
      | { kind: "create"; artifactId?: string }
      | {
          kind: "republish";
          artifactId: string;
          expectedVersionNo: number;
        };
    payload: Record<string, unknown>;
    previewMetadata?: Record<string, unknown> | null;
    previewStorageKey?: string | null;
    prompt: string;
    semanticRequestKey: string;
    storageBucket?: string | null;
    storageKey?: string | null;
    title: string;
    workflowVersion: string;
  };
};

export type CurrentRunArtifactPublicationRejection =
  | "artifact_in_progress"
  | "artifact_not_found"
  | "forbidden"
  | "message_unavailable"
  | "run_inactive"
  | "version_conflict";

export type CurrentRunArtifactPublicationCommitResult =
  | {
      ok: true;
      artifactOutputBlock: ArtifactOutputBlock;
      result: CommittedArtifactToolResult;
      reused: boolean;
      run: {
        assistantMessageId: string;
        id: string;
        status: string;
        threadId: string;
        userId: string;
        workspaceId: string;
      };
      versionNo: number;
    }
  | { ok: false; reason: CurrentRunArtifactPublicationRejection };

export type CurrentRunArtifactPublicationRepositoryDependencies = {
  failpoint?: (
    stage: CurrentRunArtifactPublicationStage,
  ) => void | Promise<void>;
  newArtifactId?: () => string;
  newVersionId?: () => string;
};

class PublicationRejected extends Error {
  constructor(readonly reason: CurrentRunArtifactPublicationRejection) {
    super(reason);
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function committedResultMatches(
  left: CommittedArtifactToolResult,
  right: CommittedArtifactToolResult,
) {
  return (
    left.status === right.status &&
    left.type === right.type &&
    left.artifactType === right.artifactType &&
    left.artifactId === right.artifactId &&
    left.artifactVersionId === right.artifactVersionId &&
    left.artifactOutputBlockId === right.artifactOutputBlockId &&
    left.workflowVersion === right.workflowVersion
  );
}

function parseCommittedResult(
  value: unknown,
): CommittedArtifactToolResult | null {
  const record = toObjectRecord(value);
  return record?.status === "ready" &&
    record.type === "committed_artifact_result" &&
    typeof record.artifactType === "string" &&
    typeof record.artifactId === "string" &&
    typeof record.artifactVersionId === "string" &&
    typeof record.artifactOutputBlockId === "string" &&
    typeof record.workflowVersion === "string"
    ? (record as CommittedArtifactToolResult)
    : null;
}

function upsertCanonicalToolCall(input: {
  calls: unknown;
  output: CommittedArtifactToolResult;
  producer: CurrentRunArtifactPublicationInput["context"]["producer"];
  sourceToolCallId: string;
  sourceToolName: string;
}): ToolCallTrace[] {
  const calls = arrayValue(input.calls);
  const existingIndex = calls.findIndex(
    (value) => toObjectRecord(value)?.id === input.sourceToolCallId,
  );
  const existing =
    existingIndex >= 0 ? toObjectRecord(calls[existingIndex]) : null;
  if (
    existing &&
    typeof existing.tool === "string" &&
    existing.tool !== input.sourceToolName
  ) {
    throw new Error(
      `PUBLICATION_TOOL_IDENTITY_CONFLICT: tool call ${input.sourceToolCallId} is ${existing.tool}, not ${input.sourceToolName}`,
    );
  }
  const existingCommitted = parseCommittedResult(existing?.output);
  if (
    existingCommitted &&
    !committedResultMatches(existingCommitted, input.output)
  ) {
    throw new Error(
      `PUBLICATION_TOOL_OUTPUT_CONFLICT: tool call ${input.sourceToolCallId} already committed a different artifact`,
    );
  }
  const highestSequence = calls.reduce<number>((highest, value) => {
    const sequence = toObjectRecord(value)?.sequence;
    return typeof sequence === "number" && Number.isFinite(sequence)
      ? Math.max(highest, sequence)
      : highest;
  }, 0);
  const existingProducer = toObjectRecord(existing?.producer);
  const canonical: ToolCallTrace = {
    id: input.sourceToolCallId,
    tool: input.sourceToolName,
    input: toObjectRecord(existing?.input) ?? {},
    output: input.output,
    status: "completed",
    latencyMs:
      typeof existing?.latencyMs === "number" || existing?.latencyMs === null
        ? existing.latencyMs
        : null,
    error: null,
    sequence:
      typeof existing?.sequence === "number"
        ? existing.sequence
        : highestSequence + 1,
    producer: {
      ...(typeof existingProducer?.taskCallId === "string"
        ? { taskCallId: existingProducer.taskCallId }
        : {}),
      ...input.producer,
    },
  };
  if (existingIndex < 0) {
    return [...calls, canonical] as ToolCallTrace[];
  }
  return calls.map((value, index) =>
    index === existingIndex ? canonical : value,
  ) as ToolCallTrace[];
}

function findOrCreateArtifactOutputBlock(input: {
  artifactId: string;
  artifactVersionId: string;
  messageBlocks: unknown;
  producer: ArtifactOutputBlock["producer"];
  runBlocks: unknown;
  runId: string;
  sourceToolCallId: string;
}) {
  const currentBlocks =
    mergeCommittedArtifactRenderBlocks({
      incoming: arrayValue(input.runBlocks),
      authoritative: [arrayValue(input.messageBlocks)],
    }) ?? [];
  const id = `artifact-output:${input.runId}:${input.artifactId}:${input.artifactVersionId}`;
  const existing = currentBlocks.find(
    (value) => toObjectRecord(value)?.id === id,
  );
  if (existing) {
    const record = toObjectRecord(existing);
    const expectedIdentity = {
      artifactId: input.artifactId,
      artifactVersionId: input.artifactVersionId,
      id,
      placement: "terminal",
      producer: input.producer,
      sourceToolCallId: input.sourceToolCallId,
      threadRunId: input.runId,
      type: "artifact_output",
    };
    if (
      !record ||
      !committedArtifactBlockIdentityMatches(existing, expectedIdentity)
    ) {
      throw new Error(
        `ARTIFACT_OUTPUT_ID_CONFLICT: committed block ${id} has different identity`,
      );
    }
    return {
      block: existing as ArtifactOutputBlock,
      currentBlocks,
      renderBlocks: currentBlocks,
    };
  }
  const sequence =
    currentBlocks.reduce<number>((highest, value) => {
      const record = toObjectRecord(value);
      return record?.type === "artifact_output" &&
        typeof record.sequence === "number" &&
        Number.isFinite(record.sequence)
        ? Math.max(highest, record.sequence)
        : highest;
    }, 0) + 1;
  const block: ArtifactOutputBlock = {
    artifactId: input.artifactId,
    artifactVersionId: input.artifactVersionId,
    id,
    placement: "terminal",
    producer: input.producer,
    sequence,
    sourceToolCallId: input.sourceToolCallId,
    threadRunId: input.runId,
    type: "artifact_output",
  };
  return {
    block,
    currentBlocks,
    renderBlocks: [...currentBlocks, block],
  };
}

function findCommittedRepublishReplay(input: {
  artifactId: string;
  artifactType: string;
  producer: ArtifactOutputBlock["producer"];
  runId: string;
  snapshot: Record<string, unknown>;
  sourceToolCallId: string;
  sourceToolName: string;
  workflowVersion: string;
}) {
  const call = arrayValue(input.snapshot.toolCalls).find(
    (value) => toObjectRecord(value)?.id === input.sourceToolCallId,
  );
  const callRecord = toObjectRecord(call);
  const output = parseCommittedResult(callRecord?.output);
  if (
    !output ||
    callRecord?.tool !== input.sourceToolName ||
    callRecord.status !== "completed" ||
    output.artifactId !== input.artifactId ||
    output.artifactType !== input.artifactType ||
    output.workflowVersion !== input.workflowVersion
  ) {
    return null;
  }
  const block = arrayValue(input.snapshot.renderBlocks).find(
    (value) => toObjectRecord(value)?.id === output.artifactOutputBlockId,
  );
  if (
    !block ||
    !committedArtifactBlockIdentityMatches(block, {
      artifactId: output.artifactId,
      artifactVersionId: output.artifactVersionId,
      id: output.artifactOutputBlockId,
      placement: "terminal",
      producer: input.producer,
      sourceToolCallId: input.sourceToolCallId,
      threadRunId: input.runId,
      type: "artifact_output",
    })
  ) {
    return null;
  }
  return { block: block as ArtifactOutputBlock, output };
}

function nextAssistantSnapshot(input: {
  messageMetadata: Record<string, unknown>;
  renderBlocks: unknown[];
  snapshot: Record<string, unknown>;
  toolCalls: ToolCallTrace[];
}) {
  const assistantMessage = toObjectRecord(input.snapshot.assistantMessage);
  if (!assistantMessage) {
    return input.snapshot;
  }
  const metadata = toObjectRecord(assistantMessage.metadata) ?? {};
  return {
    ...input.snapshot,
    assistantMessage: {
      ...assistantMessage,
      metadata: {
        ...metadata,
        ...input.messageMetadata,
        renderBlocks: input.renderBlocks,
        toolCalls: input.toolCalls,
      },
    },
  };
}

async function rejectAfterWrites(
  reason: CurrentRunArtifactPublicationRejection,
): Promise<never> {
  throw new PublicationRejected(reason);
}

export async function commitCurrentRunArtifactPublication(
  input: CurrentRunArtifactPublicationInput,
  dependencies: CurrentRunArtifactPublicationRepositoryDependencies = {},
): Promise<CurrentRunArtifactPublicationCommitResult> {
  const failpoint = dependencies.failpoint ?? (() => undefined);
  const newArtifactId = dependencies.newArtifactId ?? randomUUID;
  const newVersionId = dependencies.newVersionId ?? randomUUID;
  try {
    return await db.transaction(async (tx) => {
      // This lock is first for every create/republish path. It serializes the
      // semantic request before either reuse lookup or any durable write.
      await lockArtifactRequestKey(tx, {
        teamId: input.context.teamId,
        workspaceId: input.context.workspaceId,
        artifactType: input.artifact.artifactType,
        requestKey: input.artifact.semanticRequestKey,
      });

      const [runRow] = await tx
        .select()
        .from(chatThreadRuns)
        .where(
          and(
            eq(chatThreadRuns.id, input.context.runId),
            eq(chatThreadRuns.teamId, input.context.teamId),
            eq(chatThreadRuns.workspaceId, input.context.workspaceId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !runRow ||
        runRow.userId !== input.context.actorUserId ||
        !ACTIVE_PUBLICATION_RUN_STATUSES.includes(
          runRow.status as (typeof ACTIVE_PUBLICATION_RUN_STATUSES)[number],
        )
      ) {
        return { ok: false, reason: "run_inactive" };
      }
      await failpoint("after_run_lock");
      const [threadRow] = await tx
        .select({ visibility: threads.visibility })
        .from(threads)
        .where(
          and(
            eq(threads.id, runRow.threadId),
            eq(threads.teamId, input.context.teamId),
            eq(threads.workspaceId, input.context.workspaceId),
          ),
        )
        .for("share")
        .limit(1);
      if (!threadRow) {
        return { ok: false, reason: "run_inactive" };
      }
      const publicationVisibility =
        threadRow.visibility === "private" ? "private" : "workspace";
      await lockWorkspaceAccessRowsWithExecutor(tx, {
        workspaceId: input.context.workspaceId,
        userId: input.context.actorUserId,
      });
      const access = await resolveWorkspaceAccessRecordWithExecutor(tx, {
        workspaceId: input.context.workspaceId,
        userId: input.context.actorUserId,
      });
      if (
        !access ||
        access.organizationId !== input.context.teamId ||
        access.role === null
      ) {
        return { ok: false, reason: "run_inactive" };
      }
      if (!workspaceRoleSatisfies(access.role, "editor")) {
        return { ok: false, reason: "forbidden" };
      }

      let artifactId: string;
      let artifactVersionId: string;
      let versionNo: number;
      let reused = false;

      if (input.artifact.mode.kind === "republish") {
        const [current] = await tx
          .select()
          .from(artifacts)
          .where(
            and(
              eq(artifacts.id, input.artifact.mode.artifactId),
              eq(artifacts.teamId, input.context.teamId),
              eq(artifacts.workspaceId, input.context.workspaceId),
            ),
          )
          .for("update")
          .limit(1);
        if (
          !current ||
          current.artifactType !== input.artifact.artifactType ||
          !canViewContent(input.context.actorUserId, current)
        ) {
          return { ok: false, reason: "artifact_not_found" };
        }
        if (
          current.createdBy !== input.context.actorUserId &&
          !workspaceRoleSatisfies(access.role, "workspace_admin")
        ) {
          return { ok: false, reason: "forbidden" };
        }
        const replay = findCommittedRepublishReplay({
          artifactId: current.id,
          artifactType: input.artifact.artifactType,
          producer: input.context.producer,
          runId: runRow.id,
          snapshot: toObjectRecord(runRow.snapshotJson) ?? {},
          sourceToolCallId: input.context.sourceToolCallId,
          sourceToolName: input.context.sourceToolName,
          workflowVersion: input.artifact.workflowVersion,
        });
        if (replay && runRow.assistantMessageId) {
          const [committedVersion] = await tx
            .select({ versionNo: artifactVersions.versionNo })
            .from(artifactVersions)
            .where(
              and(
                eq(artifactVersions.id, replay.output.artifactVersionId),
                eq(artifactVersions.artifactId, current.id),
                eq(artifactVersions.teamId, input.context.teamId),
                eq(artifactVersions.workspaceId, input.context.workspaceId),
              ),
            )
            .limit(1);
          if (committedVersion) {
            return {
              ok: true,
              artifactOutputBlock: replay.block,
              result: replay.output,
              reused: true,
              run: {
                assistantMessageId: runRow.assistantMessageId,
                id: runRow.id,
                status: runRow.status,
                threadId: runRow.threadId,
                userId: runRow.userId,
                workspaceId: runRow.workspaceId,
              },
              versionNo: committedVersion.versionNo,
            };
          }
        }
        if (
          current.status !== "ready" ||
          current.currentVersionNo !== input.artifact.mode.expectedVersionNo
        ) {
          return { ok: false, reason: "version_conflict" };
        }

        artifactId = current.id;
        versionNo = current.currentVersionNo + 1;
        artifactVersionId = newVersionId();
        await tx.insert(artifactVersions).values({
          id: artifactVersionId,
          teamId: input.context.teamId,
          workspaceId: input.context.workspaceId,
          artifactId,
          versionNo,
          contentJson: input.artifact.payload,
          createdBy: input.context.actorUserId,
        });
        const [updated] = await tx
          .update(artifacts)
          .set({
            title: input.artifact.title,
            promptText: input.artifact.prompt,
            payloadJson: input.artifact.payload,
            status: "ready",
            currentVersionNo: versionNo,
            errorCode: null,
            errorMessage: null,
            completedAt: new Date(),
            updatedAt: new Date(),
            ...(input.artifact.storageBucket !== undefined
              ? { storageBucket: input.artifact.storageBucket }
              : {}),
            ...(input.artifact.storageKey !== undefined
              ? { storageKey: input.artifact.storageKey }
              : {}),
            ...(input.artifact.previewStorageKey !== undefined
              ? { previewStorageKey: input.artifact.previewStorageKey }
              : {}),
            ...(input.artifact.previewStorageKey !== undefined ||
            input.artifact.previewMetadata !== undefined
              ? { previewMetadataJson: input.artifact.previewMetadata ?? {} }
              : {}),
          })
          .where(
            and(
              eq(artifacts.id, current.id),
              eq(artifacts.teamId, input.context.teamId),
              eq(artifacts.workspaceId, input.context.workspaceId),
              eq(artifacts.status, "ready"),
              eq(
                artifacts.currentVersionNo,
                input.artifact.mode.expectedVersionNo,
              ),
            ),
          )
          .returning({ id: artifacts.id });
        if (!updated) {
          return rejectAfterWrites("version_conflict");
        }
        await failpoint("after_version_write");
      } else {
        const existingArtifact =
          await findArtifactRecordByRequestKeyWithExecutor(tx, {
            teamId: input.context.teamId,
            workspaceId: input.context.workspaceId,
            artifactType: input.artifact.artifactType as ArtifactType,
            requestKey: input.artifact.semanticRequestKey,
            userId: input.context.actorUserId,
            visibility: publicationVisibility,
            statuses: ["pending", "running", "ready"],
          });
        if (existingArtifact) {
          if (existingArtifact.status !== "ready")
            return { ok: false, reason: "artifact_in_progress" };
          const [existingVersion] = await tx
            .select({ id: artifactVersions.id })
            .from(artifactVersions)
            .where(
              and(
                eq(artifactVersions.artifactId, existingArtifact.id),
                eq(artifactVersions.teamId, input.context.teamId),
                eq(artifactVersions.workspaceId, input.context.workspaceId),
                eq(
                  artifactVersions.versionNo,
                  existingArtifact.currentVersionNo,
                ),
              ),
            )
            .limit(1);
          if (!existingVersion) {
            throw new Error(
              `ARTIFACT_CURRENT_VERSION_MISSING: artifact ${existingArtifact.id} points to version ${existingArtifact.currentVersionNo}`,
            );
          }
          artifactId = existingArtifact.id;
          artifactVersionId = existingVersion.id;
          versionNo = existingArtifact.currentVersionNo;
          reused = true;
        } else {
          artifactId = input.artifact.mode.artifactId ?? newArtifactId();
          artifactVersionId = newVersionId();
          versionNo = 1;
          const now = new Date();
          await tx.insert(artifacts).values({
            id: artifactId,
            teamId: input.context.teamId,
            workspaceId: input.context.workspaceId,
            threadId: runRow.threadId,
            artifactType: input.artifact.artifactType as ArtifactType,
            status: "ready",
            currentVersionNo: versionNo,
            requestKey: input.artifact.semanticRequestKey,
            title: input.artifact.title,
            promptText: input.artifact.prompt,
            payloadJson: input.artifact.payload,
            storageBucket: input.artifact.storageBucket ?? null,
            storageKey: input.artifact.storageKey ?? null,
            previewStorageKey: input.artifact.previewStorageKey ?? null,
            previewMetadataJson: input.artifact.previewMetadata ?? {},
            visibility: publicationVisibility,
            createdBy: input.context.actorUserId,
            completedAt: now,
          });
          await tx.insert(artifactVersions).values({
            id: artifactVersionId,
            teamId: input.context.teamId,
            workspaceId: input.context.workspaceId,
            artifactId,
            versionNo,
            contentJson: input.artifact.payload,
            createdBy: input.context.actorUserId,
          });
          await failpoint("after_version_write");
        }
      }

      if (!runRow.assistantMessageId) {
        return rejectAfterWrites("message_unavailable");
      }
      const [messageRow] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, runRow.assistantMessageId),
            eq(messages.teamId, input.context.teamId),
            eq(messages.workspaceId, input.context.workspaceId),
            eq(messages.threadId, runRow.threadId),
            eq(messages.role, "assistant"),
          ),
        )
        .for("update")
        .limit(1);
      if (!messageRow) {
        return rejectAfterWrites("message_unavailable");
      }

      const snapshot = toObjectRecord(runRow.snapshotJson) ?? {};
      const messageMetadata = toObjectRecord(messageRow.metadata) ?? {};
      const blockProjection = findOrCreateArtifactOutputBlock({
        artifactId,
        artifactVersionId,
        messageBlocks: messageMetadata.renderBlocks,
        producer: input.context.producer,
        runBlocks: snapshot.renderBlocks,
        runId: runRow.id,
        sourceToolCallId: input.context.sourceToolCallId,
      });
      const canonicalOutput: CommittedArtifactToolResult = {
        status: "ready",
        type: "committed_artifact_result",
        artifactType: input.artifact.artifactType,
        artifactId,
        artifactVersionId,
        artifactOutputBlockId: blockProjection.block.id,
        workflowVersion: input.artifact.workflowVersion,
      };
      const runToolCalls = upsertCanonicalToolCall({
        calls: snapshot.toolCalls,
        output: canonicalOutput,
        producer: input.context.producer,
        sourceToolCallId: input.context.sourceToolCallId,
        sourceToolName: input.context.sourceToolName,
      });
      const snapshotAfterToolOutput = {
        ...snapshot,
        toolCalls: runToolCalls,
        ...(snapshot.traceParts
          ? {
              traceParts: updateExistingTracePartsFromToolCalls(
                snapshot.traceParts,
                runToolCalls,
              ),
            }
          : {}),
      };
      await tx
        .update(chatThreadRuns)
        .set({ snapshotJson: snapshotAfterToolOutput, updatedAt: new Date() })
        .where(eq(chatThreadRuns.id, runRow.id));
      await failpoint("after_tool_output_write");

      const messageToolCalls = upsertCanonicalToolCall({
        calls: messageMetadata.toolCalls,
        output: canonicalOutput,
        producer: input.context.producer,
        sourceToolCallId: input.context.sourceToolCallId,
        sourceToolName: input.context.sourceToolName,
      });
      const messageRenderBlocks = mergeCommittedArtifactRenderBlocks({
        incoming: arrayValue(messageMetadata.renderBlocks),
        authoritative: [blockProjection.renderBlocks],
      });
      const messageTraceParts = messageMetadata.traceParts
        ? updateExistingTracePartsFromToolCalls(
            messageMetadata.traceParts,
            messageToolCalls,
          )
        : undefined;
      const nextMessageMetadata = {
        ...messageMetadata,
        toolCalls: messageToolCalls,
        renderBlocks: messageRenderBlocks ?? blockProjection.renderBlocks,
        ...(messageTraceParts !== undefined
          ? { traceParts: messageTraceParts }
          : {}),
      };
      await tx
        .update(messages)
        .set({ metadata: nextMessageMetadata })
        .where(eq(messages.id, messageRow.id));
      await failpoint("after_message_write");

      const finalSnapshotBase = nextAssistantSnapshot({
        messageMetadata: nextMessageMetadata,
        renderBlocks: blockProjection.renderBlocks,
        snapshot: snapshotAfterToolOutput,
        toolCalls: runToolCalls,
      });
      const finalSnapshot = {
        ...finalSnapshotBase,
        renderBlocks: blockProjection.renderBlocks,
      };
      await tx
        .update(chatThreadRuns)
        .set({ snapshotJson: finalSnapshot, updatedAt: new Date() })
        .where(eq(chatThreadRuns.id, runRow.id));

      return {
        ok: true,
        artifactOutputBlock: blockProjection.block,
        result: canonicalOutput,
        reused,
        run: {
          assistantMessageId: messageRow.id,
          id: runRow.id,
          status: runRow.status,
          threadId: runRow.threadId,
          userId: runRow.userId,
          workspaceId: runRow.workspaceId,
        },
        versionNo,
      };
    });
  } catch (error) {
    if (error instanceof PublicationRejected) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}
