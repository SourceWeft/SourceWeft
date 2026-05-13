"use client";

import type { ContentClient } from "@sourceweft/sdk";
import type { ModelThinkingCapabilities, ModelType } from "./header-model-selector";

type CreateByokKeyRefRequest = Parameters<ContentClient["createByokKeyRef"]>[1];
type ListByokKeyRefsResponse = Awaited<
  ReturnType<ContentClient["listByokKeyRefs"]>
>;

export type ByokProviderOption = {
  providerName: string;
  providerKind: string;
  baseUrl: string | null;
  system: boolean;
  isByokOnly: boolean;
  hasApiKey: boolean;
};

export type ByokKeyRefItem = ListByokKeyRefsResponse["items"][number];

export type ByokLlmSelection = {
  mode: "global" | "byok";
  profileAlias?: string | null;
  modelAlias?: string | null;
  providerName?: string | null;
  keyRef?: string | null;
  customModelName?: string | null;
  capabilities?: ModelThinkingCapabilities | null;
  source: "catalog" | "custom";
};

export type PendingByokModelState = {
  llmByok?: ByokLlmSelection | null;
};

export const DEFAULT_BYOK_PROVIDER_KIND = "openai-compatible";

export function normalizeByokProviderOptions(
  input: unknown,
  keyRefs: ByokKeyRefItem[],
): ByokProviderOption[] {
  const items =
    input && typeof input === "object" && Array.isArray((input as { items?: unknown }).items)
      ? ((input as { items: unknown[] }).items ?? [])
      : Array.isArray(input)
        ? input
        : [];
  const keyProviderNames = new Set(
    keyRefs
      .map((item) => item.providerName?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  const normalized = items
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const providerName =
        typeof record.providerName === "string" ? record.providerName.trim() : "";
      if (!providerName) {
        return null;
      }
      const providerKind =
        typeof record.providerKind === "string" && record.providerKind.trim().length > 0
          ? record.providerKind.trim()
          : DEFAULT_BYOK_PROVIDER_KIND;
      const baseUrl =
        typeof record.baseUrl === "string" && record.baseUrl.trim().length > 0
          ? record.baseUrl.trim()
          : null;
      const system = record.system === true;
      const isByokOnly =
        record.isBYOKOnly === true || record.isByokOnly === true;
      const hasApiKey =
        record.hasApiKey === true || keyProviderNames.has(providerName);

      return {
        providerName,
        providerKind,
        baseUrl,
        system,
        isByokOnly,
        hasApiKey,
      } satisfies ByokProviderOption;
    })
    .filter((item): item is ByokProviderOption => item !== null);

  const existingNames = new Set(normalized.map((item) => item.providerName));
  for (const keyRef of keyRefs) {
    const providerName = keyRef.providerName?.trim();
    if (!providerName || existingNames.has(providerName)) {
      continue;
    }
    normalized.push({
      providerName,
      providerKind: DEFAULT_BYOK_PROVIDER_KIND,
      baseUrl: null,
      system: false,
      isByokOnly: true,
      hasApiKey: true,
    });
    existingNames.add(providerName);
  }

  return normalized.sort((left, right) => {
    if (left.hasApiKey !== right.hasApiKey) {
      return left.hasApiKey ? -1 : 1;
    }
    if (left.system !== right.system) {
      return left.system ? -1 : 1;
    }
    return left.providerName.localeCompare(right.providerName);
  });
}

export function toByokSelectionFromCatalogModel(input: {
  capabilities?: ModelThinkingCapabilities | null;
  providerName: string;
  keyRef: string;
  profileAlias?: string | null;
  modelAlias: string;
}): ByokLlmSelection | null {
  if (!input.modelAlias.trim()) {
    return null;
  }

  return {
    mode: "byok",
    profileAlias: input.profileAlias?.trim() || null,
    modelAlias: input.modelAlias.trim(),
    providerName: input.providerName,
    keyRef: input.keyRef,
    customModelName: null,
    capabilities: input.capabilities ?? null,
    source: "catalog",
  };
}

export function toByokSelectionFromCustomModel(input: {
  capabilities?: ModelThinkingCapabilities | null;
  modelName: string;
  providerName: string;
  keyRef: string;
}): ByokLlmSelection {
  return {
    mode: "byok",
    profileAlias: null,
    modelAlias: null,
    providerName: input.providerName,
    keyRef: input.keyRef,
    customModelName: input.modelName.trim(),
    capabilities: input.capabilities ?? null,
    source: "custom",
  };
}

export function buildThreadLlmExecution(input: {
  selection: ByokLlmSelection | null | undefined;
  thinking?: {
    mode: "auto" | "off" | "effort";
    enabled?: boolean;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    includeReasoning?: boolean;
  };
}) {
  const selection = input.selection;
  if (!selection || selection.mode !== "byok") {
    return input.thinking ? { thinking: input.thinking } : undefined;
  }

  const provider = selection.providerName?.trim();
  const apiKeyRef = selection.keyRef?.trim();
  const customModelName = selection.customModelName?.trim();
  const modelAlias = selection.modelAlias?.trim();
  if (!provider || !apiKeyRef) {
    return input.thinking ? { thinking: input.thinking } : undefined;
  }

  const llm: Record<string, unknown> = {
    executionMode: "BYOK",
    providerHint: provider,
    byok: {
      provider,
      apiKeyRef,
    },
  };

  if (selection.profileAlias) {
    llm.profileAlias = selection.profileAlias;
  }
  if (customModelName) {
    llm.modelAlias = customModelName;
  } else if (!selection.profileAlias && modelAlias) {
    llm.modelAlias = modelAlias;
  }
  if (input.thinking) {
    llm.thinking = input.thinking;
  }

  return llm;
}

export function buildThreadCreateModelSettings(input: {
  byokSelection: ByokLlmSelection | null | undefined;
  globalProfileAlias?: string | null;
  imageProfileAlias?: string | null;
  visionProfileAlias?: string | null;
}) {
  const modelSettings: {
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  } = {};

  const llmProfileAlias =
    input.byokSelection?.profileAlias && input.byokSelection.mode === "byok"
      ? input.byokSelection.profileAlias
      : input.globalProfileAlias;

  if (llmProfileAlias) {
    modelSettings.llmProfileAlias = llmProfileAlias;
  }
  if (input.imageProfileAlias) {
    modelSettings.imageProfileAlias = input.imageProfileAlias;
  }
  if (input.visionProfileAlias) {
    modelSettings.visionProfileAlias = input.visionProfileAlias;
  }

  return Object.keys(modelSettings).length > 0 ? modelSettings : undefined;
}

export function getByokStorageKey(workspaceId: string, threadId?: string | null) {
  return threadId
    ? `chat:byok:${workspaceId}:${threadId}`
    : `chat:byok:${workspaceId}:current`;
}

export function readStoredByokState(
  workspaceId: string,
  threadId?: string | null,
): PendingByokModelState | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.sessionStorage.getItem(getByokStorageKey(workspaceId, threadId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingByokModelState>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      llmByok:
        parsed.llmByok && typeof parsed.llmByok === "object"
          ? (parsed.llmByok as ByokLlmSelection)
          : null,
    };
  } catch {
    return null;
  }
}

export function writeStoredByokState(
  workspaceId: string,
  value: PendingByokModelState | null,
  threadId?: string | null,
) {
  if (typeof window === "undefined") {
    return;
  }
  const key = getByokStorageKey(workspaceId, threadId);
  if (!value || !value.llmByok) {
    window.sessionStorage.removeItem(key);
    return;
  }
  window.sessionStorage.setItem(key, JSON.stringify(value));
}

export function clearStoredByokState(workspaceId: string, threadId?: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.removeItem(getByokStorageKey(workspaceId, threadId));
}

export function toCreateByokKeyPayload(input: {
  apiKey: string;
  baseUrl?: string;
  keyRef: string;
  providerName: string;
  providerKind?: string;
  metadata?: Record<string, unknown>;
}): CreateByokKeyRefRequest {
  return {
    providerName: input.providerName.trim(),
    keyRef: input.keyRef.trim(),
    apiKey: input.apiKey.trim(),
    ...(input.providerKind?.trim()
      ? { providerKind: input.providerKind.trim() }
      : {}),
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function selectionSupportsThinking(
  selection: ByokLlmSelection | null | undefined,
  fallbackCapabilities?: ModelThinkingCapabilities | undefined,
) {
  return (
    selection?.capabilities?.supportsThinking === true ||
    fallbackCapabilities?.supportsThinking === true
  );
}

export function modelTypeSupportsByok(type: ModelType) {
  return type === "llm";
}
