const SOURCE_SELECTION_STORAGE_PREFIX = "chat:sources";

function parseSourceIds(raw: string | null): string[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function getSourceSelectionStorageKey(
  workspaceId: string,
  bucket: string,
) {
  return `${SOURCE_SELECTION_STORAGE_PREFIX}:${workspaceId}:${bucket}`;
}

export function readStoredSourceSelection(
  workspaceId: string,
  bucket: string,
): string[] {
  const key = getSourceSelectionStorageKey(workspaceId, bucket);
  const localValue = window.localStorage.getItem(key);
  if (localValue !== null) {
    return parseSourceIds(localValue);
  }

  return parseSourceIds(window.sessionStorage.getItem(key));
}

export function writeStoredSourceSelection(
  workspaceId: string,
  bucket: string,
  sourceIds: string[],
) {
  const key = getSourceSelectionStorageKey(workspaceId, bucket);
  window.localStorage.setItem(key, JSON.stringify(sourceIds));
}

export function clearStoredSourceSelection(workspaceId: string, bucket: string) {
  const key = getSourceSelectionStorageKey(workspaceId, bucket);
  window.localStorage.removeItem(key);
  window.sessionStorage.removeItem(key);
}
