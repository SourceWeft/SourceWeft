"use client";

import type { ByokModelSelection } from "./byok-state";
import type {
  ChatSendInput,
  PromptThinkingSettings,
} from "./chat-canvas/types";
import type { ComposerOptionsState } from "./chat-canvas/composer-options";
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
  invocation?: ChatSendInput["invocation"];
  thinking?: RequestThinkingConfig;
  thinkingSettings?: PromptThinkingSettings;
  searchEnabled?: boolean;
  composerOptions?: ComposerOptionsState;
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

function getPendingThreadTurnStorageKey(threadId: string) {
  return `chat:pending:${threadId}`;
}

export function setPendingThreadTurn(
  threadId: string,
  pendingTurn: PendingThreadTurn,
) {
  pendingThreadTurns.set(threadId, pendingTurn);
}

export function readPendingThreadTurn(threadId: string) {
  const pendingTurn = pendingThreadTurns.get(threadId) ?? null;
  if (pendingTurn || typeof window === "undefined") {
    return pendingTurn;
  }

  const pendingKey = getPendingThreadTurnStorageKey(threadId);
  const raw = window.sessionStorage.getItem(pendingKey);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as PendingThreadTurn;
  } catch {
    window.sessionStorage.removeItem(pendingKey);
    return null;
  }
}

export function clearPendingThreadTurn(threadId: string) {
  pendingThreadTurns.delete(threadId);
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.removeItem(getPendingThreadTurnStorageKey(threadId));
}

export function consumePendingThreadTurn(threadId: string) {
  const pendingTurn = readPendingThreadTurn(threadId);
  if (pendingTurn) {
    clearPendingThreadTurn(threadId);
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
      getPendingThreadTurnStorageKey(threadId),
      JSON.stringify(pendingTurn),
    );
  } catch {
    // The in-memory pending turn is enough for same-session navigation.
  }
}
