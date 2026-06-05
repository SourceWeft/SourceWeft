import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceItem } from "./source-types";

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

function installWindow(sessionStorage: StorageLike, localStorage: StorageLike) {
  vi.stubGlobal("window", {
    sessionStorage,
    localStorage,
  });
}

async function loadCacheModule() {
  vi.resetModules();
  return await import("./source-library-cache");
}

function source(
  input: Partial<SourceItem> & Pick<SourceItem, "id" | "title">,
): SourceItem {
  return {
    contentText: "",
    meta: input.meta ?? "Updated today",
    parentSourceId: input.parentSourceId ?? null,
    sourceType: input.sourceType ?? "note",
    status: input.status ?? "Indexed",
    type: input.type ?? "TEXT",
    ...input,
  } satisfies SourceItem;
}

const sampleSources: SourceItem[] = [
  source({ id: "a", title: "Alpha" }),
  source({ id: "b", title: "Beta", parentSourceId: "a" }),
];

let sessionStorageMock: StorageLike;
let localStorageMock: StorageLike;

beforeEach(() => {
  sessionStorageMock = createMemoryStorage();
  localStorageMock = createMemoryStorage();
  installWindow(sessionStorageMock, localStorageMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("source-library-cache", () => {
  it("round-trips data through set and get for the same workspace", async () => {
    const cache = await loadCacheModule();
    cache.setCachedWorkspaceSources("workspace-1", sampleSources);

    const retrieved = cache.getCachedWorkspaceSources("workspace-1");

    expect(retrieved).toEqual(sampleSources);
    expect(retrieved).not.toBe(sampleSources);
    expect(cache.hasCachedWorkspaceSources("workspace-1")).toBe(true);
  });

  it("returns null from get for an unknown workspace", async () => {
    const cache = await loadCacheModule();

    expect(cache.getCachedWorkspaceSources("missing")).toBeNull();
    expect(cache.getCachedWorkspaceSources(null)).toBeNull();
    expect(cache.getCachedWorkspaceSources(undefined)).toBeNull();
  });

  it("returns false from has for an unknown workspace", async () => {
    const cache = await loadCacheModule();

    expect(cache.hasCachedWorkspaceSources("missing")).toBe(false);
    expect(cache.hasCachedWorkspaceSources(null)).toBe(false);
    expect(cache.hasCachedWorkspaceSources(undefined)).toBe(false);
  });

  it("recovers cached data from sessionStorage after the in-memory cache is wiped", async () => {
    const cacheBeforeWipe = await loadCacheModule();
    cacheBeforeWipe.setCachedWorkspaceSources("workspace-1", sampleSources);

    const cacheAfterWipe = await loadCacheModule();

    expect(cacheAfterWipe.hasCachedWorkspaceSources("workspace-1")).toBe(true);
    expect(cacheAfterWipe.getCachedWorkspaceSources("workspace-1")).toEqual(
      sampleSources,
    );
  });

  it("treats a version mismatch in sessionStorage as a miss and cleans up", async () => {
    const cache = await loadCacheModule();
    const dataKey = `${cache.CACHE_KEY_PREFIX}:${cache.CACHE_VERSION}:workspace-1`;
    const timestampKey = `${cache.CACHE_TIMESTAMP_PREFIX}:${cache.CACHE_VERSION}:workspace-1`;

    sessionStorageMock.setItem(
      dataKey,
      JSON.stringify({ version: "old", sources: sampleSources }),
    );
    sessionStorageMock.setItem(timestampKey, JSON.stringify(Date.now()));

    expect(cache.getCachedWorkspaceSources("workspace-1")).toBeNull();
    expect(sessionStorageMock.getItem(dataKey)).toBeNull();
    expect(sessionStorageMock.getItem(timestampKey)).toBeNull();
  });

  it("treats an expired timestamp in sessionStorage as a miss and cleans up", async () => {
    const cache = await loadCacheModule();
    const dataKey = `${cache.CACHE_KEY_PREFIX}:${cache.CACHE_VERSION}:workspace-1`;
    const timestampKey = `${cache.CACHE_TIMESTAMP_PREFIX}:${cache.CACHE_VERSION}:workspace-1`;
    const expiredTimestamp = Date.now() - (cache.CACHE_TTL_MS + 1_000);

    sessionStorageMock.setItem(
      dataKey,
      JSON.stringify({
        version: cache.CACHE_VERSION,
        sources: sampleSources,
      }),
    );
    sessionStorageMock.setItem(
      timestampKey,
      JSON.stringify(expiredTimestamp),
    );

    expect(cache.getCachedWorkspaceSources("workspace-1")).toBeNull();
    expect(sessionStorageMock.getItem(dataKey)).toBeNull();
    expect(sessionStorageMock.getItem(timestampKey)).toBeNull();
  });

  it("clears entries for a single workspace from memory and sessionStorage", async () => {
    const cache = await loadCacheModule();
    cache.setCachedWorkspaceSources("workspace-1", sampleSources);
    cache.setCachedWorkspaceSources("workspace-2", sampleSources);

    cache.clearWorkspaceSourceCache("workspace-1");

    expect(cache.getCachedWorkspaceSources("workspace-1")).toBeNull();
    expect(cache.hasCachedWorkspaceSources("workspace-1")).toBe(false);
    expect(
      sessionStorageMock.getItem(
        `${cache.CACHE_KEY_PREFIX}:${cache.CACHE_VERSION}:workspace-1`,
      ),
    ).toBeNull();
    expect(
      sessionStorageMock.getItem(
        `${cache.CACHE_TIMESTAMP_PREFIX}:${cache.CACHE_VERSION}:workspace-1`,
      ),
    ).toBeNull();

    expect(cache.getCachedWorkspaceSources("workspace-2")).toEqual(
      sampleSources,
    );
  });

  it("clears all workspace entries from memory and sessionStorage when no id is provided", async () => {
    const cache = await loadCacheModule();
    cache.setCachedWorkspaceSources("workspace-1", sampleSources);
    cache.setCachedWorkspaceSources("workspace-2", sampleSources);
    sessionStorageMock.setItem("unrelated-key", "keep-me");

    cache.clearWorkspaceSourceCache();

    expect(cache.getCachedWorkspaceSources("workspace-1")).toBeNull();
    expect(cache.getCachedWorkspaceSources("workspace-2")).toBeNull();
    expect(sessionStorageMock.getItem("unrelated-key")).toBe("keep-me");

    for (let index = 0; index < sessionStorageMock.length; index += 1) {
      const key = sessionStorageMock.key(index);
      expect(key).not.toMatch(new RegExp(`^${cache.CACHE_KEY_PREFIX}:`));
      expect(key).not.toMatch(
        new RegExp(`^${cache.CACHE_TIMESTAMP_PREFIX}:`),
      );
    }
  });

  it("falls back gracefully when sessionStorage throws on read or write", async () => {
    const throwingStorage = createThrowingStorage();
    installWindow(throwingStorage, localStorageMock);

    const cache = await loadCacheModule();

    expect(() =>
      cache.setCachedWorkspaceSources("workspace-1", sampleSources),
    ).not.toThrow();

    expect(cache.getCachedWorkspaceSources("workspace-1")).toEqual(
      sampleSources,
    );

    const freshCache = await loadCacheModule();
    expect(freshCache.getCachedWorkspaceSources("workspace-1")).toBeNull();
    expect(freshCache.hasCachedWorkspaceSources("workspace-1")).toBe(false);

    expect(() => freshCache.clearWorkspaceSourceCache()).not.toThrow();
    expect(() =>
      freshCache.clearWorkspaceSourceCache("workspace-1"),
    ).not.toThrow();
  });
});
