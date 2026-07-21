"use client";

import type { ContentClient } from "@sourceweft/sdk";
import type { ModelThinkingCapabilities } from "./model-catalog-utils";

type CreateByokCredentialRequest = Parameters<
  ContentClient["createByokCredential"]
>[1];
type ListByokCredentialsResponse = Awaited<
  ReturnType<ContentClient["listByokCredentials"]>
>;
type ListByokModelsResponse = Awaited<
  ReturnType<ContentClient["listByokModels"]>
>;

export type ByokProviderOption = {
  providerName: string;
  providerKind: string;
  baseUrl: string | null;
  system: boolean;
  isByokOnly: boolean;
  hasApiKey: boolean;
};

export type ByokCredentialItem =
  ListByokCredentialsResponse["items"][number];
export type ByokSavedModelItem = ListByokModelsResponse["items"][number];

export type ByokModelSelection = {
  mode: "global" | "byok";
  // Global-only identity. BYOK selections must keep this null.
  profileAlias?: string | null;
  byokModelId?: string | null;
  credentialId?: string | null;
  credentialAlias?: string | null;
  modelAlias?: string | null;
  providerName?: string | null;
  customModelName?: string | null;
  capabilities?: ModelThinkingCapabilities | null;
  source: "catalog" | "custom";
};

export type PendingByokModelState = {
  llmByok?: ByokModelSelection | null;
  imageByok?: ByokModelSelection | null;
  visionByok?: ByokModelSelection | null;
};

export const DEFAULT_BYOK_PROVIDER_KIND = "openai-compatible";

const DEFAULT_PROFILE_ALIASES = new Set([
  "chat-default",
  "image-default",
  "vision-default",
]);

function normalizeExplicitProfileAlias(alias: string | null | undefined) {
  const trimmed = alias?.trim();
  if (!trimmed || DEFAULT_PROFILE_ALIASES.has(trimmed)) {
    return null;
  }
  return trimmed;
}

export function normalizeByokProviderOptions(
  input: unknown,
  credentials: ByokCredentialItem[],
): ByokProviderOption[] {
  const items =
    input && typeof input === "object" && Array.isArray((input as { items?: unknown }).items)
      ? ((input as { items: unknown[] }).items ?? [])
      : Array.isArray(input)
        ? input
        : [];
  const keyProviderNames = new Set(
    credentials
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
      const hasApiKey = keyProviderNames.has(providerName);

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
  for (const credential of credentials) {
    const providerName = credential.providerName?.trim();
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

export function toByokSelectionFromCustomModel(input: {
  byokModelId?: string | null;
  capabilities?: ModelThinkingCapabilities | null;
  credentialAlias?: string | null;
  credentialId?: string | null;
  modelName: string;
  providerName: string;
}): ByokModelSelection {
  return {
    mode: "byok",
    profileAlias: null,
    byokModelId: input.byokModelId ?? null,
    credentialId: input.credentialId ?? null,
    credentialAlias: input.credentialAlias ?? null,
    modelAlias: null,
    providerName: input.providerName,
    customModelName: input.modelName.trim(),
    capabilities: input.capabilities ?? null,
    source: "custom",
  };
}

export function buildByokModelExecution(input: {
  selection: ByokModelSelection | null | undefined;
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
  const byokModelId = selection.byokModelId?.trim();
  const customModelName = selection.customModelName?.trim();
  const modelAlias = selection.modelAlias?.trim();
  if (!byokModelId) {
    return input.thinking ? { thinking: input.thinking } : undefined;
  }

  const llm: Record<string, unknown> = {
    executionMode: "BYOK",
    byokModelId,
  };
  if (selection.credentialId) {
    llm.credentialId = selection.credentialId;
  }
  if (provider) {
    llm.providerHint = provider;
  }

  if (customModelName) {
    llm.modelAlias = customModelName;
    llm.providerModel = customModelName;
  } else if (modelAlias) {
    llm.modelAlias = modelAlias;
    llm.providerModel = modelAlias;
  }
  if (input.thinking) {
    llm.thinking = input.thinking;
  }

  return llm;
}

export function buildThreadCreateModelSettings(input: {
  byokSelection?: ByokModelSelection | null | undefined;
  globalProfileAlias?: string | null;
  imageProfileAlias?: string | null;
  imageByokSelection?: ByokModelSelection | null | undefined;
  visionProfileAlias?: string | null;
  visionByokSelection?: ByokModelSelection | null | undefined;
}) {
  const modelSettings: {
    llmProfileAlias?: string | null;
    imageProfileAlias?: string | null;
    visionProfileAlias?: string | null;
  } = {};

  const llmProfileAlias =
    input.byokSelection?.mode === "byok"
      ? null
      : normalizeExplicitProfileAlias(input.globalProfileAlias);

  if (llmProfileAlias) {
    modelSettings.llmProfileAlias = llmProfileAlias;
  }
  const imageProfileAlias =
    input.imageByokSelection?.mode === "byok"
      ? null
      : normalizeExplicitProfileAlias(input.imageProfileAlias);
  const visionProfileAlias =
    input.visionByokSelection?.mode === "byok"
      ? null
      : normalizeExplicitProfileAlias(input.visionProfileAlias);

  if (imageProfileAlias) {
    modelSettings.imageProfileAlias = imageProfileAlias;
  }
  if (visionProfileAlias) {
    modelSettings.visionProfileAlias = visionProfileAlias;
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
          ? (parsed.llmByok as ByokModelSelection)
          : null,
      imageByok:
        parsed.imageByok && typeof parsed.imageByok === "object"
          ? (parsed.imageByok as ByokModelSelection)
          : null,
      visionByok:
        parsed.visionByok && typeof parsed.visionByok === "object"
          ? (parsed.visionByok as ByokModelSelection)
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
  if (!value || (!value.llmByok && !value.imageByok && !value.visionByok)) {
    window.sessionStorage.removeItem(key);
    return;
  }
  window.sessionStorage.setItem(key, JSON.stringify(value));
}

export function copyStoredByokState(input: {
  workspaceId: string;
  fromBucket?: string | null;
  toBucket?: string | null;
}) {
  if (typeof window === "undefined") {
    return;
  }

  const value = readStoredByokState(input.workspaceId, input.fromBucket);
  writeStoredByokState(input.workspaceId, value, input.toBucket);
}

export function toCreateByokCredentialPayload(input: {
  apiKey: string;
  baseUrl?: string;
  credentialAlias: string;
  providerName: string;
  providerKind?: string;
  metadata?: Record<string, unknown>;
}): CreateByokCredentialRequest {
  return {
    providerName: input.providerName.trim(),
    credentialAlias: input.credentialAlias.trim(),
    apiKey: input.apiKey.trim(),
    ...(input.providerKind?.trim()
      ? { providerKind: input.providerKind.trim() }
      : {}),
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

