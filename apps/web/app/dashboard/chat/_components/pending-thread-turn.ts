"use client";

import { SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX } from "@sourceweft/contracts";
import { readChatDraft, clearChatDraft } from "../../../../lib/chat-drafts";

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
  imageDraftKey?: string;
  durableRunKey?: string;
  requiresRetry?: boolean;
  userId?: string;
  workspaceId?: string;
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

export function createPendingThreadRunKey() {
  return `${SOURCEWEFT_WEB_RUN_IDEMPOTENCY_PREFIX}${crypto.randomUUID()}`;
}

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
  const turn = readPendingThreadTurn(threadId);
  if (turn?.imageDraftKey)
    void clearChatDraft(turn.imageDraftKey).catch(() => {
      // Retaining the source draft is safe if cleanup fails; never discard an unsent payload.
      console.error("Could not clear the accepted first-message image draft.");
    });
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
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      getPendingThreadTurnStorageKey(threadId),
      JSON.stringify(
        pendingTurn.imageDraftKey
          ? { ...pendingTurn, images: undefined }
          : pendingTurn,
      ),
    );
  } catch {
    throw new Error(
      "Could not save the first message. Keep this page open and try again.",
    );
  }
}

export async function hydratePendingThreadTurn(
  turn: PendingThreadTurn,
): Promise<PendingThreadTurn> {
  if (!turn.imageDraftKey || turn.images?.length) return turn;
  const draft = await readChatDraft(turn.imageDraftKey);
  if (!draft || !draft.files.length)
    throw new Error(
      "The first message's saved attachments are unavailable. Keep this page open and restore the attachments before sending.",
    );
  const images = await Promise.all(
    draft.files.map(async (file) => {
      if (
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          file.mediaType,
        )
      )
        throw new Error("Unsupported saved image type.");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file.blob);
      });
      return {
        dataUrl,
        fileName: file.filename,
        mimeType: file.mediaType as
          "image/png" | "image/jpeg" | "image/webp" | "image/gif",
        sizeBytes: file.blob.size,
      };
    }),
  );
  return { ...turn, images };
}
