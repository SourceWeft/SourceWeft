// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, test, vi } from "vitest";
import { mount, unmountAll } from "@/test/react";
import { useChatStreamRunnerControl } from "./chat-stream-runner-control";

vi.mock("@/lib/stop-thread-run", () => ({
  requestThreadRunStop: vi.fn(),
}));

let latest: ReturnType<typeof useChatStreamRunnerControl>;

function Harness() {
  latest = useChatStreamRunnerControl({
    getDisplayErrorMessage: () => "error",
    threadId: "thread-1",
    throwStreamRequestError: async () => {
      throw new Error("request failed");
    },
    workspaceId: "workspace-1",
  });
  return null;
}

afterEach(unmountAll);

async function startAttachedRun() {
  await mount(createElement(Harness));
  await act(async () => {
    latest.markRunStarted({
      idempotencyKey: "run-key",
      status: "running",
      userId: "user-1",
    });
    latest.attachedRunKeyRef.current = "run-key";
  });
}

test("an attach failure keeps the active run and releases the attach slot", async () => {
  await startAttachedRun();

  await act(async () => {
    latest.markRunTerminal({
      attachFailed: true,
      detachedWithoutFinish: false,
      durableRunKey: "run-key",
    });
  });

  assert.equal(latest.activeThreadRun?.idempotencyKey, "run-key");
  assert.equal(latest.chatExecutionState, "executing");
  assert.equal(latest.attachedRunKeyRef.current, null);
  assert.equal(latest.isStreaming, false);
});

test("a non-attach stream failure still clears the active run", async () => {
  await startAttachedRun();

  await act(async () => {
    latest.markRunTerminal({
      detachedWithoutFinish: false,
      durableRunKey: "run-key",
    });
  });

  assert.equal(latest.activeThreadRun, null);
  assert.equal(latest.chatExecutionState, "idle");
});

test("settling an ended attached run clears it and its attach slot", async () => {
  await startAttachedRun();

  await act(async () => {
    latest.markRunStopped("run-key");
  });

  assert.equal(latest.activeThreadRun, null);
  assert.equal(latest.attachedRunKeyRef.current, null);
  assert.equal(latest.isStreaming, false);
});
