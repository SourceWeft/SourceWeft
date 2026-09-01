import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  key: (index: number) => string | null;
  readonly length: number;
};

function createMemoryStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
  };
}

function createThrowingStorage(): StorageLike {
  return {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
    removeItem() {
      throw new Error("storage unavailable");
    },
    clear() {
      throw new Error("storage unavailable");
    },
    key() {
      throw new Error("storage unavailable");
    },
    get length(): number {
      throw new Error("storage unavailable");
    },
  };
}

function installWindow(sessionStorage: StorageLike) {
  vi.stubGlobal("window", { sessionStorage });
}

async function loadCacheModule() {
  vi.resetModules();
  return await import("./workspace-hub-cache");
}

const sampleValue = {
  cursor: "next",
  items: [
    { id: "a", title: "Alpha" },
    { id: "b", title: "Beta" },
  ],
};

let sessionStorageMock: StorageLike;

beforeEach(() => {
  sessionStorageMock = createMemoryStorage();
  installWindow(sessionStorageMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("workspace-hub-cache", () => {
  it("round-trips bucketed workspace values", async () => {
    const cache = await loadCacheModule();

    cache.setCachedWorkspaceHubValue("artifacts", "workspace-1", sampleValue);

    const retrieved = cache.getCachedWorkspaceHubValue(
      "artifacts",
      "workspace-1",
    );
    expect(retrieved).toEqual(sampleValue);
    expect(retrieved).not.toBe(sampleValue);
    expect(
      cache.getCachedWorkspaceHubValue("connectors", "workspace-1"),
    ).toBeNull();
    expect(
      cache.getCachedWorkspaceHubValue("artifacts", "workspace-2"),
    ).toBeNull();
  });

  it("hydrates from sessionStorage after module reload", async () => {
    const beforeReload = await loadCacheModule();
    beforeReload.setCachedWorkspaceHubValue("mcp", "workspace-1", sampleValue);

    const afterReload = await loadCacheModule();

    expect(
      afterReload.getCachedWorkspaceHubValue("mcp", "workspace-1"),
    ).toEqual(sampleValue);
  });

  it("treats expired cache entries as misses and cleans them up", async () => {
    const cache = await loadCacheModule();
    const dataKey = `${cache.WORKSPACE_HUB_CACHE_KEY_PREFIX}:${cache.WORKSPACE_HUB_CACHE_VERSION}:artifacts:workspace-1`;
    const timestampKey = `${cache.WORKSPACE_HUB_CACHE_TIMESTAMP_PREFIX}:${cache.WORKSPACE_HUB_CACHE_VERSION}:artifacts:workspace-1`;
    sessionStorageMock.setItem(
      dataKey,
      JSON.stringify({
        version: cache.WORKSPACE_HUB_CACHE_VERSION,
        value: sampleValue,
      }),
    );
    sessionStorageMock.setItem(
      timestampKey,
      JSON.stringify(Date.now() - (cache.WORKSPACE_HUB_CACHE_TTL_MS + 1_000)),
    );

    expect(
      cache.getCachedWorkspaceHubValue("artifacts", "workspace-1"),
    ).toBeNull();
    expect(sessionStorageMock.getItem(dataKey)).toBeNull();
    expect(sessionStorageMock.getItem(timestampKey)).toBeNull();
  });

  it("clears a single bucket and preserves unrelated entries", async () => {
    const cache = await loadCacheModule();
    cache.setCachedWorkspaceHubValue("artifacts", "workspace-1", sampleValue);
    cache.setCachedWorkspaceHubValue("connectors", "workspace-1", sampleValue);

    cache.clearWorkspaceHubCache("artifacts", "workspace-1");

    expect(
      cache.getCachedWorkspaceHubValue("artifacts", "workspace-1"),
    ).toBeNull();
    expect(
      cache.getCachedWorkspaceHubValue("connectors", "workspace-1"),
    ).toEqual(sampleValue);
  });

  it("clears all entries in one bucket", async () => {
    const cache = await loadCacheModule();
    cache.setCachedWorkspaceHubValue("artifacts", "workspace-1", sampleValue);
    cache.setCachedWorkspaceHubValue("artifacts", "workspace-2", sampleValue);
    cache.setCachedWorkspaceHubValue("mcp", "workspace-1", sampleValue);

    cache.clearWorkspaceHubCache("artifacts");

    expect(
      cache.getCachedWorkspaceHubValue("artifacts", "workspace-1"),
    ).toBeNull();
    expect(
      cache.getCachedWorkspaceHubValue("artifacts", "workspace-2"),
    ).toBeNull();
    expect(cache.getCachedWorkspaceHubValue("mcp", "workspace-1")).toEqual(
      sampleValue,
    );
  });

  it("falls back gracefully when sessionStorage throws", async () => {
    installWindow(createThrowingStorage());
    const cache = await loadCacheModule();

    expect(() =>
      cache.setCachedWorkspaceHubValue("artifacts", "workspace-1", sampleValue),
    ).not.toThrow();
    expect(
      cache.getCachedWorkspaceHubValue("artifacts", "workspace-1"),
    ).toEqual(sampleValue);

    const freshCache = await loadCacheModule();
    expect(
      freshCache.getCachedWorkspaceHubValue("artifacts", "workspace-1"),
    ).toBeNull();
    expect(() => freshCache.clearWorkspaceHubCache()).not.toThrow();
  });
});
