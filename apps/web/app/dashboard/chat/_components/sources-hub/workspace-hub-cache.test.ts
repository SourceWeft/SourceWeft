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

  it("reports a hit from has after a set", async () => {
    const cache = await loadCacheModule();
    cache.setCachedWorkspaceHubValue("sources", "workspace-1", sampleValue);

    expect(cache.hasCachedWorkspaceHubValue("sources", "workspace-1")).toBe(
      true,
    );
    expect(cache.hasCachedWorkspaceHubValue("sources", "workspace-2")).toBe(
      false,
    );
    expect(cache.hasCachedWorkspaceHubValue("artifacts", "workspace-1")).toBe(
      false,
    );
  });

  it("returns null from get for a missing workspace id", async () => {
    const cache = await loadCacheModule();

    expect(cache.getCachedWorkspaceHubValue("sources", "missing")).toBeNull();
    expect(cache.getCachedWorkspaceHubValue("sources", null)).toBeNull();
    expect(cache.getCachedWorkspaceHubValue("sources", undefined)).toBeNull();
  });

  it("returns false from has for a missing workspace id", async () => {
    const cache = await loadCacheModule();

    expect(cache.hasCachedWorkspaceHubValue("sources", "missing")).toBe(false);
    expect(cache.hasCachedWorkspaceHubValue("sources", null)).toBe(false);
    expect(cache.hasCachedWorkspaceHubValue("sources", undefined)).toBe(false);
  });

  it("reports a hit from has after the in-memory cache is wiped", async () => {
    const beforeReload = await loadCacheModule();
    beforeReload.setCachedWorkspaceHubValue(
      "sources",
      "workspace-1",
      sampleValue,
    );

    const afterReload = await loadCacheModule();

    expect(
      afterReload.hasCachedWorkspaceHubValue("sources", "workspace-1"),
    ).toBe(true);
    expect(
      afterReload.getCachedWorkspaceHubValue("sources", "workspace-1"),
    ).toEqual(sampleValue);
  });

  it("treats a version mismatch in sessionStorage as a miss and cleans up", async () => {
    const cache = await loadCacheModule();
    const dataKey = `${cache.WORKSPACE_HUB_CACHE_KEY_PREFIX}:${cache.WORKSPACE_HUB_CACHE_VERSION}:sources:workspace-1`;
    const timestampKey = `${cache.WORKSPACE_HUB_CACHE_TIMESTAMP_PREFIX}:${cache.WORKSPACE_HUB_CACHE_VERSION}:sources:workspace-1`;

    sessionStorageMock.setItem(
      dataKey,
      JSON.stringify({ version: "old", value: sampleValue }),
    );
    sessionStorageMock.setItem(timestampKey, JSON.stringify(Date.now()));

    expect(
      cache.getCachedWorkspaceHubValue("sources", "workspace-1"),
    ).toBeNull();
    expect(sessionStorageMock.getItem(dataKey)).toBeNull();
    expect(sessionStorageMock.getItem(timestampKey)).toBeNull();
  });

  it("clears one workspace in a bucket and preserves the other workspaces", async () => {
    const cache = await loadCacheModule();
    cache.setCachedWorkspaceHubValue("sources", "workspace-1", sampleValue);
    cache.setCachedWorkspaceHubValue("sources", "workspace-2", sampleValue);

    cache.clearWorkspaceHubCache("sources", "workspace-1");

    expect(
      cache.getCachedWorkspaceHubValue("sources", "workspace-1"),
    ).toBeNull();
    expect(cache.hasCachedWorkspaceHubValue("sources", "workspace-1")).toBe(
      false,
    );
    expect(
      sessionStorageMock.getItem(
        `${cache.WORKSPACE_HUB_CACHE_KEY_PREFIX}:${cache.WORKSPACE_HUB_CACHE_VERSION}:sources:workspace-1`,
      ),
    ).toBeNull();
    expect(
      sessionStorageMock.getItem(
        `${cache.WORKSPACE_HUB_CACHE_TIMESTAMP_PREFIX}:${cache.WORKSPACE_HUB_CACHE_VERSION}:sources:workspace-1`,
      ),
    ).toBeNull();

    expect(cache.getCachedWorkspaceHubValue("sources", "workspace-2")).toEqual(
      sampleValue,
    );
  });

  it("clears every bucket from memory and sessionStorage when no bucket is provided", async () => {
    const cache = await loadCacheModule();
    cache.setCachedWorkspaceHubValue("sources", "workspace-1", sampleValue);
    cache.setCachedWorkspaceHubValue("artifacts", "workspace-2", sampleValue);
    sessionStorageMock.setItem("unrelated-key", "keep-me");

    cache.clearWorkspaceHubCache();

    expect(
      cache.getCachedWorkspaceHubValue("sources", "workspace-1"),
    ).toBeNull();
    expect(
      cache.getCachedWorkspaceHubValue("artifacts", "workspace-2"),
    ).toBeNull();
    expect(sessionStorageMock.getItem("unrelated-key")).toBe("keep-me");

    for (let index = 0; index < sessionStorageMock.length; index += 1) {
      const key = sessionStorageMock.key(index);
      expect(key).not.toMatch(
        new RegExp(`^${cache.WORKSPACE_HUB_CACHE_KEY_PREFIX}:`),
      );
      expect(key).not.toMatch(
        new RegExp(`^${cache.WORKSPACE_HUB_CACHE_TIMESTAMP_PREFIX}:`),
      );
    }
  });

  it("keeps has false and clears safely when sessionStorage throws", async () => {
    installWindow(createThrowingStorage());
    const cache = await loadCacheModule();

    cache.setCachedWorkspaceHubValue("sources", "workspace-1", sampleValue);
    expect(cache.hasCachedWorkspaceHubValue("sources", "workspace-1")).toBe(
      true,
    );

    const freshCache = await loadCacheModule();
    expect(
      freshCache.hasCachedWorkspaceHubValue("sources", "workspace-1"),
    ).toBe(false);
    expect(() =>
      freshCache.clearWorkspaceHubCache("sources", "workspace-1"),
    ).not.toThrow();
  });
});
