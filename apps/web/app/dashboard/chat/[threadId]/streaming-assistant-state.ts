"use client";

import { useCallback, useState } from "react";
import { mergeCommittedArtifactOutputsIntoMessage } from "./_thread/artifact-output-reconcile";

export type ChatMessageItem = {
  id: string;
  role: "user" | "assistant";
  content: string;
  contentJson: Record<string, unknown>;
  parentMessageId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type StreamingAssistantSnapshot = {
  message: ChatMessageItem;
  messageId: string;
  messageIds: string[];
  renderVersion: number;
};

export function mergeStreamingMessageIntoMessages(
  messages: ChatMessageItem[],
  snapshot: StreamingAssistantSnapshot | null,
) {
  if (!snapshot) {
    return messages;
  }

  const snapshotIds = new Set([...snapshot.messageIds, snapshot.messageId]);
  let found = false;
  let streamingMessage = snapshot.message;
  for (const message of messages) {
    if (!snapshotIds.has(message.id)) {
      continue;
    }
    streamingMessage = mergeCommittedArtifactOutputsIntoMessage({
      authoritative: message,
      current: streamingMessage,
    });
  }
  const merged = messages.flatMap((message) => {
    if (!snapshotIds.has(message.id)) {
      return message;
    }
    if (found) {
      return [];
    }
    found = true;
    return [streamingMessage];
  });

  return found ? merged : [...merged, streamingMessage];
}

export function useStreamingAssistantTransientState() {
  const [streamingAssistantSnapshot, setStreamingAssistantSnapshot] =
    useState<StreamingAssistantSnapshot | null>(null);

  const mergeStreamingAssistantIntoMessages = useCallback(
    (messages: ChatMessageItem[]) =>
      mergeStreamingMessageIntoMessages(messages, streamingAssistantSnapshot),
    [streamingAssistantSnapshot],
  );

  return {
    mergeStreamingAssistantIntoMessages,
    setStreamingAssistantSnapshot,
    streamingAssistantSnapshot,
  };
}
