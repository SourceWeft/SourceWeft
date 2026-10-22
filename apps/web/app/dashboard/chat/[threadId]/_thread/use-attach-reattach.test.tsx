// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mount, unmountAll } from "@/test/react";
import type { ActiveThreadRun } from "../chat-stream-runner-control";
import { useAttachReattach } from "./use-attach-reattach";
import type { ThreadMessagesLoadResult } from "./use-thread-messages";

const mocks = vi.hoisted(() => ({
  getActiveThreadRun: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { getActiveThreadRun: mocks.getActiveThreadRun },
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

const activeRun: ActiveThreadRun = {
  idempotencyKey: "run-key",
  status: "running",
  userId: "user-1",
};
const activeThreadRunRef: { current: ActiveThreadRun | null } = {
  current: null,
};
const deps = {
  loadThreadMessages: vi.fn<() => Promise<ThreadMessagesLoadResult>>(),
  markRunStopped: vi.fn<(runKey: string) => void>(),
  stopRunStreaming: vi.fn<() => Promise<void>>(),
};
let latest: ReturnType<typeof useAttachReattach>;

function Harness({ threadId }: { threadId: string }) {
  latest = useAttachReattach({
    ...deps,
    activeThreadRunRef,
    displayStreamError: (error) =>
      error instanceof Error ? error.message : "error",
    threadId,
    workspaceId: "workspace-1",
  });
  return null;
}

async function failAttach() {
  await act(async () => {
    latest.attachReattach.handleAttachFailure(
      "run-key",
      new TypeError("network error"),
    );
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  activeThreadRunRef.current = activeRun;
  mocks.getActiveThreadRun
    .mockReset()
    .mockResolvedValue({ threadRun: activeRun, latestFailure: null });
  mocks.toastError.mockReset();
  deps.loadThreadMessages.mockReset().mockResolvedValue("loaded");
  deps.markRunStopped.mockReset();
  deps.stopRunStreaming.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

test("the same active run is re-attached through the reload path", async () => {
  await mount(createElement(Harness, { threadId: "thread-1" }));
  await failAttach();
  await advance(1_000);

  assert.deepEqual(mocks.getActiveThreadRun.mock.calls, [
    ["workspace-1", "thread-1"],
  ]);
  assert.equal(deps.loadThreadMessages.mock.calls.length, 1);
  assert.equal(deps.markRunStopped.mock.calls.length, 0);
});

test("an ended run is settled: cleared, reloaded, not retried", async () => {
  mocks.getActiveThreadRun.mockResolvedValue({
    threadRun: null,
    latestFailure: null,
  });
  await mount(createElement(Harness, { threadId: "thread-1" }));
  await failAttach();
  await advance(10_000);

  assert.deepEqual(deps.markRunStopped.mock.calls, [["run-key"]]);
  assert.equal(deps.loadThreadMessages.mock.calls.length, 1);
  assert.equal(mocks.getActiveThreadRun.mock.calls.length, 1);
});

test("a reload that fails counts as an attempt and gives up at the cap", async () => {
  deps.loadThreadMessages.mockResolvedValue("failed");
  await mount(createElement(Harness, { threadId: "thread-1" }));
  await failAttach();
  await advance(1_000);
  assert.equal(deps.loadThreadMessages.mock.calls.length, 1);
  await advance(2_000);
  assert.equal(deps.loadThreadMessages.mock.calls.length, 2);
  await advance(60_000);

  assert.equal(deps.loadThreadMessages.mock.calls.length, 4);
  assert.deepEqual(mocks.toastError.mock.calls, [["network error"]]);
});

test("a user Stop cancels a pending re-attach", async () => {
  await mount(createElement(Harness, { threadId: "thread-1" }));
  await failAttach();
  await act(async () => {
    await latest.handleStopStreaming();
  });
  await advance(10_000);

  assert.equal(deps.stopRunStreaming.mock.calls.length, 1);
  assert.equal(mocks.getActiveThreadRun.mock.calls.length, 0);
  assert.equal(deps.loadThreadMessages.mock.calls.length, 0);
});

test("a thread switch cancels a pending re-attach", async () => {
  const handle = await mount(createElement(Harness, { threadId: "thread-1" }));
  await failAttach();
  await handle.render(createElement(Harness, { threadId: "thread-2" }));
  await advance(10_000);

  assert.equal(mocks.getActiveThreadRun.mock.calls.length, 0);
  assert.equal(deps.loadThreadMessages.mock.calls.length, 0);
});

test("unmount cancels a pending re-attach", async () => {
  const handle = await mount(createElement(Harness, { threadId: "thread-1" }));
  await failAttach();
  await handle.unmount();
  await vi.advanceTimersByTimeAsync(10_000);

  assert.equal(mocks.getActiveThreadRun.mock.calls.length, 0);
});
