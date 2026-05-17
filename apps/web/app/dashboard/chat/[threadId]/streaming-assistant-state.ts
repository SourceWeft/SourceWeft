"use client";

import { useCallback, useState } from "react";

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
  const merged = messages.flatMap((message) => {
    if (!snapshotIds.has(message.id)) {
      return message;
    }
    if (found) {
      return [];
    }
    found = true;
    return [snapshot.message];
  });

  return found ? merged : [...merged, snapshot.message];
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
