import { ContentError } from "../../content/errors";
import { requireContentWorkspace } from "../../workspace/guards";
import { config } from "../../../shared/config";
import {
  findChatThreadRunById,
  markChatThreadRunWaitingForApproval,
  recordChatThreadRunConfirmationResponse,
} from "./repository";
import type { ChatRunSnapshot, ChatThreadRunRecord } from "./types";
import { toObjectRecord } from "../../../shared/records";
import { getRunApprovalPauseState } from "./run-state";
import {
  updateAssistantMessageConfirmationMetadata,
  withAssistantThreadRunMetadata,
} from "./assistant-message-metadata";
import { expireRunIfApprovalExpired } from "./run-recovery";
import { TOOL_APPROVAL_EXPIRED_CODE } from "./run-constants";

export async function markRunWaitingForApproval(input: {
  run: ChatThreadRunRecord;
  assistantMessageId?: string | null;
  snapshot: ChatRunSnapshot;
  confirmationIds?: string[];
  requestedAt?: Date;
  expiresAt?: Date;
}) {
  const requestedAt = input.requestedAt ?? new Date();
  const expiresAt =
    input.expiresAt ??
    new Date(requestedAt.getTime() + config.chat.toolApprovalTtlMs);
  const approvalRequestedAt = requestedAt.toISOString();
  const approvalExpiresAt = expiresAt.toISOString();
  const assistantMessageId =
    input.assistantMessageId ?? input.run.assistantMessageId;
  if (!assistantMessageId) {
    throw new ContentError(
      500,
      "CHAT_RUN_ASSISTANT_MESSAGE_MISSING",
      "Tool approval run is missing its assistant message.",
    );
  }
  const waitingRun = {
    ...input.run,
    status: "waiting_for_approval" as const,
    assistantMessageId,
  };
  const snapshot = withAssistantThreadRunMetadata(
    {
      ...input.snapshot,
      approvalRequestedAt,
      approvalExpiresAt,
      pendingConfirmationIds: input.confirmationIds ?? [],
    },
    waitingRun,
  );
  if (snapshot.assistantMessage) {
    snapshot.assistantMessage = {
      ...snapshot.assistantMessage,
      metadata: {
        ...snapshot.assistantMessage.metadata,
        threadRun: {
          ...(toObjectRecord(snapshot.assistantMessage.metadata.threadRun) ??
            {}),
          approvalRequestedAt,
          approvalExpiresAt,
        },
      },
    };
  }
  const updated = await markChatThreadRunWaitingForApproval({
    assistantMessageId: waitingRun.assistantMessageId,
    runId: input.run.id,
    teamId: input.run.teamId,
    workspaceId: input.run.workspaceId,
    snapshotJson: snapshot,
  });
  if (!updated) {
    return null;
  }
  await updateAssistantMessageConfirmationMetadata({
    run: updated,
    snapshot,
  });
  return {
    ...updated,
    snapshotJson: {
      ...updated.snapshotJson,
      approvalRequestedAt,
      approvalExpiresAt,
      pendingConfirmationIds: input.confirmationIds ?? [],
    },
  };
}

export async function validateConfirmationResponse(input: {
  workspaceId: string;
  userId: string;
  confirmationId: string;
  threadRunId?: string;
  assistantMessageId?: string;
}) {
  if (!input.threadRunId) {
    throw new ContentError(
      400,
      "CONFIRMATION_THREAD_RUN_REQUIRED",
      "Confirmation response requires the active chat run id",
    );
  }
  const workspace = await requireContentWorkspace(input);
  const run = await findChatThreadRunById({
    runId: input.threadRunId,
    teamId: workspace.organizationId,
    workspaceId: workspace.id,
  });
  if (!run || run.userId !== input.userId) {
    throw new ContentError(
      409,
      "CHAT_RUN_NOT_ACTIVE",
      "Chat run is not active",
    );
  }
  const current = await expireRunIfApprovalExpired(run);
  if (current.status !== "waiting_for_approval") {
    throw new ContentError(
      409,
      current.errorCode === TOOL_APPROVAL_EXPIRED_CODE
        ? TOOL_APPROVAL_EXPIRED_CODE
        : "CHAT_RUN_NOT_WAITING_FOR_APPROVAL",
      current.errorMessage ?? "Chat run is not waiting for approval",
    );
  }
  if (
    input.assistantMessageId &&
    current.assistantMessageId &&
    input.assistantMessageId !== current.assistantMessageId
  ) {
    throw new ContentError(
      409,
      "CONFIRMATION_ASSISTANT_MESSAGE_MISMATCH",
      "Confirmation does not belong to this assistant message",
    );
  }
  const approval = getRunApprovalPauseState(current);
  if (
    approval.confirmationIds.length > 0 &&
    !approval.confirmationIds.includes(input.confirmationId)
  ) {
    throw new ContentError(
      409,
      "CONFIRMATION_NOT_ACTIVE",
      "Confirmation is no longer active",
    );
  }
  return current;
}

export async function recordConfirmationResponse(input: {
  run: ChatThreadRunRecord;
  confirmationId: string;
  confirmation: unknown;
}) {
  if (input.run.status !== "waiting_for_approval") {
    return input.run;
  }
  return (
    (await recordChatThreadRunConfirmationResponse({
      runId: input.run.id,
      teamId: input.run.teamId,
      workspaceId: input.run.workspaceId,
      confirmationId: input.confirmationId,
      confirmation: input.confirmation,
    })) ?? input.run
  );
}
