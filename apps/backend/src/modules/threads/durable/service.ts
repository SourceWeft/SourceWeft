import { ContentError } from "../../content/errors";
import { sanitizeClientErrorMessage } from "../../content/model-gateway-error";
import type { ThreadRunFailureSummary } from "@sourceweft/contracts/threads";
import { requireContentWorkspace } from "../../workspace/guards";
import {
  enqueueThreadChatRunJob,
  type ThreadChatRunJobPayload,
  type ThreadChatRunJobResult,
} from "../../content/queue";
import type {
  EditThreadInput,
  RefreshThreadInput,
  ResumeThreadInput,
} from "../stream/types";
import type { StreamThreadEventInput } from "../turn/types";
import {
  createChatThreadRun,
  findActiveChatThreadRun,
  findLatestChatThreadRunSummary,
  findChatThreadRunById,
  findChatThreadRunByIdempotencyKey,
  listExpiredApprovalWaitingRuns,
  finishChatThreadRun,
  isActiveChatRunStatus,
  markChatThreadRunQueued,
  markChatThreadRunRunning,
  requestChatThreadRunCancel,
  touchChatThreadRunHeartbeat,
  updateChatThreadRunProgress,
} from "./repository";
import { chatRunStreamManager } from "./stream-manager";
import { SOURCEWEFT_WEB_RUN_STOP_SUFFIX } from "./constants";
import type {
  ChatRunSnapshot,
  ChatThreadRunMode,
  ChatThreadRunRecord,
  DurableRunRequestSnapshot,
} from "./types";
import { logger } from "../../../shared/logger";
import {
  ACTIVE_RUN_CONSTRAINT,
  ATTACH_HEARTBEAT_MS,
  ATTACH_POLL_MS,
  CLIENT_CANCELLED_CODE,
  CLIENT_CANCELLED_MESSAGE,
  COMPLETE_RESULT_WAIT_TIMEOUT_MS,
  EXPIRED_APPROVAL_SWEEP_LIMIT,
  STOP_RESULT_WAIT_TIMEOUT_MS,
} from "./run-constants";
import {
  isStaleActiveRun,
  isTerminalRunStatus,
  isUniqueConstraintError,
  parseSsePayload,
  shouldCompleteApprovalRunWithoutPendingConfirmations,
  toTerminalJobStatus,
  toRunStopError,
} from "./run-state";
import {
  buildStoppedRunFallback,
  findViewableRun,
  getRunResult,
  isRunThreadViewable,
  resolveAttachRunState,
  resolveOwnedRun,
  resolveViewableRun,
  wait,
  waitForRunResult,
} from "./run-results";
import {
  cancelProposedConfirmationActions,
  cancelRunBeforeMessages,
  completeApprovalRunIfNoPendingConfirmations,
  expireApprovalWaitingRun,
  failRunBeforeMessages,
  failRunIfStale,
  failStaleActiveRunWithDependencies,
  finishRunIfSnapshotIsTerminal,
  finishRunIfSnapshotIsTerminalWithDependencies,
  forceCancelStoppedRun,
  releaseSandboxLeaseForTerminalRun,
} from "./run-recovery";
import {
  markRunWaitingForApproval,
  recordConfirmationResponse,
  validateConfirmationResponse,
} from "./approval";
import {
  buildAssistantMessageConfirmationMetadata,
  buildAssistantMessageSnapshotMetadata,
  resolveAssistantMessageProjection,
} from "./assistant-message-metadata";
import {
  finalizeTerminalSnapshotTrace,
  resolveTerminalStatusFromFinishedSnapshot,
} from "./snapshot";

export { expireApprovalWaitingRun } from "./run-recovery";
export { normalizeRetrievalSnapshot } from "./snapshot";
export {
  getRunApprovalPauseState,
  isApprovalWaitingRunExpired,
  isStaleActiveRun,
  synthesizeTerminalRunEvents,
  toTerminalJobStatus,
  toTerminalRunError,
} from "./run-state";

/**
 * A redelivered job found the run already claimed by an earlier delivery.
 * With `attempts: 1` the only way here is BullMQ stall redelivery, and a
 * "stalled" job's original execution can still be alive — stall detection
 * fires on a starved event loop, not just a dead worker. Never re-execute
 * the turn (a second execution runs the whole turn concurrently: duplicate
 * tool calls, artifacts, billing). Fresh heartbeat → the original still owns
 * the run, report a skip; stale heartbeat → run the same stale-run recovery
 * the read path uses and report the terminal state it lands on.
 */
async function resolveRedeliveredActiveRun(
  run: ChatThreadRunRecord,
  dependencies: {
    failStaleRun?: (run: ChatThreadRunRecord) => Promise<ChatThreadRunRecord>;
  } = {},
): Promise<ThreadChatRunJobResult> {
  if (run.status === "waiting_for_approval") {
    return {
      status: "waiting_for_approval",
      runId: run.id,
      assistantMessageId: run.assistantMessageId,
    };
  }
  if (!isStaleActiveRun(run)) {
    return {
      status: "skipped",
      runId: run.id,
      assistantMessageId: run.assistantMessageId,
    };
  }
  const failStaleRun = dependencies.failStaleRun ?? failRunIfStale;
  const recovered = (await failStaleRun(run)) ?? run;
  if (!isTerminalRunStatus(recovered.status)) {
    // Recovery saw the run advance under us (e.g. a heartbeat landed between
    // our reads) — whoever wrote that still owns the run.
    return {
      status: "skipped",
      runId: recovered.id,
      assistantMessageId: recovered.assistantMessageId,
    };
  }
  return {
    status: toTerminalJobStatus(recovered.status),
    runId: recovered.id,
    assistantMessageId: recovered.assistantMessageId,
    ...(recovered.errorCode ? { errorCode: recovered.errorCode } : {}),
    ...(recovered.errorMessage ? { errorMessage: recovered.errorMessage } : {}),
  };
}

export class DurableChatRunService {
  async findLatestMessageLessFailure(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
  }): Promise<ThreadRunFailureSummary | null> {
    const workspace = await requireContentWorkspace(input);
    const scope = {
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      threadId: input.threadId,
      userId: input.userId,
    };
    const run = await findLatestChatThreadRunSummary(scope);
    if (
      !run ||
      run.status !== "failed" ||
      run.assistantMessageId ||
      !(await isRunThreadViewable(scope, run))
    )
      return null;
    return {
      id: run.id,
      idempotencyKey: run.idempotencyKey,
      errorCode: run.errorCode ?? "CHAT_RUN_FAILED",
      errorMessage: sanitizeClientErrorMessage(
        run.errorMessage ?? "Chat run failed",
      ),
    };
  }

  async findRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
  }) {
    return findViewableRun(input);
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
    if (!run) {
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
    if (!viewable) {
      return null;
    }
    const current = await failRunIfStale(run);
    return isActiveChatRunStatus(current.status) ? current : null;
  }

  async getOrCreateRun(input: {
    workspaceId: string;
    threadId: string;
    userId: string;
    idempotencyKey: string;
    mode: ChatThreadRunMode;
    request:
      | StreamThreadEventInput
      | RefreshThreadInput
      | ResumeThreadInput
      | EditThreadInput;
  }) {
    const workspace = await requireContentWorkspace(input);
    const existing = await findChatThreadRunByIdempotencyKey({
      teamId: workspace.organizationId,
      workspaceId: workspace.id,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      if (
        existing.threadId !== input.threadId ||
        existing.userId !== input.userId
      ) {
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
      const currentActive = await failRunIfStale(active);
      if (isActiveChatRunStatus(currentActive.status)) {
        throw new ContentError(
          409,
          "CHAT_RUN_ALREADY_ACTIVE",
          "A chat run is already active for this thread",
        );
      }
      // A stale or completed approval pause has been terminalized; a new run may start.
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
          error instanceof Error ? error.message : "Failed to start chat run.",
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
      // Persist the cancellation fence before waking the worker. Deliverable
      // publication locks this same row, so Stop and publish now have a single
      // database ordering instead of a signal-before-state race.
      const updated = await requestChatThreadRunCancel({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      });
      if (!updated) {
        return resolveOwnedRun(input);
      }
      if (isTerminalRunStatus(updated.status)) {
        return updated;
      }
      await chatRunStreamManager.appendStop(run.streamKey);
      // Wake the worker running the turn now, rather than at its next status
      // poll: this is what lets an in-flight turn abort promptly instead of
      // running to completion after Stop.
      await chatRunStreamManager.publishCancel(run.id);
      if (run.status === "waiting_for_approval") {
        await cancelProposedConfirmationActions(run, {
          code: CLIENT_CANCELLED_CODE,
          message: CLIENT_CANCELLED_MESSAGE,
        });
        return forceCancelStoppedRun(updated);
      }
      return forceCancelStoppedRun(updated);
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
    if (stopped.status === "cancelled") {
      try {
        return await getRunResult(stopped);
      } catch (error) {
        if (error instanceof ContentError) {
          return buildStoppedRunFallback(stopped);
        }
        throw error;
      }
    }
    return waitForRunResult({
      run: stopped,
      timeoutMs: STOP_RESULT_WAIT_TIMEOUT_MS,
      requireTerminal: true,
      throwTerminalErrors: false,
    }).catch((error) => {
      if (error instanceof ContentError) {
        return findChatThreadRunById({
          runId: stopped.id,
          teamId: stopped.teamId,
          workspaceId: stopped.workspaceId,
        }).then(async (latest) => {
          const stoppedRun = isTerminalRunStatus(
            latest?.status ?? stopped.status,
          )
            ? (latest ?? stopped)
            : await forceCancelStoppedRun(latest ?? stopped);
          return buildStoppedRunFallback(stoppedRun);
        });
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
    let run = await resolveViewableRun(input);
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
    const error = await this.getRunStopError(run);
    if (error && error.code !== CLIENT_CANCELLED_CODE) throw error;
    return Boolean(error);
  }

  async getRunStopError(run: ChatThreadRunRecord) {
    const current = await findChatThreadRunById({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    });
    return toRunStopError(current);
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
    if (run.status === "waiting_for_approval") {
      return {
        status: "waiting_for_approval" as const,
        runId: run.id,
        assistantMessageId: run.assistantMessageId,
      };
    }
    if (run.status === "running") {
      return resolveRedeliveredActiveRun(run);
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
        // Lost the queued→running CAS to a concurrent delivery: same fencing
        // as the `running` branch above — only the CAS winner executes.
        return resolveRedeliveredActiveRun(latest);
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
    userMessageId?: string | null;
    assistantMessageId?: string | null;
    snapshot?: ChatRunSnapshot;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) {
    const finished = await finishChatThreadRun({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      status: input.status,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      snapshotJson: input.snapshot,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    });
    if (
      finished &&
      (input.status === "failed" || input.status === "cancelled")
    ) {
      await releaseSandboxLeaseForTerminalRun(
        finished,
        `chat_run_${input.status}`,
      );
    }
    return finished;
  }

  async markWaitingForApproval(input: {
    run: ChatThreadRunRecord;
    assistantMessageId?: string | null;
    snapshot: ChatRunSnapshot;
    confirmationIds?: string[];
    requestedAt?: Date;
    expiresAt?: Date;
  }) {
    return markRunWaitingForApproval(input);
  }

  async validateConfirmationResponse(input: {
    workspaceId: string;
    userId: string;
    confirmationId: string;
    threadRunId?: string;
    assistantMessageId?: string;
  }) {
    return validateConfirmationResponse(input);
  }

  async recordConfirmationResponse(input: {
    run: ChatThreadRunRecord;
    confirmationId: string;
    confirmation: unknown;
  }) {
    return recordConfirmationResponse(input);
  }

  async expireWaitingApprovals(input: { limit?: number } = {}) {
    const runs = await listExpiredApprovalWaitingRuns({
      limit: input.limit ?? EXPIRED_APPROVAL_SWEEP_LIMIT,
    });
    const results = await Promise.allSettled(
      runs.map((run) => expireApprovalWaitingRun(run)),
    );
    const expired = results.filter(
      (result) =>
        result.status === "fulfilled" && result.value.status === "cancelled",
    ).length;
    const failed = results.length - expired;
    if (failed > 0) {
      logger.warn("Failed to expire some waiting approval chat runs", {
        attempted: results.length,
        expired,
        failed,
      });
    }
    return { attempted: runs.length, expired, failed };
  }
}

export const durableChatRunService = new DurableChatRunService();

export const testExports = {
  buildAssistantMessageSnapshotMetadata,
  buildAssistantMessageConfirmationMetadata,
  completeApprovalRunIfNoPendingConfirmations,
  failRunIfStale,
  failStaleActiveRunWithDependencies,
  finalizeTerminalSnapshotTrace,
  finishRunIfSnapshotIsTerminal,
  finishRunIfSnapshotIsTerminalWithDependencies,
  forceCancelStoppedRun,
  resolveAssistantMessageProjection,
  resolveRedeliveredActiveRun,
  resolveTerminalStatusFromFinishedSnapshot,
  resolveAttachRunState,
  shouldCompleteApprovalRunWithoutPendingConfirmations,
  waitForRunResult,
};
