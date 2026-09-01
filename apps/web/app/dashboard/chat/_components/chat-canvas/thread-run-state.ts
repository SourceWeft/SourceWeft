import type { ActiveThreadRun } from "../../[threadId]/chat-stream-runner-control";
import type { MessageVersion } from "./types";

export type MessageVersionRunLifecycle =
  "live" | "waiting_for_approval" | "terminal" | "idle";

export function summarizeActiveThreadRun(run?: ActiveThreadRun | null) {
  if (!run) {
    return "";
  }

  return [
    run.id ?? "",
    run.idempotencyKey,
    run.status,
    run.mode ?? "",
    run.userMessageId ?? "",
    run.assistantMessageId ?? "",
    run.approvalRequestedAt ?? "",
    run.approvalExpiresAt ?? "",
  ].join(":");
}

export function summarizeMessageVersionThreadRun(
  run?: MessageVersion["threadRun"],
) {
  if (!run) {
    return "";
  }

  return [
    run.id ?? "",
    run.assistantMessageId ?? "",
    run.idempotencyKey ?? "",
    run.status ?? "",
    run.mode ?? "",
    run.approvalRequestedAt ?? "",
    run.approvalExpiresAt ?? "",
    run.startedAt ?? "",
    run.completedAt ?? "",
    run.durationMs ?? "",
  ].join(":");
}

function isMessageVersionForActiveThreadRun(input: {
  activeThreadRun?: ActiveThreadRun | null;
  version: MessageVersion;
}) {
  const { activeThreadRun, version } = input;
  if (!activeThreadRun) {
    return false;
  }

  if (
    activeThreadRun.assistantMessageId &&
    activeThreadRun.assistantMessageId === version.id
  ) {
    return true;
  }

  const versionRun = version.threadRun;
  if (!versionRun) {
    return false;
  }

  if (
    activeThreadRun.id &&
    versionRun.id &&
    activeThreadRun.id === versionRun.id
  ) {
    return true;
  }

  return (
    Boolean(versionRun.idempotencyKey) &&
    versionRun.idempotencyKey === activeThreadRun.idempotencyKey
  );
}

function hasActiveMessageVersionThreadRunStatus(version: MessageVersion) {
  const status = version.threadRun?.status;
  return (
    status === "queued" ||
    status === "running" ||
    status === "cancel_requested" ||
    status === "waiting_for_approval"
  );
}

function hasTerminalMessageVersionStatus(version: MessageVersion) {
  const status = version.threadRun?.status;
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function hasTerminalMessageVersionFinishReason(version: MessageVersion) {
  return Boolean(
    version.finishReason &&
    version.finishReason !== "tool_confirmation_requested",
  );
}

function isTerminalMessageVersion(version: MessageVersion) {
  return (
    version.isError === true ||
    version.isCancelled === true ||
    Boolean(version.errorCode) ||
    hasTerminalMessageVersionStatus(version) ||
    hasTerminalMessageVersionFinishReason(version)
  );
}

export function resolveMessageVersionRunLifecycle(input: {
  activeThreadRun?: ActiveThreadRun | null;
  isLatestAssistantGroup?: boolean;
  isStreaming?: boolean;
  version: MessageVersion;
}): MessageVersionRunLifecycle {
  const {
    activeThreadRun,
    isLatestAssistantGroup = false,
    isStreaming = false,
    version,
  } = input;

  if (
    isMessageVersionForActiveThreadRun({
      activeThreadRun,
      version,
    })
  ) {
    return activeThreadRun?.status === "waiting_for_approval"
      ? "waiting_for_approval"
      : "live";
  }

  if (
    activeThreadRun &&
    isLatestAssistantGroup &&
    !isTerminalMessageVersion(version)
  ) {
    return activeThreadRun.status === "waiting_for_approval"
      ? "waiting_for_approval"
      : "live";
  }

  if (isStreaming && isLatestAssistantGroup) {
    return "live";
  }

  if (isTerminalMessageVersion(version)) {
    return "terminal";
  }

  if (
    isStreaming &&
    Boolean(version.renderKey) &&
    hasActiveMessageVersionThreadRunStatus(version)
  ) {
    return version.threadRun?.status === "waiting_for_approval"
      ? "waiting_for_approval"
      : "live";
  }

  return "idle";
}
