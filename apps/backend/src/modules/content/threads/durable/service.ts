import { ContentError } from "../../errors";
import { requireContentWorkspace } from "../../content-support";
import {
  enqueueThreadChatRunJob,
  type ThreadChatRunJobPayload,
} from "../../queue";
import { findMessageRecord } from "../message-repository";
import { findThreadRecord } from "../thread/repository";
import type { EditThreadInput, RefreshThreadInput } from "../stream/types";
import type { StreamThreadEventInput } from "../turn/types";
import {
  createChatThreadRun,
  findActiveChatThreadRun,
  findChatThreadRunById,
  findChatThreadRunByIdempotencyKey,
  finishChatThreadRun,
  isActiveChatRunStatus,
  markChatThreadRunQueued,
  markChatThreadRunRunning,
  requestChatThreadRunCancel,
  touchChatThreadRunHeartbeat,
  updateChatThreadRunProgress,
} from "./repository";
import {
  chatRunStreamManager,
  type ChatRunStreamEvent,
} from "./stream-manager";
import { SOURCEWEFT_WEB_RUN_STOP_SUFFIX } from "./constants";
import type {
  ChatRunSnapshot,
  ChatThreadRunMode,
  ChatThreadRunRecord,
  ChatThreadRunStatus,
  DurableRunRequestSnapshot,
} from "./types";
import type {
  EmbeddingVectorStrategy,
  MessageRecord,
  ThreadRecord,
} from "../../types";

const ATTACH_POLL_MS = 100;
const ATTACH_HEARTBEAT_MS = 15_000;
const RESULT_POLL_MS = 200;
const STOP_RESULT_WAIT_TIMEOUT_MS = 10_000;
const COMPLETE_RESULT_WAIT_TIMEOUT_MS = 120_000;
const ORPHANED_QUEUED_RUN_GRACE_MS = 10_000;
const STALE_ACTIVE_RUN_TIMEOUT_MS = 10 * 60_000;
const CLIENT_CANCELLED_CODE = "CLIENT_CANCELLED";
const CLIENT_CANCELLED_MESSAGE = "Chat run was cancelled";
const STALE_CHAT_RUN_CODE = "CHAT_RUN_STALE";
const ACTIVE_RUN_CONSTRAINT = "chat_thread_runs_thread_active_uq";

function wait(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTerminalRunStatus(status: ChatThreadRunRecord["status"]) {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function toTerminalJobStatus(status: ChatThreadRunStatus) {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "cancelled";
}

export function toTerminalRunError(run: ChatThreadRunRecord) {
  if (run.status === "cancelled") {
    return new ContentError(
      499,
      run.errorCode ?? CLIENT_CANCELLED_CODE,
      run.errorMessage ?? CLIENT_CANCELLED_MESSAGE,
    );
  }
  if (run.status === "failed") {
    return new ContentError(
      500,
      run.errorCode ?? "CHAT_RUN_FAILED",
      run.errorMessage ?? "Chat run failed",
    );
  }
  return null;
}

function parseRunTimestamp(value: string | null) {
  if (!value) {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

export function isStaleActiveRun(
  run: ChatThreadRunRecord,
  nowMs = Date.now(),
) {
  if (!isActiveChatRunStatus(run.status)) {
    return false;
  }

  if (run.status === "queued" && !run.jobId) {
    const createdAtMs = parseRunTimestamp(run.createdAt);
    return (
      createdAtMs !== null &&
      nowMs - createdAtMs > ORPHANED_QUEUED_RUN_GRACE_MS
    );
  }

  const heartbeatAtMs =
    parseRunTimestamp(run.heartbeatAt) ??
    parseRunTimestamp(run.updatedAt) ??
    parseRunTimestamp(run.startedAt) ??
    parseRunTimestamp(run.createdAt);
  return (
    heartbeatAtMs !== null &&
    nowMs - heartbeatAtMs > STALE_ACTIVE_RUN_TIMEOUT_MS
  );
}

async function failRunBeforeMessages(
  run: ChatThreadRunRecord,
  error: { code: string; message: string },
) {
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({
      type: "error",
      code: error.code,
      error: error.message,
    })}\n\n`,
  );
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({ type: "finish" })}\n\n`,
  );
  return finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "failed",
    assistantMessageId: null,
    snapshotJson: {
      ...(run.snapshotJson as ChatRunSnapshot),
      errorCode: error.code,
      errorMessage: error.message,
    },
    errorCode: error.code,
    errorMessage: error.message,
  });
}

async function cancelRunBeforeMessages(run: ChatThreadRunRecord) {
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({
      type: "error",
      code: CLIENT_CANCELLED_CODE,
      error: CLIENT_CANCELLED_MESSAGE,
    })}\n\n`,
  );
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({ type: "finish" })}\n\n`,
  );
  return finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "cancelled",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: {
      ...(run.snapshotJson as ChatRunSnapshot),
      errorCode: CLIENT_CANCELLED_CODE,
      errorMessage: CLIENT_CANCELLED_MESSAGE,
    },
    errorCode: CLIENT_CANCELLED_CODE,
    errorMessage: CLIENT_CANCELLED_MESSAGE,
  });
}

async function failStaleActiveRun(run: ChatThreadRunRecord) {
  await chatRunStreamManager.appendEvent(
    run.streamKey,
    `data: ${JSON.stringify({ type: "finish" })}\n\n`,
  );
  return finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "failed",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: {
      ...(run.snapshotJson as ChatRunSnapshot),
      errorCode: STALE_CHAT_RUN_CODE,
    },
    errorCode: STALE_CHAT_RUN_CODE,
    errorMessage: null,
  });
}

async function failRunIfStale(run: ChatThreadRunRecord) {
  if (!isStaleActiveRun(run)) {
    return run;
  }

  if (run.status === "queued" && !run.jobId) {
    return (
      (await failRunBeforeMessages(run, {
        code: "CHAT_RUN_START_FAILED",
        message: "Previous chat run failed before it started.",
      })) ?? run
    );
  }

  return (await failStaleActiveRun(run)) ?? run;
}

function isUniqueConstraintError(error: unknown, constraint: string) {
  const record =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : null;
  return record?.code === "23505" && record.constraint === constraint;
}

function parseSsePayload(payload: string): Record<string, unknown> | null {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("data: ")) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice("data: ".length)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function buildEmptyBilling(teamId: string) {
  return {
    teamId,
    consumedCredits: 0,
    availableCredits: 0,
    consumedThisCycle: 0,
    idempotencyReplayed: false,
  };
}

function normalizeVectorStrategy(value: unknown): EmbeddingVectorStrategy | null {
  return value === "ann_hnsw" ||
    value === "exact_vector" ||
    value === "bm25_only"
    ? value
    : null;
}

export function normalizeRetrievalSnapshot(
  value: unknown,
): ChatRunSnapshot["retrieval"] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!record) {
    return undefined;
  }

  return {
    embeddingProfileId:
      typeof record.embeddingProfileId === "string"
        ? record.embeddingProfileId
        : null,
    vectorStrategy: normalizeVectorStrategy(record.vectorStrategy),
    annIndexUsed:
      typeof record.annIndexUsed === "string" ? record.annIndexUsed : null,
    citations: Array.isArray(record.citations) ? record.citations : [],
    availableCitations: Array.isArray(record.availableCitations)
      ? record.availableCitations
      : Array.isArray(record.citations)
        ? record.citations
        : [],
  };
}

export function synthesizeTerminalRunEvents(input: {
  run: ChatThreadRunRecord;
  sawErrorEvent: boolean;
}) {
  const events: string[] = [];
  const terminalError =
    input.run.errorCode === STALE_CHAT_RUN_CODE
      ? null
      : toTerminalRunError(input.run);
  if (terminalError && !input.sawErrorEvent) {
    events.push(
      `data: ${JSON.stringify({
        type: "error",
        code: terminalError.code,
        error: terminalError.message,
        ...(input.run.userMessageId
          ? { userMessageId: input.run.userMessageId }
          : {}),
        ...(input.run.assistantMessageId
          ? { messageId: input.run.assistantMessageId }
          : {}),
      })}\n\n`,
    );
  }
  events.push(`data: ${JSON.stringify({ type: "finish" })}\n\n`);
  return events;
}

async function getRunResult(run: ChatThreadRunRecord) {
  const snapshot = run.snapshotJson as ChatRunSnapshot;
  const thread =
    snapshot.thread ??
    (await findThreadRecord({
      threadId: run.threadId,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    }));
  const userMessage =
    snapshot.userMessage ??
    (run.userMessageId
      ? await findMessageRecord({
          teamId: run.teamId,
          workspaceId: run.workspaceId,
          messageId: run.userMessageId,
        })
      : null);
  const assistantMessage =
    snapshot.assistantMessage ??
    (run.assistantMessageId
      ? await findMessageRecord({
          teamId: run.teamId,
          workspaceId: run.workspaceId,
          messageId: run.assistantMessageId,
        })
      : null);

  if (!thread || !userMessage || !assistantMessage) {
    throw new ContentError(
      409,
      "CHAT_RUN_RESULT_NOT_READY",
      "Chat run result is not ready",
    );
  }

  return {
    thread: thread as ThreadRecord,
    userMessage: userMessage as MessageRecord,
    assistantMessage: assistantMessage as MessageRecord,
    billing: snapshot.billing ?? buildEmptyBilling(run.teamId),
    retrieval: normalizeRetrievalSnapshot(snapshot.retrieval) ?? {
      embeddingProfileId: null,
      vectorStrategy: null,
      annIndexUsed: null,
      citations: [],
      availableCitations: [],
    },
  };
}

async function resolveOwnedRun(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  idempotencyKey: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const run = await findChatThreadRunByIdempotencyKey({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    idempotencyKey: input.idempotencyKey,
  });
  if (!run || run.threadId !== input.threadId || run.userId !== input.userId) {
    throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
  }
  return run;
}

async function findOwnedRun(input: {
  workspaceId: string;
  threadId: string;
  userId: string;
  idempotencyKey: string;
}) {
  const workspace = await requireContentWorkspace(input);
  const run = await findChatThreadRunByIdempotencyKey({
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
    idempotencyKey: input.idempotencyKey,
  });
  if (!run || run.threadId !== input.threadId || run.userId !== input.userId) {
    return null;
  }
  return run;
}

async function waitForRunResult(input: {
  run: ChatThreadRunRecord;
  timeoutMs: number;
  requireTerminal: boolean;
  throwTerminalErrors?: boolean;
  failStaleRun?: (run: ChatThreadRunRecord) => Promise<ChatThreadRunRecord>;
  findRunById?: typeof findChatThreadRunById;
}) {
  const startedAt = Date.now();
  let run = input.run;
  let lastReadinessError: ContentError | null = null;

  while (true) {
    if (!isTerminalRunStatus(run.status)) {
      run = await (input.failStaleRun ?? failRunIfStale)(run);
    }

    if (input.throwTerminalErrors) {
      const terminalError = toTerminalRunError(run);
      if (terminalError) {
        throw terminalError;
      }
    }

    try {
      if (!input.requireTerminal || isTerminalRunStatus(run.status)) {
        return await getRunResult(run);
      }
    } catch (error) {
      if (error instanceof ContentError) {
        lastReadinessError = error;
      } else {
        throw error;
      }
    }

    if (Date.now() - startedAt >= input.timeoutMs) {
      throw (
        lastReadinessError ??
        new ContentError(
          408,
          "CHAT_RUN_RESULT_TIMEOUT",
          "Timed out waiting for chat run result",
        )
      );
    }

    await wait(RESULT_POLL_MS);
    run =
      (await (input.findRunById ?? findChatThreadRunById)({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ?? run;
  }
}

async function resolveAttachRunState(input: {
  run: ChatThreadRunRecord;
  offset: number;
  sawErrorEvent: boolean;
  findRunById?: typeof findChatThreadRunById;
  failStaleRun?: (run: ChatThreadRunRecord) => Promise<ChatThreadRunRecord>;
  getEvents?: (
    streamKey: string,
    offset: number,
  ) => Promise<{ events: ChatRunStreamEvent[]; nextOffset: number }>;
}) {
  let run =
    (await (input.findRunById ?? findChatThreadRunById)({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
    })) ?? input.run;
  run = await (input.failStaleRun ?? failRunIfStale)(run);
  if (!isTerminalRunStatus(run.status)) {
    return {
      run,
      sawErrorEvent: input.sawErrorEvent,
      terminalEvents: null,
    };
  }

  const remaining = await (input.getEvents ??
    chatRunStreamManager.getEvents.bind(chatRunStreamManager))(
    run.streamKey,
    input.offset,
  );
  let sawErrorEvent = input.sawErrorEvent;
  const terminalEvents: string[] = [];
  for (const event of remaining.events) {
    if (event.kind === "sse" && event.payload) {
      terminalEvents.push(event.payload);
      const payload = parseSsePayload(event.payload);
      if (payload?.type === "error") {
        sawErrorEvent = true;
      }
      if (payload?.type === "finish") {
        return {
          run,
          sawErrorEvent,
          terminalEvents,
        };
      }
    }
  }
  terminalEvents.push(
    ...synthesizeTerminalRunEvents({
      run,
      sawErrorEvent,
    }),
  );
  return {
    run,
    sawErrorEvent,
    terminalEvents,
  };
}

export class DurableChatRunService {
  async findRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    return findOwnedRun(input);
  }

  async findActiveRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }) {
    const workspace = await requireContentWorkspace(input);
    const run = await findActiveChatThreadRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
    });
    if (!run || run.userId !== input.userId) {
      return null;
    }
    return failRunIfStale(run);
  }

  async getOrCreateRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
    mode: ChatThreadRunMode;
    request: StreamThreadEventInput | RefreshThreadInput | EditThreadInput;
  }) {
    const workspace = await requireContentWorkspace(input);
    const existing = await findChatThreadRunByIdempotencyKey({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      if (existing.threadId !== input.threadId || existing.userId !== input.userId) {
        throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
      }
      return { run: existing, created: false };
    }

    const active = await findActiveChatThreadRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
    });
    if (active) {
      if (isStaleActiveRun(active)) {
        if (active.status === "queued" && !active.jobId) {
          await failRunBeforeMessages(active, {
            code: "CHAT_RUN_START_FAILED",
            message: "Previous chat run failed before it started.",
          });
        } else {
          await failStaleActiveRun(active);
        }
      } else {
        throw new ContentError(
          409,
          "CHAT_RUN_ALREADY_ACTIVE",
          "A chat run is already active for this thread",
        );
      }
    }

    const remainingActive = await findActiveChatThreadRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
    });
    if (remainingActive) {
      throw new ContentError(
        409,
        "CHAT_RUN_ALREADY_ACTIVE",
        "A chat run is already active for this thread",
      );
    }

    const requestJson = {
      ...input.request,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
    } as DurableRunRequestSnapshot;
    let run = await createChatThreadRun({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      mode: input.mode,
      requestJson,
    }).catch(async (error: unknown) => {
      if (isUniqueConstraintError(error, ACTIVE_RUN_CONSTRAINT)) {
        throw new ContentError(
          409,
          "CHAT_RUN_ALREADY_ACTIVE",
          "A chat run is already active for this thread",
        );
      }
      throw error;
    });
    if (!run) {
      const existingRun = await findChatThreadRunByIdempotencyKey({
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        idempotencyKey: input.idempotencyKey,
      });
      if (
        !existingRun ||
        existingRun.threadId !== input.threadId ||
        existingRun.userId !== input.userId
      ) {
        throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
      }
      return { run: existingRun, created: false };
    }
    let job: Awaited<ReturnType<typeof enqueueThreadChatRunJob>>;
    try {
      job = await enqueueThreadChatRunJob({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        userId: run.userId,
      });
    } catch (error) {
      await failRunBeforeMessages(run, {
        code: "CHAT_RUN_START_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Failed to start chat run.",
      });
      throw error;
    }
    const queuedRun = await markChatThreadRunQueued({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
      jobId: String(job.id),
    });

    return { run: queuedRun ?? run, created: true };
  }

  async stopRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    const run = await resolveOwnedRun(input);
    if (!isTerminalRunStatus(run.status)) {
      const updated =
        (await requestChatThreadRunCancel({
          runId: run.id,
          teamId: run.teamId,
          workspaceId: run.workspaceId,
        })) ?? run;
      await chatRunStreamManager.appendStop(run.streamKey);
      return updated;
    }
    return run;
  }

  async stopRunAndReturn(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKeyWithStopSuffix: string;
  }) {
    const idempotencyKey = input.idempotencyKeyWithStopSuffix.slice(
      0,
      -SOURCEWEFT_WEB_RUN_STOP_SUFFIX.length,
    );
    const stopped = await this.stopRun({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: input.userId,
      idempotencyKey,
    });
    if (stopped.status === "cancelled" && !stopped.userMessageId) {
      return {
        threadRun: {
          id: stopped.id,
          idempotencyKey: stopped.idempotencyKey,
          status: stopped.status,
          mode: stopped.mode,
        },
        billing: buildEmptyBilling(stopped.teamId),
        retrieval: {
          embeddingProfileId: null,
          vectorStrategy: null,
          annIndexUsed: null,
          citations: [],
          availableCitations: [],
        },
      };
    }
    return waitForRunResult({
      run: stopped,
      timeoutMs: STOP_RESULT_WAIT_TIMEOUT_MS,
      requireTerminal: true,
      throwTerminalErrors: false,
    }).catch((error) => {
      if (error instanceof ContentError) {
        return {
          threadRun: {
            id: stopped.id,
            idempotencyKey: stopped.idempotencyKey,
            status: stopped.status,
            mode: stopped.mode,
          },
          billing: buildEmptyBilling(stopped.teamId),
          retrieval: {
            embeddingProfileId: null,
            vectorStrategy: null,
            annIndexUsed: null,
            citations: [],
            availableCitations: [],
          },
        };
      }
      throw error;
    });
  }

  async getRunResult(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    const run = await resolveOwnedRun(input);
    return waitForRunResult({
      run,
      timeoutMs: COMPLETE_RESULT_WAIT_TIMEOUT_MS,
      requireTerminal: true,
      throwTerminalErrors: true,
    });
  }

  async *attachRunEvents(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }): AsyncGenerator<string> {
    let run = await resolveOwnedRun(input);
    let offset = 0;
    let lastHeartbeatAt = Date.now();
    let sawErrorEvent = false;
    while (true) {
      const result = await chatRunStreamManager.getEvents(
        run.streamKey,
        offset,
      );
      offset = result.nextOffset;

      for (const event of result.events) {
        if (event.kind === "sse" && event.payload) {
          yield event.payload;
          const payload = parseSsePayload(event.payload);
          if (payload?.type === "error") {
            sawErrorEvent = true;
          }
          if (payload?.type === "finish") {
            return;
          }
        }
      }

      if (result.events.length > 0) {
        lastHeartbeatAt = Date.now();
      }

      const attachState = await resolveAttachRunState({
        run,
        offset,
        sawErrorEvent,
      });
      run = attachState.run;
      sawErrorEvent = attachState.sawErrorEvent;
      if (attachState.terminalEvents) {
        for (const event of attachState.terminalEvents) {
          yield event;
        }
        return;
      }

      if (Date.now() - lastHeartbeatAt >= ATTACH_HEARTBEAT_MS) {
        lastHeartbeatAt = Date.now();
        yield ": heartbeat\n\n";
      }

      await wait(ATTACH_POLL_MS);
    }
  }

  async appendRunEvent(input: {
    run: ChatThreadRunRecord;
    payload: string;
    snapshot?: ChatRunSnapshot;
  }) {
    const offset = await chatRunStreamManager.appendEvent(
      input.run.streamKey,
      input.payload,
    );
    await updateChatThreadRunProgress({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      eventOffset: offset,
      snapshotJson: input.snapshot,
    });
  }

  async shouldCancel(run: ChatThreadRunRecord) {
    const current = await findChatThreadRunById({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    });
    return current?.status === "cancel_requested";
  }

  async heartbeat(run: ChatThreadRunRecord) {
    return touchChatThreadRunHeartbeat({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    });
  }

  async processRunJob(payload: ThreadChatRunJobPayload) {
    const run = await findChatThreadRunById({
      runId: payload.runId,
      teamId: payload.teamId,
      workspaceId: payload.workspaceId,
    });
    if (!run) {
      throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
    }
    if (!isActiveChatRunStatus(run.status)) {
      return {
        status: toTerminalJobStatus(run.status),
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
      };
    }

    if (run.status === "cancel_requested") {
      const cancelledRun = (await cancelRunBeforeMessages(run)) ?? run;
      return {
        status: "cancelled" as const,
        runId: cancelledRun.id,
        assistantMessageId: cancelledRun.assistantMessageId,
        errorCode: CLIENT_CANCELLED_CODE,
        errorMessage: CLIENT_CANCELLED_MESSAGE,
      };
    }
    if (run.status === "running") {
      return run;
    }

    const running = await markChatThreadRunRunning({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    });
    if (!running) {
      const latest =
        (await findChatThreadRunById({
          runId: run.id,
          teamId: run.teamId,
          workspaceId: run.workspaceId,
        })) ?? run;
      if (!isActiveChatRunStatus(latest.status)) {
        return {
          status: toTerminalJobStatus(latest.status),
          runId: latest.id,
          assistantMessageId: latest.assistantMessageId,
          ...(latest.errorCode ? { errorCode: latest.errorCode } : {}),
          ...(latest.errorMessage ? { errorMessage: latest.errorMessage } : {}),
        };
      }
      if (latest.status !== "cancel_requested") {
        return latest;
      }
      const cancelledRun = (await cancelRunBeforeMessages(latest)) ?? latest;
      return {
        status: "cancelled" as const,
        runId: cancelledRun.id,
        assistantMessageId: cancelledRun.assistantMessageId,
        errorCode: CLIENT_CANCELLED_CODE,
        errorMessage: CLIENT_CANCELLED_MESSAGE,
      };
    }
    return running;
  }

  async finishRun(input: {
    run: ChatThreadRunRecord;
    status: "completed" | "failed" | "cancelled";
    assistantMessageId?: string | null;
    snapshot?: ChatRunSnapshot;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) {
    return finishChatThreadRun({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      status: input.status,
      assistantMessageId: input.assistantMessageId,
      snapshotJson: input.snapshot,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
  }
}

export const durableChatRunService = new DurableChatRunService();

export const testExports = {
  failRunIfStale,
  resolveAttachRunState,
  waitForRunResult,
};
