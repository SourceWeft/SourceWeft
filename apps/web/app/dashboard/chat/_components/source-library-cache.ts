import type { SourceItem } from "./source-types";

export const CACHE_VERSION = "v1";
export const CACHE_KEY_PREFIX = "sourceweft:workspace-sources";
export const CACHE_TIMESTAMP_PREFIX = "sourceweft:workspace-sources-ts";
export const CACHE_TTL_MS = 30 * 60 * 1000;

type StoredCachePayload = {
  version: string;
  sources: SourceItem[];
};

const workspaceSourcesCache = new Map<string, SourceItem[]>();

function cloneSources(sources: SourceItem[]) {
  return sources.map((source) => ({ ...source }));
}

function getDataKey(workspaceId: string) {
  return `${CACHE_KEY_PREFIX}:${CACHE_VERSION}:${workspaceId}`;
}

function getTimestampKey(workspaceId: string) {
  return `${CACHE_TIMESTAMP_PREFIX}:${CACHE_VERSION}:${workspaceId}`;
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function removeStorageEntry(workspaceId: string) {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(getDataKey(workspaceId));
    storage.removeItem(getTimestampKey(workspaceId));
  } catch {
    return;
  }
}

function writeStorageEntry(workspaceId: string, sources: SourceItem[]) {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  const payload: StoredCachePayload = {
    version: CACHE_VERSION,
    sources,
  };

  try {
    storage.setItem(getDataKey(workspaceId), JSON.stringify(payload));
    storage.setItem(
      getTimestampKey(workspaceId),
      JSON.stringify(Date.now()),
    );
  } catch {
    return;
  }
}

function readStorageEntry(workspaceId: string): SourceItem[] | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  let rawData: string | null = null;
  let rawTimestamp: string | null = null;
  try {
    rawData = storage.getItem(getDataKey(workspaceId));
    rawTimestamp = storage.getItem(getTimestampKey(workspaceId));
  } catch {
    return null;
  }

  if (!rawData || !rawTimestamp) {
    removeStorageEntry(workspaceId);
    return null;
  }

  let parsedPayload: StoredCachePayload | null = null;
  let parsedTimestamp: number | null = null;
  try {
    parsedPayload = JSON.parse(rawData) as StoredCachePayload;
    parsedTimestamp = JSON.parse(rawTimestamp) as number;
  } catch {
    removeStorageEntry(workspaceId);
    return null;
  }

  if (
    !parsedPayload ||
    parsedPayload.version !== CACHE_VERSION ||
    !Array.isArray(parsedPayload.sources)
  ) {
    removeStorageEntry(workspaceId);
    return null;
  }

  if (
    typeof parsedTimestamp !== "number" ||
    !Number.isFinite(parsedTimestamp) ||
    Date.now() - parsedTimestamp > CACHE_TTL_MS
  ) {
    removeStorageEntry(workspaceId);
    return null;
  }

  return parsedPayload.sources;
}

export function getCachedWorkspaceSources(
  workspaceId: string | null | undefined,
) {
  if (!workspaceId) {
    return null;
  }

  const cached = workspaceSourcesCache.get(workspaceId);
  if (cached) {
    return cloneSources(cached);
  }

  const fromStorage = readStorageEntry(workspaceId);
  if (!fromStorage) {
    return null;
  }

  workspaceSourcesCache.set(workspaceId, cloneSources(fromStorage));
  return cloneSources(fromStorage);
}

export function hasCachedWorkspaceSources(
  workspaceId: string | null | undefined,
) {
  if (!workspaceId) {
    return false;
  }

  if (workspaceSourcesCache.has(workspaceId)) {
    return true;
  }

  const fromStorage = readStorageEntry(workspaceId);
  if (!fromStorage) {
    return false;
  }

  workspaceSourcesCache.set(workspaceId, cloneSources(fromStorage));
  return true;
}

export function setCachedWorkspaceSources(
  workspaceId: string | null | undefined,
  sources: SourceItem[],
) {
  if (!workspaceId) {
    return;
  }

  const cloned = cloneSources(sources);
  workspaceSourcesCache.set(workspaceId, cloned);
  writeStorageEntry(workspaceId, cloned);
}

export function clearWorkspaceSourceCache(workspaceId?: string | null) {
  if (workspaceId) {
    workspaceSourcesCache.delete(workspaceId);
    removeStorageEntry(workspaceId);
    return;
  }

  workspaceSourcesCache.clear();

  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  const keysToRemove: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key &&
        (key.startsWith(`${CACHE_KEY_PREFIX}:`) ||
          key.startsWith(`${CACHE_TIMESTAMP_PREFIX}:`))
      ) {
        keysToRemove.push(key);
      }
    }
  } catch {
    return;
  }

  for (const key of keysToRemove) {
    try {
      storage.removeItem(key);
    } catch {
      continue;
    }
  }
}
