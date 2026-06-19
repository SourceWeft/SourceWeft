import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingThreadTurn } from "./pending-thread-turn";

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
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
  };
}

function installWindow(sessionStorage: StorageLike) {
  vi.stubGlobal("window", {
    sessionStorage,
  });
}

async function loadPendingTurnModule() {
  vi.resetModules();
  return await import("./pending-thread-turn");
}

const pendingTurn = {
  composerOptions: {
    capabilityOptionOverrides: {},
    capabilityToolEnabledOverrides: {},
    skillOptionOverrides: {
      "builtin:ppt-deck": {
        slideCount: 6,
      },
    },
  },
  content: "hello",
  searchEnabled: true,
  sourceIds: ["source-1"],
} satisfies PendingThreadTurn;

let sessionStorageMock: StorageLike;

beforeEach(() => {
  sessionStorageMock = createMemoryStorage();
  installWindow(sessionStorageMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("pending-thread-turn", () => {
  it("reads a pending turn without consuming it", async () => {
    const pendingTurns = await loadPendingTurnModule();
    pendingTurns.setPendingThreadTurn("thread-1", pendingTurn);

    expect(pendingTurns.readPendingThreadTurn("thread-1")).toEqual(pendingTurn);
    expect(pendingTurns.readPendingThreadTurn("thread-1")).toEqual(pendingTurn);
  });

  it("consumes a pending turn only when explicitly requested", async () => {
    const pendingTurns = await loadPendingTurnModule();
    pendingTurns.setPendingThreadTurn("thread-1", pendingTurn);

    expect(pendingTurns.consumePendingThreadTurn("thread-1")).toEqual(
      pendingTurn,
    );
    expect(pendingTurns.readPendingThreadTurn("thread-1")).toBeNull();
  });

  it("keeps the sessionStorage fallback until the pending turn is cleared", async () => {
    const pendingTurns = await loadPendingTurnModule();
    pendingTurns.writePendingThreadTurnFallback("thread-1", pendingTurn);

    expect(pendingTurns.readPendingThreadTurn("thread-1")).toEqual(pendingTurn);
    expect(sessionStorageMock.getItem("chat:pending:thread-1")).not.toBeNull();

    pendingTurns.clearPendingThreadTurn("thread-1");

    expect(pendingTurns.readPendingThreadTurn("thread-1")).toBeNull();
    expect(sessionStorageMock.getItem("chat:pending:thread-1")).toBeNull();
  });
});
