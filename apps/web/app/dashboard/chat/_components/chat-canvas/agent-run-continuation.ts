import { readAgentRunStop, readAgentRunProgress } from "@sourceweft/contracts";
import type { ChatSendInput, MessageVersion } from "./types";

export type AgentContinuationInputBuilder = (
  content: string,
) => ChatSendInput | null;

export function readContinuableAgentRunStop(version: MessageVersion) {
  const metadata = version.metadata ?? {};
  const metadataRun = metadata.threadRun;
  if (
    metadata.isCancelled === true ||
    metadata.errorCode === "CLIENT_CANCELLED" ||
    (metadataRun !== null &&
      typeof metadataRun === "object" &&
      "status" in metadataRun &&
      metadataRun.status === "cancelled") ||
    version.isCancelled ||
    version.errorCode === "CLIENT_CANCELLED" ||
    version.threadRun?.status === "cancelled"
  )
    return null;
  return readAgentRunStop(version.metadata?.agentRunStop);
}

export function readMessageAgentRunStop(input: {
  role: string;
  version: MessageVersion;
  isLatestAssistantGroup: boolean;
  isActiveVersion: boolean;
}) {
  return input.role === "assistant" &&
    input.isLatestAssistantGroup &&
    input.isActiveVersion
    ? readContinuableAgentRunStop(input.version)
    : null;
}

export function readMessageAgentRunProgress(input: {
  role: string;
  version: MessageVersion;
  isLatestAssistantGroup: boolean;
  isActiveVersion: boolean;
  isRunActive: boolean;
}) {
  if (
    input.role !== "assistant" ||
    !input.isLatestAssistantGroup ||
    !input.isActiveVersion ||
    !input.isRunActive ||
    input.version.metadata?.agentRunStop ||
    input.version.isCancelled ||
    input.version.metadata?.isCancelled === true ||
    input.version.metadata?.isError === true ||
    input.version.threadRun?.status === "cancelled" ||
    (typeof input.version.metadata?.threadRun === "object" &&
      input.version.metadata.threadRun !== null &&
      "status" in input.version.metadata.threadRun &&
      input.version.metadata.threadRun.status === "cancelled") ||
    input.version.errorCode === "CLIENT_CANCELLED" ||
    input.version.metadata?.errorCode === "CLIENT_CANCELLED"
  )
    return null;
  const progress = readAgentRunProgress(
    input.version.metadata?.agentRunProgress,
  );
  return progress?.phase === "closing" || progress?.phase === "finalizing"
    ? progress
    : null;
}
