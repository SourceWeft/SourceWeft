import { ContentError } from "../../content/errors";
import { requireContentWorkspace } from "../../workspace/guards";
import { canViewThread } from "../../workspace/content-visibility";
import { findMessageRecord } from "../message-repository";
import { findThreadRecord } from "../thread/repository";
import type { MessageRecord, ThreadRecord } from "../../content/types";
import {
  findChatThreadRunById,
  findChatThreadRunByIdempotencyKey,
} from "./repository";
import {
  chatRunStreamManager,
  type ChatRunStreamEvent,
} from "./stream-manager";
import type { ChatRunSnapshot, ChatThreadRunRecord } from "./types";
import { normalizeRetrievalSnapshot } from "./snapshot";
import {
  isTerminalRunStatus,
  parseSsePayload,
  synthesizeTerminalRunEvents,
  toTerminalRunError,
} from "./run-state";
import { failRunIfStale } from "./run-recovery";
import { RESULT_POLL_MS } from "./run-constants";

export function wait(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function buildEmptyBilling(teamId: string) {
  return {
    teamId,
    consumedCredits: 0,
    availableCredits: 0,
    consumedThisCycle: 0,
    idempotencyReplayed: false,
  };
}

export function buildStoppedRunFallback(run: ChatThreadRunRecord) {
  return {
    threadRun: {
      id: run.id,
      idempotencyKey: run.idempotencyKey,
      status: run.status,
      mode: run.mode,
    },
    billing: buildEmptyBilling(run.teamId),
    retrieval: {
      embeddingProfileId: null,
      vectorStrategy: null,
      annIndexUsed: null,
      citations: [],
      availableCitations: [],
    },
  };
}

export async function getRunResult(run: ChatThreadRunRecord) {
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

export async function resolveOwnedRun(input: {
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

/**
 * May `userId` follow (read-only) a run that lives on `threadId`? The run's own
 * initiator always may; any other workspace member may only when the thread is
 * visible to them — i.e. not another member's private thread. This mirrors the
 * content visibility model (`canViewThread`) and is the authorization used for
 * multi-user attach/discovery, as opposed to the owner-only gate that guards
 * mutating operations (stop) and the synchronous result read.
 */
export async function isRunThreadViewable(
  input: {
    teamId: string;
    workspaceId: string;
    threadId: string;
    userId: string;
  },
  run: { userId: string },
): Promise<boolean> {
  if (run.userId === input.userId) {
    return true;
  }
  const thread = await findThreadRecord({
    threadId: input.threadId,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
  });
  return Boolean(thread && canViewThread(input.userId, thread));
}

/**
 * Thread-scoped counterpart to `resolveOwnedRun`: resolves a run by idempotency
 * key and authorizes the caller by thread visibility rather than run ownership,
 * so a workspace member can attach to (follow) another member's in-flight run
 * on a thread they can see. Used only for read/follow paths.
 */
export async function resolveViewableRun(input: {
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
  if (!run || run.threadId !== input.threadId) {
    throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
  }
  const viewable = await isRunThreadViewable(
    {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
      userId: input.userId,
    },
    run,
  );
  if (!viewable) {
    throw new ContentError(404, "CHAT_RUN_NOT_FOUND", "Chat run not found");
  }
  return run;
}

/**
 * Non-throwing counterpart to `resolveViewableRun` (returns null instead of a
 * 404). Lets the stream route detect an existing run to attach to when the
 * caller is a follower rather than the run's initiator.
 */
export async function findViewableRun(input: {
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
  if (!run || run.threadId !== input.threadId) {
    return null;
  }
  const viewable = await isRunThreadViewable(
    {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
      userId: input.userId,
    },
    run,
  );
  return viewable ? run : null;
}

export async function waitForRunResult(input: {
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

export async function resolveAttachRunState(input: {
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

  const remaining = await (
    input.getEvents ?? chatRunStreamManager.getEvents.bind(chatRunStreamManager)
  )(run.streamKey, input.offset);
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
