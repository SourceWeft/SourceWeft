// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createLocalConversationStore } from "./local-conversation-store";
import type { ExecutionInfo } from "./local-execution";
const online: ExecutionInfo = {
  executionTarget: { kind: "local", deviceId: "pc" },
  workingDirectory: "/task",
  target: { name: "Mac", deviceId: "pc", online: true },
  availability: { ready: true, message: null, code: null },
};
afterEach(() => vi.useRealTimers());
test("cloud conversations remain independent of PC status after discovery", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue({
    executionTarget: { kind: "cloud" },
    workingDirectory: null,
    target: null,
  });
  const store = createLocalConversationStore(read);
  const stop = store.subscribe(() => {});
  await store.refresh();
  read.mockRejectedValue(new Error("PC service unavailable"));
  store.invalidate();
  await vi.advanceTimersByTimeAsync(6000);
  expect(store.getSnapshot().ready).toBe(true);
  expect(read).toHaveBeenCalledOnce();
  stop();
});
test("subscribers share polling; offline and recovery update everyone without replaying actions", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(online);
  const store = createLocalConversationStore(read);
  const first = vi.fn(),
    second = vi.fn();
  const stop1 = store.subscribe(first),
    stop2 = store.subscribe(second);
  await store.refresh();
  expect(read).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().ready).toBe(true);
  read.mockRejectedValue(new TypeError("Network unavailable"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(store.getSnapshot()).toMatchObject({
    ready: false,
    info: online,
    message: "Network unavailable",
  });
  read.mockResolvedValue(online);
  await vi.advanceTimersByTimeAsync(3000);
  expect(store.getSnapshot().ready).toBe(true);
  expect(first.mock.calls.length).toBe(second.mock.calls.length);
  stop1();
  stop2();
  await vi.advanceTimersByTimeAsync(6000);
  expect(read).toHaveBeenCalledTimes(3);
});
test("an invalidation or scope teardown discards late success", async () => {
  let resolve!: (value: ExecutionInfo) => void;
  const store = createLocalConversationStore(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const stop = store.subscribe(() => {});
  const pending = store.refresh();
  store.invalidate();
  resolve(online);
  await pending;
  expect(store.getSnapshot().ready).toBe(false);
  const next = store.refresh();
  stop();
  resolve(online);
  await next;
  expect(store.getSnapshot().ready).toBe(false);
});
test("online alone cannot authorize a browser, and a file error does not imply offline", async () => {
  const read = vi.fn().mockResolvedValue({
    ...online,
    availability: {
      ready: false,
      code: "REMOTE_ACCESS_DISABLED",
      message: "Enable access on the computer.",
    },
  });
  const store = createLocalConversationStore(read);
  await store.refresh();
  expect(store.getSnapshot()).toMatchObject({
    ready: false,
    code: "REMOTE_ACCESS_DISABLED",
  });
  const { reportLocalAvailabilityError, subscribeLocalAvailabilityErrors } =
    await import("./local-availability-events");
  const listener = vi.fn();
  const stop = subscribeLocalAvailabilityErrors(listener);
  reportLocalAvailabilityError("/files", { code: "BINARY_FILE" });
  expect(listener).not.toHaveBeenCalled();
  reportLocalAvailabilityError("/files", { code: "DEVICE_OFFLINE" });
  expect(listener).toHaveBeenCalledOnce();
  stop();
});
