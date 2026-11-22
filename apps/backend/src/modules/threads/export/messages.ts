import { toObjectRecord } from "../../../shared/records";
import type { MessageRecord } from "../../content/types";
import { collapseSupersededMessages } from "../turn/superseded-messages";
import { extractImagePartsFromContentJson } from "../turn/message-image-parts";

function readArtifactIdFromOutput(output: unknown): string | null {
  let value: unknown = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const record = toObjectRecord(value);
  const id = record?.artifactId ?? record?.artifact_id;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

/**
 * Artifacts a reply produced, in the order they first appear: the committed
 * artifact blocks the chat renders, then artifact ids in tool outputs (where
 * generated images record theirs).
 */
export function collectMessageArtifactIds(
  metadata: Record<string, unknown>,
): string[] {
  const found = new Set<string>();
  const blocks = Array.isArray(metadata.renderBlocks)
    ? metadata.renderBlocks
    : [];
  for (const block of blocks) {
    const record = toObjectRecord(block);
    if (
      record?.type === "artifact_output" &&
      typeof record.artifactId === "string" &&
      record.artifactId.length > 0
    ) {
      found.add(record.artifactId);
    }
  }
  const toolCalls = Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [];
  for (const call of toolCalls) {
    const id = readArtifactIdFromOutput(toObjectRecord(call)?.output);
    if (id) {
      found.add(id);
    }
  }
  return [...found];
}

function hasExportableContent(message: MessageRecord) {
  return (
    message.content.trim().length > 0 ||
    extractImagePartsFromContentJson(message.contentJson).length > 0 ||
    (message.role === "assistant" &&
      collectMessageArtifactIds(message.metadata).length > 0)
  );
}

/**
 * The messages an export shows: the newest version of every user and
 * assistant message (the history the agent itself reads), without errors,
 * the answer still being generated, or messages with nothing to show.
 */
export function selectExportMessages(
  messages: MessageRecord[],
  activeAssistantMessageId: string | null,
): MessageRecord[] {
  return collapseSupersededMessages(messages).filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.metadata.isError !== true &&
      message.id !== activeAssistantMessageId &&
      hasExportableContent(message),
  );
}
