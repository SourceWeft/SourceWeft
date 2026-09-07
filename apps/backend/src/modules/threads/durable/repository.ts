import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { chatThreadRuns, db, messages } from "@sourceweft/db";
import { logger } from "../../../shared/logger";
import {
  publishThreadEvent,
  type ThreadEventKind,
} from "../../../shared/notify-hub";
import type {
  ChatRunSnapshot,
  ChatThreadRunMode,
  ChatThreadRunRecord,
  ChatThreadRunStatus,
  DurableRunRequestSnapshot,
} from "./types";
import type { MessageRenderBlock } from "../turn/types";
import {
  committedArtifactBlockIdentityMatches,
  hasPairedCommittedArtifactPublication,
} from "../render-block-projection";
import {
  finalizeTerminalSnapshotTrace,
  hasPendingConfirmations,
  mergeChatRunSnapshot,
  mergeCommittedArtifactRenderBlocks,
  parseStringArray,
  replaceConfirmationInToolCalls,
  updateExistingTracePartsFromToolCalls,
} from "./snapshot";
import { toObjectRecord } from "../../../shared/records";
import {
  buildAssistantMessageConfirmationMetadata,
  buildThreadRunMetadata,
  withAssistantThreadRunMetadata,
} from "./assistant-message-metadata";
import { fenceProtectedOperationsForTerminal } from "./protected-agent-tool-state";
import { isStaleActiveRun } from "./run-state";

const ACTIVE_RUN_STATUSES: ChatThreadRunStatus[] = [
  "queued",
  "running",
  "cancel_requested",
  "waiting_for_approval",
];
const RUNNER_PROGRESS_STATUSES: ChatThreadRunStatus[] = ["queued", "running"];

type ChatThreadRunRow = typeof chatThreadRuns.$inferSelect;
type ChatRunTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type LockedRunSnapshotContext = {
  runRow: ChatThreadRunRow;
  assistantMessageId: string | null;
  messageMetadata: Record<string, unknown> | null;
};

async function lockRunSnapshotContext(
  tx: ChatRunTransaction,
  input: {
    runId: string;
    teamId: string;
    workspaceId: string;
    assistantMessageId?: string | null;
  },
): Promise<LockedRunSnapshotContext | null> {
  const [runRow] = await tx
    .select()
    .from(chatThreadRuns)
    .where(
      and(
        eq(chatThreadRuns.id, input.runId),
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
      ),
    )
    .for("update")
    .limit(1);
  if (!runRow) {
    return null;
  }

  const assistantMessageId =
    input.assistantMessageId !== undefined
      ? input.assistantMessageId
      : runRow.assistantMessageId;
  const [messageRow] = assistantMessageId
    ? await tx
        .select({ metadata: messages.metadata })
        .from(messages)
        .where(
          and(
            eq(messages.id, assistantMessageId),
            eq(messages.teamId, input.teamId),
            eq(messages.workspaceId, input.workspaceId),
          ),
        )
        .for("update")
        .limit(1)
    : [];

  return {
    runRow,
    assistantMessageId,
    messageMetadata: toObjectRecord(messageRow?.metadata),
  };
}

function hasCommittedArtifactBlock(blocks: unknown[] | undefined) {
  return (blocks ?? []).some((value) => {
    const record = toObjectRecord(value);
    return record?.type === "artifact_output" && typeof record.id === "string";
  });
}

async function syncCommittedArtifactBlocksToMessage(
  tx: ChatRunTransaction,
  input: {
    assistantMessageId: string | null;
    messageMetadata: Record<string, unknown> | null;
    snapshot: ChatRunSnapshot;
  },
) {
  if (!input.assistantMessageId || !input.messageMetadata) {
    return;
  }
  const snapshotBlocks = Array.isArray(input.snapshot.renderBlocks)
    ? input.snapshot.renderBlocks
    : undefined;
  if (!hasCommittedArtifactBlock(snapshotBlocks)) {
    return;
  }
  const currentBlocks = Array.isArray(input.messageMetadata.renderBlocks)
    ? input.messageMetadata.renderBlocks
    : undefined;
  const renderBlocks = mergeCommittedArtifactRenderBlocks({
    incoming: currentBlocks,
    authoritative: [snapshotBlocks],
  });
  await tx
    .update(messages)
    .set({
      metadata: {
        ...input.messageMetadata,
        ...(renderBlocks ? { renderBlocks } : {}),
      },
    })
    .where(eq(messages.id, input.assistantMessageId));
}

function mergeLockedRunSnapshot(input: {
  context: LockedRunSnapshotContext;
  incoming?: ChatRunSnapshot;
}) {
  return mergeChatRunSnapshot({
    current: (input.context.runRow.snapshotJson ?? {}) as ChatRunSnapshot,
    incoming: input.incoming,
    assistantMessageMetadata: input.context.messageMetadata,
  });
}

function mergeLockedTerminalSnapshot(input: {
  context: LockedRunSnapshotContext;
  incoming?: ChatRunSnapshot;
  projectedRun: ChatThreadRunRecord;
}) {
  const current = mergeLockedRunSnapshot({ context: input.context });
  const incoming = input.incoming ?? {};
  const currentAssistant = current.assistantMessage;
  const incomingAssistant = incoming.assistantMessage;
  const currentMetadata = toObjectRecord(currentAssistant?.metadata) ?? {};
  const incomingMetadata = toObjectRecord(incomingAssistant?.metadata) ?? {};
  const terminalMetadata = Object.fromEntries(
    ["error", "errorCode", "finishReason", "isCancelled", "isError"]
      .filter((key) => incomingMetadata[key] !== undefined)
      .map((key) => [key, incomingMetadata[key]]),
  );
  const terminalFields = Object.fromEntries(
    ["errorCode", "errorMessage", "finishReason", "lastEventType"]
      .filter((key) => incoming[key as keyof ChatRunSnapshot] !== undefined)
      .map((key) => [key, incoming[key as keyof ChatRunSnapshot]]),
  );
  const terminalSnapshot = {
    ...current,
    ...terminalFields,
    ...(currentAssistant || incomingAssistant
      ? {
          assistantMessage: {
            ...(currentAssistant ?? incomingAssistant!),
            metadata: {
              ...currentMetadata,
              ...terminalMetadata,
            },
          },
        }
      : {}),
  };
  const snapshot =
    input.projectedRun.status === "completed"
      ? terminalSnapshot
      : finalizeTerminalSnapshotTrace(terminalSnapshot);
  return withAssistantThreadRunMetadata(snapshot, input.projectedRun);
}

function mapRun(row: ChatThreadRunRow): ChatThreadRunRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    userId: row.userId,
    userMessageId: row.userMessageId,
    assistantMessageId: row.assistantMessageId,
    idempotencyKey: row.idempotencyKey,
    mode: row.mode,
    jobId: row.jobId,
    streamKey: row.streamKey,
    status: row.status,
    eventOffset: row.eventOffset,
    requestJson: row.requestJson ?? {},
    snapshotJson: row.snapshotJson ?? {},
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function isActiveChatRunStatus(status: ChatThreadRunStatus) {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/**
 * Broadcast a run transition to thread subscribers (live collaboration). Emitted
 * only when the write actually happened (`run` truthy) — every status UPDATE is
 * guarded by a `where status in (...)` clause and returns no row on a lost race,
 * so a no-op transition never produces a spurious event. Fire-and-forget: a
 * NOTIFY failure is logged, never allowed to fail the surrounding write.
 */
function emitRunEvent(
  run: ChatThreadRunRecord | null,
  kind: ThreadEventKind,
): void {
  if (!run) {
    return;
  }
  void publishThreadEvent({
    threadId: run.threadId,
    workspaceId: run.workspaceId,
    kind,
    actorUserId: run.userId,
    runId: run.id,
    status: run.status,
    ...(run.userMessageId ? { userMessageId: run.userMessageId } : {}),
    ...(run.assistantMessageId
      ? { assistantMessageId: run.assistantMessageId }
      : {}),
  }).catch((error) => {
    logger.warn("Failed to publish thread run event", {
      runId: run.id,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function findChatThreadRunById(input: {
  runId: string;
  teamId?: string;
  workspaceId?: string;
}) {
  const conditions = [eq(chatThreadRuns.id, input.runId)];
  if (input.teamId) {
    conditions.push(eq(chatThreadRuns.teamId, input.teamId));
  }
  if (input.workspaceId) {
    conditions.push(eq(chatThreadRuns.workspaceId, input.workspaceId));
  }

  const [row] = await db
    .select()
    .from(chatThreadRuns)
    .where(and(...conditions))
    .limit(1);

  return row ? mapRun(row) : null;
}

export async function findChatThreadRunByIdempotencyKey(input: {
  teamId: string;
  workspaceId: string;
  idempotencyKey: string;
}) {
  const [row] = await db
    .select()
    .from(chatThreadRuns)
    .where(
      and(
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
        eq(chatThreadRuns.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);

  return row ? mapRun(row) : null;
}

export async function findActiveChatThreadRun(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const [row] = await db
    .select()
    .from(chatThreadRuns)
    .where(
      and(
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
        eq(chatThreadRuns.threadId, input.threadId),
        inArray(chatThreadRuns.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .orderBy(desc(chatThreadRuns.createdAt))
    .limit(1);

  return row ? mapRun(row) : null;
}

/** Summary only: never load a previous run's request or large snapshot for polling. */
export async function findLatestChatThreadRunSummary(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
}) {
  const [row] = await db
    .select({
      id: chatThreadRuns.id,
      idempotencyKey: chatThreadRuns.idempotencyKey,
      userId: chatThreadRuns.userId,
      status: chatThreadRuns.status,
      assistantMessageId: chatThreadRuns.assistantMessageId,
      errorCode: chatThreadRuns.errorCode,
      errorMessage: chatThreadRuns.errorMessage,
    })
    .from(chatThreadRuns)
    .where(
      and(
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
        eq(chatThreadRuns.threadId, input.threadId),
      ),
    )
    // Select the latest run BEFORE testing its status. A later success or
    // active run must suppress an older preparation failure.
    .orderBy(desc(chatThreadRuns.createdAt), desc(chatThreadRuns.id))
    .limit(1);
  return row ?? null;
}

export async function listExpiredApprovalWaitingRuns(input: {
  limit: number;
  now?: Date;
}) {
  const rows = await db
    .select()
    .from(chatThreadRuns)
    .where(
      and(
        eq(chatThreadRuns.status, "waiting_for_approval"),
        sql`(${chatThreadRuns.snapshotJson}->>'approvalExpiresAt') is not null`,
        sql`(${chatThreadRuns.snapshotJson}->>'approvalExpiresAt')::timestamptz <= ${input.now ?? new Date()}`,
      ),
    )
    .orderBy(desc(chatThreadRuns.createdAt))
    .limit(input.limit);

  return rows.map(mapRun);
}

export async function createChatThreadRun(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  idempotencyKey: string;
  mode: ChatThreadRunMode;
  requestJson: DurableRunRequestSnapshot;
}) {
  const id = randomUUID();
  const streamKey = `chat-run-events:${id}`;
  const now = new Date();
  const [row] = await db
    .insert(chatThreadRuns)
    .values({
      id,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      mode: input.mode,
      streamKey,
      status: "queued",
      heartbeatAt: now,
      requestJson: input.requestJson as unknown as Record<string, unknown>,
      snapshotJson: {},
    })
    .onConflictDoNothing({
      target: [
        chatThreadRuns.teamId,
        chatThreadRuns.workspaceId,
        chatThreadRuns.idempotencyKey,
      ],
    })
    .returning();

  const run = row ? mapRun(row) : null;
  // The most important collaboration signal: a member with the thread open
  // learns another member started a run (so their client engages the queue).
  emitRunEvent(run, "run_created");
  return run;
}

export async function markChatThreadRunQueued(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
  jobId: string;
}) {
  const [row] = await db
    .update(chatThreadRuns)
    .set({
      jobId: input.jobId,
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatThreadRuns.id, input.runId),
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
      ),
    )
    .returning();

  return row ? mapRun(row) : null;
}

export async function markChatThreadRunRunning(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
}) {
  const [row] = await db
    .update(chatThreadRuns)
    .set({
      status: "running",
      startedAt: sql`coalesce(${chatThreadRuns.startedAt}, now())`,
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatThreadRuns.id, input.runId),
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
        eq(chatThreadRuns.status, "queued"),
      ),
    )
    .returning();

  const run = row ? mapRun(row) : null;
  emitRunEvent(run, "run_started");
  return run;
}

export async function updateChatThreadRunProgress(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  eventOffset?: number;
  snapshotJson?: ChatRunSnapshot;
}) {
  const row = await db.transaction(async (tx) => {
    const context = await lockRunSnapshotContext(tx, input);
    if (!context || !RUNNER_PROGRESS_STATUSES.includes(context.runRow.status)) {
      return null;
    }
    const snapshot =
      input.snapshotJson === undefined
        ? undefined
        : mergeLockedRunSnapshot({
            context,
            incoming: input.snapshotJson,
          });
    const set: Partial<typeof chatThreadRuns.$inferInsert> = {
      heartbeatAt: new Date(),
      updatedAt: new Date(),
      ...(input.userMessageId !== undefined
        ? { userMessageId: input.userMessageId }
        : {}),
      ...(input.assistantMessageId !== undefined
        ? { assistantMessageId: input.assistantMessageId }
        : {}),
      ...(input.eventOffset !== undefined
        ? {
            eventOffset: Math.max(
              context.runRow.eventOffset,
              input.eventOffset,
            ),
          }
        : {}),
      ...(snapshot
        ? {
            snapshotJson: snapshot as unknown as Record<string, unknown>,
          }
        : {}),
    };
    const [updated] = await tx
      .update(chatThreadRuns)
      .set(set)
      .where(
        and(
          eq(chatThreadRuns.id, context.runRow.id),
          eq(chatThreadRuns.status, context.runRow.status),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    if (snapshot) {
      await syncCommittedArtifactBlocksToMessage(tx, {
        assistantMessageId: context.assistantMessageId,
        messageMetadata: context.messageMetadata,
        snapshot,
      });
    }
    return updated;
  });

  return row ? mapRun(row) : null;
}

type ArtifactOutputBlock = Extract<
  MessageRenderBlock,
  { type: "artifact_output" }
>;

/**
 * Append one committed artifact version to a durable run and its assistant
 * message. The run row is the serialization point for concurrent publishers
 * (including sibling sub-agents and a background deliverable worker).
 */
export async function appendArtifactOutputToChatRun(input: {
  artifactId: string;
  artifactVersionId: string;
  producer: ArtifactOutputBlock["producer"];
  runId: string;
  sourceToolCallId: string;
  teamId: string;
  workspaceId: string;
}) {
  const result = await db.transaction(async (tx) => {
    const [runRow] = await tx
      .select()
      .from(chatThreadRuns)
      .where(
        and(
          eq(chatThreadRuns.id, input.runId),
          eq(chatThreadRuns.teamId, input.teamId),
          eq(chatThreadRuns.workspaceId, input.workspaceId),
        ),
      )
      .for("update")
      .limit(1);
    if (!runRow) {
      throw new Error(
        `ARTIFACT_OUTPUT_RUN_NOT_FOUND: chat run ${input.runId} was not found`,
      );
    }
    // Match the module's shared active-status set, not a hand-rolled
    // subset: this had drifted out of sync and omitted cancel_requested,
    // silently dropping an artifact that finished publishing during the
    // cancel window — the publish itself already succeeded (bytes are in
    // object storage), so refusing to attach the block only orphaned it
    // from the conversation with no repair path.
    if (!ACTIVE_RUN_STATUSES.includes(runRow.status)) {
      return { block: null, run: mapRun(runRow) };
    }

    const id = `artifact-output:${input.runId}:${input.artifactId}:${input.artifactVersionId}`;
    const snapshot = (runRow.snapshotJson ?? {}) as Record<string, unknown>;
    const snapshotBlocks = Array.isArray(snapshot.renderBlocks)
      ? snapshot.renderBlocks
      : [];
    const [messageRow] = runRow.assistantMessageId
      ? await tx
          .select({ metadata: messages.metadata })
          .from(messages)
          .where(
            and(
              eq(messages.id, runRow.assistantMessageId),
              eq(messages.teamId, input.teamId),
              eq(messages.workspaceId, input.workspaceId),
            ),
          )
          .for("update")
          .limit(1)
      : [];
    const messageBlocks = Array.isArray(messageRow?.metadata?.renderBlocks)
      ? messageRow.metadata.renderBlocks
      : [];
    const currentBlocks =
      mergeCommittedArtifactRenderBlocks({
        incoming: snapshotBlocks,
        authoritative: [messageBlocks],
      }) ?? [];
    const existing = currentBlocks.find(
      (value) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { id?: unknown }).id === id,
    );
    if (existing) {
      if (
        !committedArtifactBlockIdentityMatches(existing, {
          artifactId: input.artifactId,
          artifactVersionId: input.artifactVersionId,
          id,
          placement: "terminal",
          producer: input.producer,
          sourceToolCallId: input.sourceToolCallId,
          threadRunId: input.runId,
          type: "artifact_output",
        })
      ) {
        throw new Error(
          `ARTIFACT_OUTPUT_ID_CONFLICT: committed block ${id} has different identity`,
        );
      }
    }
    const sequence =
      currentBlocks.reduce<number>((highest, value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return highest;
        }
        const record = value as { sequence?: unknown; type?: unknown };
        return record.type === "artifact_output" &&
          typeof record.sequence === "number" &&
          Number.isFinite(record.sequence)
          ? Math.max(highest, record.sequence)
          : highest;
      }, 0) + 1;
    const block: ArtifactOutputBlock = existing
      ? (existing as ArtifactOutputBlock)
      : {
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
    const renderBlocks = existing ? currentBlocks : [...currentBlocks, block];
    const nextSnapshot = { ...snapshot, renderBlocks };

    const [updatedRun] = await tx
      .update(chatThreadRuns)
      .set({ snapshotJson: nextSnapshot, updatedAt: new Date() })
      .where(eq(chatThreadRuns.id, runRow.id))
      .returning();
    if (!updatedRun) {
      throw new Error(
        `ARTIFACT_OUTPUT_RUN_UPDATE_FAILED: chat run ${input.runId} could not be updated`,
      );
    }

    if (runRow.assistantMessageId) {
      if (messageRow) {
        const messageRenderBlocks = mergeCommittedArtifactRenderBlocks({
          incoming: messageBlocks,
          authoritative: [renderBlocks],
        });
        await tx
          .update(messages)
          .set({
            metadata: {
              ...(messageRow.metadata ?? {}),
              ...(messageRenderBlocks
                ? { renderBlocks: messageRenderBlocks }
                : {}),
            },
          })
          .where(eq(messages.id, runRow.assistantMessageId));
      }
    }

    return { block, run: mapRun(updatedRun) };
  });

  if (!result.block) {
    return null;
  }

  void publishThreadEvent({
    threadId: result.run.threadId,
    workspaceId: result.run.workspaceId,
    kind: "artifact_output",
    actorUserId: result.run.userId,
    runId: result.run.id,
    status: result.run.status,
    ...(result.run.assistantMessageId
      ? { assistantMessageId: result.run.assistantMessageId }
      : {}),
  }).catch((error) => {
    logger.warn("Failed to publish artifact output thread event", {
      runId: result.run.id,
      artifactId: input.artifactId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return result.block;
}

/**
 * Repair only the committed artifact projection from the authoritative run and
 * assistant-message records. This is the sole snapshot mutation allowed after
 * a run is terminal; runner-owned fields and status remain untouched.
 */
export async function repairChatThreadRunArtifactOutputProjection(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
}) {
  const row = await db.transaction(async (tx) => {
    const context = await lockRunSnapshotContext(tx, input);
    if (!context) {
      return null;
    }
    if (
      context.runRow.status !== "completed" &&
      context.runRow.status !== "failed" &&
      context.runRow.status !== "cancelled"
    ) {
      return null;
    }
    const snapshot = mergeLockedRunSnapshot({ context });
    const [updated] = await tx
      .update(chatThreadRuns)
      .set({
        snapshotJson: snapshot as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(chatThreadRuns.id, context.runRow.id))
      .returning();
    if (!updated) {
      return null;
    }
    await syncCommittedArtifactBlocksToMessage(tx, {
      assistantMessageId: context.assistantMessageId,
      messageMetadata: context.messageMetadata,
      snapshot,
    });
    return updated;
  });
  return row ? mapRun(row) : null;
}

export async function requestChatThreadRunCancel(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
}) {
  const result = await db.transaction(async (tx) => {
    const context = await lockRunSnapshotContext(tx, input);
    if (
      !context ||
      (context.runRow.status !== "queued" &&
        context.runRow.status !== "running" &&
        context.runRow.status !== "waiting_for_approval")
    ) {
      return null;
    }
    const snapshot = mergeLockedRunSnapshot({ context });
    const committed = hasPairedCommittedArtifactPublication({
      toolCalls: snapshot.toolCalls,
      renderBlocks: snapshot.renderBlocks,
      runId: context.runRow.id,
    });
    const now = new Date();
    if (committed) {
      const projectedRun: ChatThreadRunRecord = {
        ...mapRun(context.runRow),
        status: "completed",
        finishedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      const completedSnapshot = withAssistantThreadRunMetadata(
        fenceProtectedOperationsForTerminal({
          snapshot,
          scope: {
            runId: context.runRow.id,
            teamId: context.runRow.teamId,
            workspaceId: context.runRow.workspaceId,
          },
          reason: "RUN_COMPLETED_BEFORE_CANCEL",
          markedAt: now.toISOString(),
        }),
        projectedRun,
      );
      const [row] = await tx
        .update(chatThreadRuns)
        .set({
          status: "completed",
          snapshotJson: completedSnapshot as unknown as Record<string, unknown>,
          finishedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatThreadRuns.id, context.runRow.id),
            eq(chatThreadRuns.status, context.runRow.status),
          ),
        )
        .returning();
      if (row && context.assistantMessageId && context.messageMetadata) {
        await tx
          .update(messages)
          .set({
            metadata: {
              ...context.messageMetadata,
              ...buildThreadRunMetadata(mapRun(row)),
            },
          })
          .where(eq(messages.id, context.assistantMessageId));
      }
      return row ? { row, event: "run_finished" as const } : null;
    }
    const [row] = await tx
      .update(chatThreadRuns)
      .set({ status: "cancel_requested", updatedAt: now })
      .where(
        and(
          eq(chatThreadRuns.id, context.runRow.id),
          eq(chatThreadRuns.status, context.runRow.status),
        ),
      )
      .returning();
    return row ? { row, event: "run_cancel_requested" as const } : null;
  });

  const run = result ? mapRun(result.row) : null;
  emitRunEvent(run, result?.event ?? "run_cancel_requested");
  return run;
}

export async function recordChatThreadRunConfirmationResponse(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
  confirmationId: string;
  confirmation: unknown;
}) {
  const result = await db.transaction(async (tx) => {
    const context = await lockRunSnapshotContext(tx, input);
    if (!context) {
      return null;
    }
    if (context.runRow.status !== "waiting_for_approval") {
      return { runRow: context.runRow, completed: false };
    }
    const currentSnapshot = mergeLockedRunSnapshot({ context });
    const replaced = replaceConfirmationInToolCalls(
      currentSnapshot.toolCalls,
      input.confirmationId,
      input.confirmation,
    );
    if (!replaced.changed) {
      return { runRow: context.runRow, completed: false };
    }
    const traceParts = updateExistingTracePartsFromToolCalls(
      currentSnapshot.traceParts,
      replaced.toolCalls,
    );
    const completed = !hasPendingConfirmations(replaced.toolCalls);
    const status = completed ? "completed" : "waiting_for_approval";
    const now = new Date();
    const projectedRun: ChatThreadRunRecord = {
      ...mapRun(context.runRow),
      status,
      ...(completed
        ? { finishedAt: now.toISOString(), updatedAt: now.toISOString() }
        : {}),
    };
    const mergedSnapshot = {
      ...currentSnapshot,
      toolCalls: replaced.toolCalls,
      ...(traceParts !== undefined ? { traceParts } : {}),
      pendingConfirmationIds: completed
        ? []
        : parseStringArray(currentSnapshot.pendingConfirmationIds).filter(
            (id) => id !== input.confirmationId,
          ),
    };
    // Mirror finishChatThreadRun: completing a run must fence any still
    // "in_progress" protected-tool claim to "unknown" the same way every
    // other terminal transition does. This path completes a run directly
    // (the last approval on a waiting_for_approval run drives it straight
    // to completed) without going through finishChatThreadRun, so it was
    // the one terminal transition that never fenced — leaving a stale
    // in_progress claim behind, the exact gap run-fencing exists to close.
    const snapshot = withAssistantThreadRunMetadata(
      completed
        ? fenceProtectedOperationsForTerminal({
            snapshot: mergedSnapshot,
            scope: {
              runId: context.runRow.id,
              teamId: context.runRow.teamId,
              workspaceId: context.runRow.workspaceId,
            },
            reason: "RUN_TERMINATED_COMPLETED",
            markedAt: now.toISOString(),
          })
        : mergedSnapshot,
      projectedRun,
    );
    const [updated] = await tx
      .update(chatThreadRuns)
      .set({
        status,
        snapshotJson: snapshot as unknown as Record<string, unknown>,
        ...(completed
          ? {
              errorCode: null,
              errorMessage: null,
              finishedAt: now,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(chatThreadRuns.id, context.runRow.id),
          eq(chatThreadRuns.status, "waiting_for_approval"),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    const run = mapRun(updated);
    if (context.assistantMessageId && context.messageMetadata) {
      await tx
        .update(messages)
        .set({
          metadata: buildAssistantMessageConfirmationMetadata({
            currentMetadata: context.messageMetadata,
            run,
            snapshot,
          }),
        })
        .where(eq(messages.id, context.assistantMessageId));
    }
    return { runRow: updated, completed };
  });

  const run = result ? mapRun(result.runRow) : null;
  if (result?.completed) {
    emitRunEvent(run, "run_finished");
  }
  return run;
}

export async function markChatThreadRunWaitingForApproval(input: {
  assistantMessageId?: string | null;
  runId: string;
  teamId: string;
  workspaceId: string;
  snapshotJson: ChatRunSnapshot;
}) {
  const row = await db.transaction(async (tx) => {
    const context = await lockRunSnapshotContext(tx, input);
    if (!context || context.runRow.status !== "running") {
      return null;
    }
    const snapshot = mergeLockedRunSnapshot({
      context,
      incoming: input.snapshotJson,
    });
    const [updated] = await tx
      .update(chatThreadRuns)
      .set({
        status: "waiting_for_approval",
        ...(input.assistantMessageId !== undefined
          ? { assistantMessageId: input.assistantMessageId }
          : {}),
        snapshotJson: snapshot as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatThreadRuns.id, context.runRow.id),
          eq(chatThreadRuns.status, "running"),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    await syncCommittedArtifactBlocksToMessage(tx, {
      assistantMessageId: context.assistantMessageId,
      messageMetadata: context.messageMetadata,
      snapshot,
    });
    return updated;
  });

  const run = row ? mapRun(row) : null;
  emitRunEvent(run, "run_waiting_approval");
  return run;
}

export async function finishChatThreadRun(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
  status: Extract<ChatThreadRunStatus, "completed" | "failed" | "cancelled">;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  snapshotJson?: ChatRunSnapshot;
  snapshotMode?: "runner_full" | "terminal_patch";
  protectedOperationTerminalReason?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Recovery must recheck liveness after acquiring the run row lock. */
  staleAt?: Date;
}) {
  const allowedSourceStatuses: ChatThreadRunStatus[] =
    input.status === "completed"
      ? ["running", "waiting_for_approval"]
      : ACTIVE_RUN_STATUSES;
  const row = await db.transaction(async (tx) => {
    const context = await lockRunSnapshotContext(tx, input);
    if (!context || !allowedSourceStatuses.includes(context.runRow.status)) {
      return null;
    }
    if (
      input.staleAt &&
      !isStaleActiveRun(mapRun(context.runRow), input.staleAt.getTime())
    ) {
      return null;
    }
    const now = new Date();
    const projectedRun: ChatThreadRunRecord = {
      ...mapRun(context.runRow),
      status: input.status,
      userMessageId:
        input.userMessageId !== undefined
          ? input.userMessageId
          : context.runRow.userMessageId,
      assistantMessageId:
        input.assistantMessageId !== undefined
          ? input.assistantMessageId
          : context.runRow.assistantMessageId,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      finishedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const mergedSnapshot =
      input.snapshotMode === "terminal_patch"
        ? mergeLockedTerminalSnapshot({
            context,
            incoming: input.snapshotJson,
            projectedRun,
          })
        : mergeLockedRunSnapshot({
            context,
            incoming: input.snapshotJson,
          });
    const snapshot = fenceProtectedOperationsForTerminal({
      snapshot: mergedSnapshot,
      scope: {
        runId: context.runRow.id,
        teamId: context.runRow.teamId,
        workspaceId: context.runRow.workspaceId,
      },
      reason:
        input.protectedOperationTerminalReason ??
        `RUN_TERMINATED_${input.status.toUpperCase()}`,
      markedAt: now.toISOString(),
    });
    const [updated] = await tx
      .update(chatThreadRuns)
      .set({
        status: input.status,
        ...(input.userMessageId !== undefined
          ? { userMessageId: input.userMessageId }
          : {}),
        ...(input.assistantMessageId !== undefined
          ? { assistantMessageId: input.assistantMessageId }
          : {}),
        snapshotJson: snapshot as unknown as Record<string, unknown>,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatThreadRuns.id, context.runRow.id),
          eq(chatThreadRuns.status, context.runRow.status),
        ),
      )
      .returning();
    if (!updated) {
      return null;
    }
    await syncCommittedArtifactBlocksToMessage(tx, {
      assistantMessageId: context.assistantMessageId,
      messageMetadata: context.messageMetadata,
      snapshot,
    });
    return updated;
  });

  const run = row ? mapRun(row) : null;
  // Doubles as "assistant message finalized": the payload carries the message
  // ids so the client can reconcile the completed turn.
  emitRunEvent(run, "run_finished");
  return run;
}

export async function touchChatThreadRunHeartbeat(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
}) {
  const [row] = await db
    .update(chatThreadRuns)
    .set({
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatThreadRuns.id, input.runId),
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
        inArray(chatThreadRuns.status, ACTIVE_RUN_STATUSES),
      ),
    )
    .returning();

  return row ? mapRun(row) : null;
}
