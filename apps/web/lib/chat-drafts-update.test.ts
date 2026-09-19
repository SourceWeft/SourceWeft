// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";

function database() {
  let fail = false;
  const pending: Array<() => void> = [];
  const db = {
    transaction: () => {
      const request = { result: undefined };
      const tx = {
        error: new Error("Disk full"),
        oncomplete: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined,
        objectStore: () => ({
          put: () => request,
          get: () => request,
          delete: () => request,
        }),
      };
      pending.push(() => (fail ? tx.onerror?.() : tx.oncomplete?.()));
      return tx;
    },
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = {
        result: db,
        onsuccess: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  return {
    fail: (value: boolean) => {
      fail = value;
    },
    async finish() {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!();
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
test("update save waits for the actual draft transaction", async () => {
  const db = database();
  const drafts = await import("./chat-drafts");
  const write = drafts.writeChatDraft("thread", "unsaved", []);
  let finished = false;
  const flush = drafts.flushChatDrafts().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  await db.finish();
  await write;
  await flush;
  expect(finished).toBe(true);
});
test("failed save blocks update until a successful write; reading cannot hide failure", async () => {
  const db = database();
  const drafts = await import("./chat-drafts");
  db.fail(true);
  const write = drafts.writeChatDraft("thread", "unsaved", []).catch((e) => e);
  await db.finish();
  await write;
  await expect(drafts.flushChatDrafts()).rejects.toThrow("Disk full");
  db.fail(false);
  const read = drafts.readChatDraft("thread");
  await db.finish();
  await read;
  await expect(drafts.flushChatDrafts()).rejects.toThrow("Disk full");
  const repaired = drafts.writeChatDraft("thread", "saved", []);
  await db.finish();
  await repaired;
  await expect(drafts.flushChatDrafts()).resolves.toBeUndefined();
});
