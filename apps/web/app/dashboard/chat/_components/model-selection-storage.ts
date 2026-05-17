import type { ModelAliasSettings } from "./model-catalog-utils";

const MODEL_SELECTION_STORAGE_PREFIX = "chat:models";

function parseModelAliases(raw: string | null): ModelAliasSettings | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    return {
      llmProfileAlias:
        typeof record.llmProfileAlias === "string"
          ? record.llmProfileAlias
          : null,
      imageProfileAlias:
        typeof record.imageProfileAlias === "string"
          ? record.imageProfileAlias
          : null,
      visionProfileAlias:
        typeof record.visionProfileAlias === "string"
          ? record.visionProfileAlias
          : null,
    };
  } catch {
    return null;
  }
}

export function getModelSelectionStorageKey(
  workspaceId: string,
  bucket: string,
) {
  return `${MODEL_SELECTION_STORAGE_PREFIX}:${workspaceId}:${bucket}`;
}

export function readStoredModelSelection(
  workspaceId: string,
  bucket: string,
): ModelAliasSettings | null {
  const key = getModelSelectionStorageKey(workspaceId, bucket);
  const localValue = window.localStorage.getItem(key);
  if (localValue !== null) {
    return parseModelAliases(localValue);
  }

  return parseModelAliases(window.sessionStorage.getItem(key));
}

export function writeStoredModelSelection(
  workspaceId: string,
  bucket: string,
  aliases: ModelAliasSettings | null,
) {
  const key = getModelSelectionStorageKey(workspaceId, bucket);
  if (
    !aliases ||
    (!aliases.llmProfileAlias &&
      !aliases.imageProfileAlias &&
      !aliases.visionProfileAlias)
  ) {
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
    return;
  }

  window.localStorage.setItem(
    key,
    JSON.stringify({
      llmProfileAlias: aliases.llmProfileAlias ?? null,
      imageProfileAlias: aliases.imageProfileAlias ?? null,
      visionProfileAlias: aliases.visionProfileAlias ?? null,
    }),
  );
}

export function copyStoredModelSelection(input: {
  workspaceId: string;
  fromBucket: string;
  toBucket: string;
}) {
  writeStoredModelSelection(
    input.workspaceId,
    input.toBucket,
    readStoredModelSelection(input.workspaceId, input.fromBucket),
  );
}

export function clearStoredModelSelection(workspaceId: string, bucket: string) {
  const key = getModelSelectionStorageKey(workspaceId, bucket);
  window.localStorage.removeItem(key);
  window.sessionStorage.removeItem(key);
}
