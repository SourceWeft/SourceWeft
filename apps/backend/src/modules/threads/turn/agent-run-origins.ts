import { ContentError } from "../../content/errors";
import type { MessageRecord } from "../../content/types";
import type { AgentCheckpointRef } from "./types";
import {
  resolveAgentCheckpointMetadata,
  resolveUserForAssistantMessage,
} from "./context";

import { MAX_AGENT_REFRESH_GRAPH_ORIGINS } from "../agent-run-budget-limits";
export { MAX_AGENT_REFRESH_GRAPH_ORIGINS } from "../agent-run-budget-limits";
const KEY = "agentRunThreadIds";
function unavailable(): never {
  throw new ContentError(
    409,
    "AGENT_STEP_REFRESH_UNAVAILABLE",
    "Saved execution lineage cannot be verified. Send a new message to continue.",
  );
}
export function readAgentRunOrigins(
  metadata: Record<string, unknown>,
): string[] {
  const raw = metadata[KEY];
  if (raw === undefined) return [];
  if (
    !Array.isArray(raw) ||
    raw.some((id) => typeof id !== "string" || !id.trim())
  )
    unavailable();
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_AGENT_REFRESH_GRAPH_ORIGINS) unavailable();
  return ids;
}
/** Called only inside persistMessageProjection's existing message row lock. */
export function appendAgentRunOrigin(input: {
  current: MessageRecord;
  teamId: string;
  workspaceId: string;
  threadId: string;
  userMessageId: string;
  graphThreadId: string;
  priorGraphThreadIds?: string[];
}): Record<string, unknown> {
  const { current } = input;
  if (
    current.role !== "user" ||
    current.id !== input.userMessageId ||
    current.teamId !== input.teamId ||
    current.workspaceId !== input.workspaceId ||
    current.threadId !== input.threadId ||
    !input.graphThreadId.trim()
  )
    unavailable();
  const ids = [
    ...new Set([
      ...readAgentRunOrigins(current.metadata),
      ...(input.priorGraphThreadIds ?? []),
      input.graphThreadId,
    ]),
  ];
  if (
    ids.length > MAX_AGENT_REFRESH_GRAPH_ORIGINS ||
    ids.some((id) => typeof id !== "string" || !id.trim())
  )
    unavailable();
  return { ...current.metadata, [KEY]: ids };
}
/** Only authorized, server-loaded message rows supply graph references. */
export function collectRefreshAgentRunOrigins(input: {
  teamId: string;
  workspaceId: string;
  threadId: string;
  userMessage: MessageRecord;
  messages: MessageRecord[];
}) {
  if (input.userMessage.role !== "user") unavailable();
  const recordedOrigins = readAgentRunOrigins(input.userMessage.metadata);
  const ids = new Set<string>(
    recordedOrigins.length ? recordedOrigins : [input.threadId],
  );
  const checkpointRefs: AgentCheckpointRef[] = [];
  const floors = new Map<string, AgentCheckpointRef>();
  let requireExistingBudget = recordedOrigins.length > 0;
  for (const message of [input.userMessage, ...input.messages]) {
    if (
      message.teamId !== input.teamId ||
      message.workspaceId !== input.workspaceId ||
      message.threadId !== input.threadId
    )
      unavailable();
    if (message.role === "user" && message.id === input.userMessage.id) {
      for (const id of readAgentRunOrigins(message.metadata)) ids.add(id);
    }
    if (
      message.role !== "assistant" ||
      resolveUserForAssistantMessage(input.messages, message)?.id !==
        input.userMessage.id
    )
      continue;
    if (message.metadata.isError === true) requireExistingBudget = true;
    const checkpoint = resolveAgentCheckpointMetadata(message);
    const base = checkpoint?.beforeInput;
    if (
      base &&
      (!floors.has(base.threadId) ||
        base.checkpointId < floors.get(base.threadId)!.checkpointId)
    )
      floors.set(base.threadId, base);
    if (checkpoint)
      for (const ref of Object.values(checkpoint)) {
        if (!ref) continue;
        if (ref.checkpointNs && ref.checkpointNs !== "") unavailable();
        ids.add(ref.threadId);
        checkpointRefs.push(ref);
      }
    if (
      message.metadata.agentRunStop != null ||
      message.metadata.agentRunProgress != null
    )
      requireExistingBudget = true;
  }
  if (ids.size > MAX_AGENT_REFRESH_GRAPH_ORIGINS) unavailable();
  return {
    graphThreadIds: [...ids],
    checkpointRefs,
    historyFloors: [...floors.values()],
    requireExistingBudget,
  };
}
