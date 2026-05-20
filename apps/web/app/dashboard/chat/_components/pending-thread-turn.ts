"use client";

import type { ByokModelSelection } from "./byok-state";
import type {
  ChatSendInput,
  PromptThinkingSettings,
} from "./chat-canvas/types";
import type {
  ModelItem,
  ModelType,
  SelectedModels,
} from "./model-catalog-utils";
import type { RequestThinkingConfig } from "../[threadId]/streaming-request-body";

export type PendingThreadTurn = {
  content: string;
  images?: ChatSendInput["images"];
  mentionedSourceIds?: string[];
  sourceIds: string[];
  skillIds?: string[];
  tools?: ChatSendInput["tools"];
  command?: ChatSendInput["command"];
  thinking?: RequestThinkingConfig;
  thinkingSettings?: PromptThinkingSettings;
  searchEnabled?: boolean;
  modelState?: {
    availableModels?: Record<ModelType, ModelItem[]>;
    catalogKindEnabled?: Record<ModelType, boolean>;
    catalogReady?: boolean;
    selectedModels?: SelectedModels;
    byokSelection?: ByokModelSelection | null;
    byokSelections?: Partial<Record<ModelType, ByokModelSelection | null>>;
  };
};

const pendingThreadTurns = new Map<string, PendingThreadTurn>();

export function setPendingThreadTurn(
  threadId: string,
  pendingTurn: PendingThreadTurn,
) {
  pendingThreadTurns.set(threadId, pendingTurn);
}

export function consumePendingThreadTurn(threadId: string) {
  const pendingTurn = pendingThreadTurns.get(threadId) ?? null;
  if (pendingTurn) {
    pendingThreadTurns.delete(threadId);
  }
  return pendingTurn;
}

export function writePendingThreadTurnFallback(
  threadId: string,
  pendingTurn: PendingThreadTurn,
) {
  if (typeof window === "undefined" || (pendingTurn.images?.length ?? 0) > 0) {
    return;
  }

  try {
    window.sessionStorage.setItem(
      `chat:pending:${threadId}`,
      JSON.stringify(pendingTurn),
    );
  } catch {
    // The in-memory pending turn is enough for same-session navigation.
  }
}
