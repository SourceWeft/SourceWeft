export const WORKSPACE_HUB_CACHE_VERSION = "v1";
export const WORKSPACE_HUB_CACHE_KEY_PREFIX = "sourceweft:workspace-hub";
export const WORKSPACE_HUB_CACHE_TIMESTAMP_PREFIX =
  "sourceweft:workspace-hub-ts";
export const WORKSPACE_HUB_CACHE_TTL_MS = 30 * 60 * 1000;

type StoredCachePayload<T> = {
  version: string;
  value: T;
};

const workspaceHubCache = new Map<string, unknown>();

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getCacheId(bucket: string, workspaceId: string) {
  return `${bucket}:${workspaceId}`;
}

function getDataKey(bucket: string, workspaceId: string) {
  return `${WORKSPACE_HUB_CACHE_KEY_PREFIX}:${WORKSPACE_HUB_CACHE_VERSION}:${bucket}:${workspaceId}`;
}

function getTimestampKey(bucket: string, workspaceId: string) {
  return `${WORKSPACE_HUB_CACHE_TIMESTAMP_PREFIX}:${WORKSPACE_HUB_CACHE_VERSION}:${bucket}:${workspaceId}`;
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

function removeStorageEntry(bucket: string, workspaceId: string) {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(getDataKey(bucket, workspaceId));
    storage.removeItem(getTimestampKey(bucket, workspaceId));
  } catch {
    return;
  }
}

function writeStorageEntry<T>(bucket: string, workspaceId: string, value: T) {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  const payload: StoredCachePayload<T> = {
    version: WORKSPACE_HUB_CACHE_VERSION,
    value,
  };

  try {
    storage.setItem(getDataKey(bucket, workspaceId), JSON.stringify(payload));
    storage.setItem(
      getTimestampKey(bucket, workspaceId),
      JSON.stringify(Date.now()),
    );
  } catch {
    return;
  }
}

function readStorageEntry<T>(bucket: string, workspaceId: string): T | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  let rawData: string | null = null;
  let rawTimestamp: string | null = null;
  try {
    rawData = storage.getItem(getDataKey(bucket, workspaceId));
    rawTimestamp = storage.getItem(getTimestampKey(bucket, workspaceId));
  } catch {
    return null;
  }

  if (!rawData || !rawTimestamp) {
    removeStorageEntry(bucket, workspaceId);
    return null;
  }

  let parsedPayload: StoredCachePayload<T> | null = null;
  let parsedTimestamp: number | null = null;
  try {
    parsedPayload = JSON.parse(rawData) as StoredCachePayload<T>;
    parsedTimestamp = JSON.parse(rawTimestamp) as number;
  } catch {
    removeStorageEntry(bucket, workspaceId);
    return null;
  }

  if (!parsedPayload || parsedPayload.version !== WORKSPACE_HUB_CACHE_VERSION) {
    removeStorageEntry(bucket, workspaceId);
    return null;
  }

  if (
    typeof parsedTimestamp !== "number" ||
    !Number.isFinite(parsedTimestamp) ||
    Date.now() - parsedTimestamp > WORKSPACE_HUB_CACHE_TTL_MS
  ) {
    removeStorageEntry(bucket, workspaceId);
    return null;
  }

  return parsedPayload.value;
}

export function getCachedWorkspaceHubValue<T>(
  bucket: string,
  workspaceId: string | null | undefined,
) {
  if (!workspaceId) {
    return null;
  }

  const cacheId = getCacheId(bucket, workspaceId);
  if (workspaceHubCache.has(cacheId)) {
    return cloneValue(workspaceHubCache.get(cacheId) as T);
  }

  const fromStorage = readStorageEntry<T>(bucket, workspaceId);
  if (!fromStorage) {
    return null;
  }

  workspaceHubCache.set(cacheId, cloneValue(fromStorage));
  return cloneValue(fromStorage);
}

export function hasCachedWorkspaceHubValue(
  bucket: string,
  workspaceId: string | null | undefined,
) {
  if (!workspaceId) {
    return false;
  }

  const cacheId = getCacheId(bucket, workspaceId);
  if (workspaceHubCache.has(cacheId)) {
    return true;
  }

  const fromStorage = readStorageEntry<unknown>(bucket, workspaceId);
  if (!fromStorage) {
    return false;
  }

  workspaceHubCache.set(cacheId, cloneValue(fromStorage));
  return true;
}

export function setCachedWorkspaceHubValue<T>(
  bucket: string,
  workspaceId: string | null | undefined,
  value: T,
) {
  if (!workspaceId) {
    return;
  }

  const cloned = cloneValue(value);
  workspaceHubCache.set(getCacheId(bucket, workspaceId), cloned);
  writeStorageEntry(bucket, workspaceId, cloned);
}

export function clearWorkspaceHubCache(
  bucket?: string | null,
  workspaceId?: string | null,
) {
  if (bucket && workspaceId) {
    workspaceHubCache.delete(getCacheId(bucket, workspaceId));
    removeStorageEntry(bucket, workspaceId);
    return;
  }

  if (bucket) {
    for (const key of Array.from(workspaceHubCache.keys())) {
      if (key.startsWith(`${bucket}:`)) {
        workspaceHubCache.delete(key);
      }
    }
  } else {
    workspaceHubCache.clear();
  }

  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  const keysToRemove: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key) continue;
      const isHubKey =
        key.startsWith(`${WORKSPACE_HUB_CACHE_KEY_PREFIX}:`) ||
        key.startsWith(`${WORKSPACE_HUB_CACHE_TIMESTAMP_PREFIX}:`);
      if (!isHubKey) continue;
      if (bucket && !key.includes(`:${bucket}:`)) continue;
      keysToRemove.push(key);
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
