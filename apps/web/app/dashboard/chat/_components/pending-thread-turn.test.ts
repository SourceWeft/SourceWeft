// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import type { PendingThreadTurn } from "./pending-thread-turn";

const drafts = vi.hoisted(() => ({
  read: vi.fn(),
  clear: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../../lib/chat-drafts", () => ({
  readChatDraft: drafts.read,
  clearChatDraft: drafts.clear,
}));

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

test("image payload and retry identity survive module reload", async () => {
  const first = await loadPendingTurnModule();
  const payload = {
    ...pendingTurn,
    durableRunKey: "stable",
    requiresRetry: true,
    images: [
      { dataUrl: "data:image/png;base64,AA==", mimeType: "image/png" as const },
    ],
  };
  first.writePendingThreadTurnFallback("image-thread", payload);
  const second = await loadPendingTurnModule();
  expect(second.readPendingThreadTurn("image-thread")).toEqual(payload);
});

test("storage failure is explicit so the caller retains the original draft", async () => {
  const mod = await loadPendingTurnModule();
  sessionStorageMock.setItem = () => {
    throw new Error("quota");
  };
  expect(() =>
    mod.writePendingThreadTurnFallback("thread", pendingTurn),
  ).toThrow("Could not save the first message");
});

test("large image metadata restores attachments from the retained IndexedDB draft", async () => {
  const mod = await loadPendingTurnModule();
  const payload = {
    ...pendingTurn,
    imageDraftKey: "retained-draft",
    images: [
      {
        dataUrl: "data:image/png;base64," + "A".repeat(6_000_000),
        mimeType: "image/png" as const,
      },
    ],
  };
  mod.writePendingThreadTurnFallback("image-thread", payload);
  expect(
    sessionStorageMock.getItem("chat:pending:image-thread")!.length,
  ).toBeLessThan(1000);
  drafts.read.mockResolvedValue({
    text: "hello",
    files: [
      {
        id: "image",
        mediaType: "image/png",
        filename: "image.png",
        blob: new Blob(["bytes"], { type: "image/png" }),
      },
    ],
  });
  const restored = await mod.hydratePendingThreadTurn(
    mod.readPendingThreadTurn("image-thread")!,
  );
  expect(restored.images?.[0]?.dataUrl).toBe("data:image/png;base64,Ynl0ZXM=");
  mod.clearPendingThreadTurn("image-thread");
  expect(drafts.clear).toHaveBeenCalledWith("retained-draft");
});

test("missing saved attachments fail instead of silently sending text only", async () => {
  const mod = await loadPendingTurnModule();
  drafts.read.mockResolvedValue(null);
  await expect(
    mod.hydratePendingThreadTurn({ ...pendingTurn, imageDraftKey: "missing" }),
  ).rejects.toThrow("saved attachments are unavailable");
});
