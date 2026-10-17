import { readAgentRunStop } from "@sourceweft/contracts";
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
