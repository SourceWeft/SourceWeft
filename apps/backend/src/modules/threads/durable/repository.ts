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

const ACTIVE_RUN_STATUSES: ChatThreadRunStatus[] = [
  "queued",
  "running",
  "cancel_requested",
  "waiting_for_approval",
];

type ChatThreadRunRow = typeof chatThreadRuns.$inferSelect;

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
  const set: Partial<typeof chatThreadRuns.$inferInsert> = {
    heartbeatAt: new Date(),
    updatedAt: new Date(),
  };
  if (input.userMessageId !== undefined) {
    set.userMessageId = input.userMessageId;
  }
  if (input.assistantMessageId !== undefined) {
    set.assistantMessageId = input.assistantMessageId;
  }
  if (input.eventOffset !== undefined) {
    set.eventOffset = input.eventOffset;
  }
  if (input.snapshotJson !== undefined) {
    set.snapshotJson = input.snapshotJson as unknown as Record<string, unknown>;
  }

  const [row] = await db
    .update(chatThreadRuns)
    .set(set)
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
    const currentBlocks = [...snapshotBlocks];
    const knownIds = new Set(
      snapshotBlocks.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }
        const blockId = (value as { id?: unknown }).id;
        return typeof blockId === "string" ? [blockId] : [];
      }),
    );
    for (const value of messageBlocks) {
      const blockId =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as { id?: unknown }).id
          : undefined;
      if (typeof blockId !== "string" || knownIds.has(blockId)) {
        continue;
      }
      knownIds.add(blockId);
      currentBlocks.push(value);
    }
    const existing = currentBlocks.find(
      (value) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as { id?: unknown }).id === id,
    );
    const sequence =
      currentBlocks.reduce((highest, value) => {
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
        await tx
          .update(messages)
          .set({
            metadata: {
              ...(messageRow.metadata ?? {}),
              renderBlocks,
            },
          })
          .where(eq(messages.id, runRow.assistantMessageId));
      }
    }

    return { block, run: mapRun(updatedRun) };
  });

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

export async function requestChatThreadRunCancel(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
}) {
  const [row] = await db
    .update(chatThreadRuns)
    .set({
      status: "cancel_requested",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatThreadRuns.id, input.runId),
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
        inArray(chatThreadRuns.status, [
          "queued",
          "running",
          "waiting_for_approval",
        ]),
      ),
    )
    .returning();

  const run = row ? mapRun(row) : null;
  emitRunEvent(run, "run_cancel_requested");
  return run;
}

export async function updateChatThreadRunStatus(input: {
  runId: string;
  teamId: string;
  workspaceId: string;
  status: ChatThreadRunStatus;
  snapshotJson?: ChatRunSnapshot;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const [row] = await db
    .update(chatThreadRuns)
    .set({
      status: input.status,
      ...(input.snapshotJson !== undefined
        ? {
            snapshotJson: input.snapshotJson as unknown as Record<
              string,
              unknown
            >,
          }
        : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined
        ? { errorMessage: input.errorMessage }
        : {}),
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

export async function markChatThreadRunWaitingForApproval(input: {
  assistantMessageId?: string | null;
  runId: string;
  teamId: string;
  workspaceId: string;
  snapshotJson: ChatRunSnapshot;
}) {
  const [row] = await db
    .update(chatThreadRuns)
    .set({
      status: "waiting_for_approval",
      ...(input.assistantMessageId !== undefined
        ? { assistantMessageId: input.assistantMessageId }
        : {}),
      snapshotJson: input.snapshotJson as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatThreadRuns.id, input.runId),
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
        eq(chatThreadRuns.status, "running"),
      ),
    )
    .returning();

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
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const allowedSourceStatuses: ChatThreadRunStatus[] =
    input.status === "completed"
      ? ["running", "waiting_for_approval"]
      : ACTIVE_RUN_STATUSES;
  const [row] = await db
    .update(chatThreadRuns)
    .set({
      status: input.status,
      ...(input.userMessageId !== undefined
        ? { userMessageId: input.userMessageId }
        : {}),
      ...(input.assistantMessageId !== undefined
        ? { assistantMessageId: input.assistantMessageId }
        : {}),
      snapshotJson: (input.snapshotJson ?? {}) as unknown as Record<
        string,
        unknown
      >,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatThreadRuns.id, input.runId),
        eq(chatThreadRuns.teamId, input.teamId),
        eq(chatThreadRuns.workspaceId, input.workspaceId),
        inArray(chatThreadRuns.status, allowedSourceStatuses),
      ),
    )
    .returning();

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
