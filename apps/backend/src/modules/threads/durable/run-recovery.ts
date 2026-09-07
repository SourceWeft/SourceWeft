import { committedArtifactToolResultSchema } from "@sourceweft/contracts/agent-tools";
import { getAgentToolDefinition } from "@sourceweft/agent-tool-registry";
import {
  findActionRunRecordById,
  updateActionRunRecord,
} from "../../connectors/repository";
import { findMcpActionRun, updateMcpActionRun } from "../../mcp/repository";
import { agentSandboxService } from "../agent/sandbox-service/service";
import { logger } from "../../../shared/logger";
import {
  findChatThreadRunById,
  finishChatThreadRun,
  isActiveChatRunStatus,
} from "./repository";
import { chatRunStreamManager } from "./stream-manager";
import type { ChatRunSnapshot, ChatThreadRunRecord } from "./types";
import {
  finalizeTerminalSnapshotTrace,
  getSnapshotRecord,
  resolveTerminalStatusFromFinishedSnapshot,
} from "./snapshot";
import { toObjectRecord } from "../../../shared/records";
import {
  getRunApprovalPauseState,
  isApprovalWaitingRunExpired,
  isStaleActiveRun,
  isTerminalRunStatus,
  shouldCompleteApprovalRunWithoutPendingConfirmations,
  synthesizeTerminalRunEvents,
} from "./run-state";
import {
  updateAssistantMessageThreadRunMetadata,
  withAssistantThreadRunMetadata,
} from "./assistant-message-metadata";
import {
  CLIENT_CANCELLED_CODE,
  CLIENT_CANCELLED_MESSAGE,
  STALE_CHAT_RUN_CODE,
  TOOL_APPROVAL_EXPIRED_CODE,
  TOOL_APPROVAL_EXPIRED_MESSAGE,
} from "./run-constants";

export async function releaseSandboxLeaseForTerminalRun(
  run: ChatThreadRunRecord,
  reason: string,
) {
  await agentSandboxService
    .releaseThreadSandboxLease({
      context: {
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        userId: run.userId,
        messageId: run.assistantMessageId ?? run.userMessageId ?? run.id,
        runId: run.id,
      },
      reason,
    })
    .catch((error: unknown) => {
      logger.warn("Failed to release sandbox lease for terminal chat run", {
        runId: run.id,
        threadId: run.threadId,
        workspaceId: run.workspaceId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export async function failRunBeforeMessages(
  run: ChatThreadRunRecord,
  error: { code: string; message: string },
) {
  const finished = await finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "failed",
    snapshotMode: "terminal_patch",
    assistantMessageId: null,
    snapshotJson: {
      ...(run.snapshotJson as ChatRunSnapshot),
      errorCode: error.code,
      errorMessage: error.message,
    },
    errorCode: error.code,
    errorMessage: error.message,
  });
  if (!finished) return null;
  try {
    for (const event of synthesizeTerminalRunEvents({
      run: finished,
      sawErrorEvent: false,
    }))
      await chatRunStreamManager.appendEvent(finished.streamKey, event);
  } finally {
    await releaseSandboxLeaseForTerminalRun(
      finished,
      "chat_run_failed_before_messages",
    );
  }
  return finished;
}

export async function cancelRunBeforeMessages(run: ChatThreadRunRecord) {
  const finished = await finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "cancelled",
    snapshotMode: "terminal_patch",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: {
      ...(run.snapshotJson as ChatRunSnapshot),
      errorCode: CLIENT_CANCELLED_CODE,
      errorMessage: CLIENT_CANCELLED_MESSAGE,
    },
    errorCode: CLIENT_CANCELLED_CODE,
    errorMessage: CLIENT_CANCELLED_MESSAGE,
  });
  if (!finished) return null;
  try {
    for (const event of synthesizeTerminalRunEvents({
      run: finished,
      sawErrorEvent: false,
    }))
      await chatRunStreamManager.appendEvent(finished.streamKey, event);
  } finally {
    await releaseSandboxLeaseForTerminalRun(
      finished,
      "chat_run_cancelled_before_messages",
    );
  }
  return finished;
}

export async function forceCancelStoppedRun(
  run: ChatThreadRunRecord,
  dependencies: {
    appendEvent?: typeof chatRunStreamManager.appendEvent;
    findRunById?: typeof findChatThreadRunById;
    finishRun?: typeof finishChatThreadRun;
    updateAssistantMetadata?: typeof updateAssistantMessageThreadRunMetadata;
  } = {},
) {
  if (isTerminalRunStatus(run.status)) {
    return run;
  }

  const appendEvent =
    dependencies.appendEvent ??
    chatRunStreamManager.appendEvent.bind(chatRunStreamManager);
  const finishRun = dependencies.finishRun ?? finishChatThreadRun;
  const findRunById = dependencies.findRunById ?? findChatThreadRunById;
  const updateAssistantMetadata =
    dependencies.updateAssistantMetadata ??
    updateAssistantMessageThreadRunMetadata;
  const latestBeforeCancel = await findRunById({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
  });
  if (isTerminalRunStatus(latestBeforeCancel?.status ?? run.status)) {
    return latestBeforeCancel ?? run;
  }
  const activeRun = latestBeforeCancel ?? run;
  const cancelledRun = {
    ...activeRun,
    status: "cancelled" as const,
    errorCode: CLIENT_CANCELLED_CODE,
    errorMessage: CLIENT_CANCELLED_MESSAGE,
  };
  const snapshot = withAssistantThreadRunMetadata(
    finalizeTerminalSnapshotTrace({
      ...getSnapshotRecord(activeRun),
      errorCode: CLIENT_CANCELLED_CODE,
      errorMessage: CLIENT_CANCELLED_MESSAGE,
    }),
    cancelledRun,
  );

  const finished = await finishRun({
    runId: activeRun.id,
    teamId: activeRun.teamId,
    workspaceId: activeRun.workspaceId,
    status: "cancelled",
    snapshotMode: "terminal_patch",
    assistantMessageId: activeRun.assistantMessageId,
    snapshotJson: snapshot,
    errorCode: CLIENT_CANCELLED_CODE,
    errorMessage: CLIENT_CANCELLED_MESSAGE,
  });
  if (!finished)
    return (
      (await findRunById({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ?? run
    );
  try {
    for (const event of synthesizeTerminalRunEvents({
      run: finished,
      sawErrorEvent: false,
    }))
      await appendEvent(finished.streamKey, event);
  } finally {
    await releaseSandboxLeaseForTerminalRun(
      finished,
      "chat_run_force_cancelled",
    );
  }
  const latestAfterCancel =
    (await findRunById({
      runId: activeRun.id,
      teamId: activeRun.teamId,
      workspaceId: activeRun.workspaceId,
    })) ?? finished;
  if (latestAfterCancel.status === "cancelled") {
    await updateAssistantMetadata({
      run: latestAfterCancel,
      snapshot,
      metadata: {
        isCancelled: true,
        error: CLIENT_CANCELLED_MESSAGE,
        errorCode: CLIENT_CANCELLED_CODE,
      },
    });
  }
  return latestAfterCancel;
}

async function failStaleActiveRun(run: ChatThreadRunRecord) {
  return failStaleActiveRunWithDependencies(run);
}

export async function failStaleActiveRunWithDependencies(
  run: ChatThreadRunRecord,
  dependencies: {
    appendEvent?: typeof chatRunStreamManager.appendEvent;
    finishRun?: typeof finishChatThreadRun;
    updateAssistantMetadata?: typeof updateAssistantMessageThreadRunMetadata;
    findRunById?: typeof findChatThreadRunById;
    releaseLease?: typeof releaseSandboxLeaseForTerminalRun;
  } = {},
) {
  const appendEvent =
    dependencies.appendEvent ??
    chatRunStreamManager.appendEvent.bind(chatRunStreamManager);
  const finishRun = dependencies.finishRun ?? finishChatThreadRun;
  const updateAssistantMetadata =
    dependencies.updateAssistantMetadata ??
    updateAssistantMessageThreadRunMetadata;
  const snapshot = getSnapshotRecord(run);
  const orphaned = run.status === "queued" && !run.jobId;
  const errorCode = orphaned ? "CHAT_RUN_START_FAILED" : STALE_CHAT_RUN_CODE;
  const errorMessage = orphaned
    ? "Previous chat run failed before it started."
    : "Chat run stopped because its worker heartbeat expired";
  const terminalRun = {
    ...run,
    status: "failed" as const,
    errorCode,
    errorMessage,
  };
  const terminalSnapshot = withAssistantThreadRunMetadata(
    {
      ...snapshot,
      errorCode,
      errorMessage,
    },
    terminalRun,
  );
  const failedRun = await finishRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "failed",
    snapshotMode: "terminal_patch",
    protectedOperationTerminalReason: "RUN_OWNER_DIED",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: terminalSnapshot,
    errorCode,
    errorMessage,
    staleAt: new Date(),
  });
  if (!failedRun) {
    return (
      (await (dependencies.findRunById ?? findChatThreadRunById)({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ?? run
    );
  }
  try {
    if (failedRun.assistantMessageId)
      await updateAssistantMetadata({
        run: failedRun,
        snapshot: getSnapshotRecord(failedRun),
      });
    for (const event of synthesizeTerminalRunEvents({
      run: failedRun,
      sawErrorEvent: false,
    }))
      await appendEvent(failedRun.streamKey, event);
  } finally {
    await (dependencies.releaseLease ?? releaseSandboxLeaseForTerminalRun)(
      failedRun,
      "chat_run_stale_failed",
    );
  }
  return failedRun;
}

export async function cancelProposedConfirmationActions(
  run: ChatThreadRunRecord,
  error: { code: string; message: string },
) {
  const confirmationIds = getRunApprovalPauseState(run).confirmationIds;
  if (confirmationIds.length === 0) {
    return;
  }

  const results = await Promise.allSettled(
    confirmationIds.map(async (confirmationId) => {
      const connectorAction = await findActionRunRecordById({
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        actionRunId: confirmationId,
      });
      if (connectorAction) {
        if (connectorAction.status === "proposed") {
          await updateActionRunRecord({
            teamId: run.teamId,
            workspaceId: run.workspaceId,
            connectorId: connectorAction.connectorId,
            actionRunId: confirmationId,
            status: "canceled",
            errorCode: error.code,
            errorMessage: error.message,
          });
        }
        return;
      }

      const mcpAction = await findMcpActionRun({
        teamId: run.teamId,
        workspaceId: run.workspaceId,
        actionRunId: confirmationId,
      });
      if (mcpAction?.status === "proposed") {
        await updateMcpActionRun({
          teamId: run.teamId,
          workspaceId: run.workspaceId,
          actionRunId: confirmationId,
          status: "canceled",
          errorCode: error.code,
          errorMessage: error.message,
        });
      }
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    logger.warn("Failed to cancel proposed confirmation actions", {
      runId: run.id,
      confirmationCount: confirmationIds.length,
      failureCount: failures.length,
    });
  }
}

export async function expireApprovalWaitingRun(run: ChatThreadRunRecord) {
  const expiredRun = {
    ...run,
    status: "cancelled" as const,
    errorCode: TOOL_APPROVAL_EXPIRED_CODE,
    errorMessage: TOOL_APPROVAL_EXPIRED_MESSAGE,
  };
  const snapshot = withAssistantThreadRunMetadata(
    finalizeTerminalSnapshotTrace({
      ...getSnapshotRecord(run),
      errorCode: TOOL_APPROVAL_EXPIRED_CODE,
      errorMessage: TOOL_APPROVAL_EXPIRED_MESSAGE,
    }),
    expiredRun,
  );
  const finished = await finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "cancelled",
    snapshotMode: "terminal_patch",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: snapshot,
    errorCode: TOOL_APPROVAL_EXPIRED_CODE,
    errorMessage: TOOL_APPROVAL_EXPIRED_MESSAGE,
  });
  if (!finished)
    return (
      (await findChatThreadRunById({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ?? run
    );
  try {
    await cancelProposedConfirmationActions(finished, {
      code: TOOL_APPROVAL_EXPIRED_CODE,
      message: TOOL_APPROVAL_EXPIRED_MESSAGE,
    });
    for (const event of synthesizeTerminalRunEvents({
      run: finished,
      sawErrorEvent: false,
    }))
      await chatRunStreamManager.appendEvent(finished.streamKey, event);
  } finally {
    await releaseSandboxLeaseForTerminalRun(finished, "tool_approval_expired");
  }
  await updateAssistantMessageThreadRunMetadata({
    run: finished,
    snapshot,
    metadata: {
      isCancelled: true,
      error: TOOL_APPROVAL_EXPIRED_MESSAGE,
      errorCode: TOOL_APPROVAL_EXPIRED_CODE,
    },
  });
  return (
    (await findChatThreadRunById({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    })) ?? finished
  );
}

export async function expireRunIfApprovalExpired(run: ChatThreadRunRecord) {
  if (!isApprovalWaitingRunExpired(run)) {
    return run;
  }
  return expireApprovalWaitingRun(run);
}

export async function completeApprovalRunIfNoPendingConfirmations(
  run: ChatThreadRunRecord,
) {
  if (!shouldCompleteApprovalRunWithoutPendingConfirmations(run)) {
    return run;
  }
  const snapshot = getSnapshotRecord(run);
  const completedRun = {
    ...run,
    status: "completed" as const,
  };
  const finished = await finishChatThreadRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: "completed",
    snapshotMode: "terminal_patch",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: withAssistantThreadRunMetadata(snapshot, completedRun),
  });
  if (!finished)
    return (
      (await findChatThreadRunById({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ?? run
    );
  await updateAssistantMessageThreadRunMetadata({
    run: finished,
  });
  return (
    (await findChatThreadRunById({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    })) ?? finished
  );
}

export async function finishRunIfSnapshotIsTerminal(run: ChatThreadRunRecord) {
  return finishRunIfSnapshotIsTerminalWithDependencies(run);
}

export async function finishRunIfSnapshotIsTerminalWithDependencies(
  run: ChatThreadRunRecord,
  dependencies: {
    findRunById?: typeof findChatThreadRunById;
    finishRun?: typeof finishChatThreadRun;
    updateAssistantMetadata?: typeof updateAssistantMessageThreadRunMetadata;
  } = {},
) {
  if (
    !isActiveChatRunStatus(run.status) ||
    run.status === "waiting_for_approval"
  ) {
    return run;
  }
  const snapshot = getSnapshotRecord(run);
  const terminalStatus =
    resolveTerminalStatusFromFinishedSnapshot(snapshot) ??
    (hasCommittedArtifactPublication(snapshot, run.id) ? "completed" : null);
  if (!terminalStatus) {
    return run;
  }

  const terminalRun = {
    ...run,
    status: terminalStatus,
    errorCode:
      terminalStatus === "failed"
        ? (run.errorCode ?? "CHAT_RUN_FAILED")
        : terminalStatus === "cancelled"
          ? (run.errorCode ?? CLIENT_CANCELLED_CODE)
          : run.errorCode,
    errorMessage:
      terminalStatus === "cancelled"
        ? (run.errorMessage ?? CLIENT_CANCELLED_MESSAGE)
        : run.errorMessage,
  };
  const finishRun = dependencies.finishRun ?? finishChatThreadRun;
  const findRunById = dependencies.findRunById ?? findChatThreadRunById;
  const updateAssistantMetadata =
    dependencies.updateAssistantMetadata ??
    updateAssistantMessageThreadRunMetadata;
  const finished = await finishRun({
    runId: run.id,
    teamId: run.teamId,
    workspaceId: run.workspaceId,
    status: terminalStatus,
    snapshotMode: "terminal_patch",
    assistantMessageId: run.assistantMessageId,
    snapshotJson: withAssistantThreadRunMetadata(
      finalizeTerminalSnapshotTrace(snapshot),
      terminalRun,
    ),
    errorCode: terminalRun.errorCode,
    errorMessage: terminalRun.errorMessage,
  });
  if (!finished)
    return (
      (await findRunById({
        runId: run.id,
        teamId: run.teamId,
        workspaceId: run.workspaceId,
      })) ?? run
    );
  if (terminalStatus === "failed" || terminalStatus === "cancelled") {
    await releaseSandboxLeaseForTerminalRun(
      finished,
      `chat_run_snapshot_${terminalStatus}`,
    );
  }
  await updateAssistantMetadata({
    run: finished,
    snapshot: withAssistantThreadRunMetadata(
      finalizeTerminalSnapshotTrace(snapshot),
      terminalRun,
    ),
    metadata:
      terminalStatus === "cancelled"
        ? {
            isCancelled: true,
            error: terminalRun.errorMessage ?? CLIENT_CANCELLED_MESSAGE,
            errorCode: terminalRun.errorCode ?? CLIENT_CANCELLED_CODE,
          }
        : undefined,
  });
  return (
    (await findRunById({
      runId: run.id,
      teamId: run.teamId,
      workspaceId: run.workspaceId,
    })) ?? finished
  );
}

export function hasCommittedArtifactPublication(
  snapshot: ChatRunSnapshot,
  runId: string,
) {
  const blocks = new Map(
    (Array.isArray(snapshot.renderBlocks) ? snapshot.renderBlocks : []).flatMap(
      (value) => {
        const record = toObjectRecord(value);
        return record?.type === "artifact_output" &&
          typeof record.id === "string"
          ? [[record.id, record] as const]
          : [];
      },
    ),
  );
  return (Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : []).some(
    (value) => {
      const call = toObjectRecord(value);
      const parsed = committedArtifactToolResultSchema.safeParse(call?.output);
      if (
        !call ||
        typeof call.id !== "string" ||
        typeof call.tool !== "string" ||
        call.status !== "completed" ||
        call.error ||
        !parsed.success
      ) {
        return false;
      }
      const definition = getAgentToolDefinition(call.tool);
      if (
        definition?.terminalResult?.kind !== "committed_artifact" ||
        definition.terminalResult.artifactType !== parsed.data.artifactType
      ) {
        return false;
      }
      const block = blocks.get(parsed.data.artifactOutputBlockId);
      const callProducer = toObjectRecord(call.producer);
      const blockProducer = toObjectRecord(block?.producer);
      return Boolean(
        block &&
        block.artifactId === parsed.data.artifactId &&
        block.artifactVersionId === parsed.data.artifactVersionId &&
        block.threadRunId === runId &&
        block.sourceToolCallId === call.id &&
        block.placement === "terminal" &&
        blockProducer?.kind === (callProducer?.kind ?? "main") &&
        blockProducer?.subagentType === callProducer?.subagentType,
      );
    },
  );
}

export async function failRunIfStale(run: ChatThreadRunRecord) {
  run = await expireRunIfApprovalExpired(run);
  run = await completeApprovalRunIfNoPendingConfirmations(run);
  run = await finishRunIfSnapshotIsTerminal(run);
  if (!isStaleActiveRun(run)) {
    return run;
  }

  return (await failStaleActiveRun(run)) ?? run;
}
