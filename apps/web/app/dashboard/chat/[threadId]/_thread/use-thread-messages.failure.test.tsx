// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ChatErrorNotice } from "../../_components/chat-canvas/chat-error-notice";
import { useThreadMessages } from "./use-thread-messages";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  active: vi.fn(),
  setSnapshot: vi.fn(),
  merge: vi.fn(),
}));
vi.mock("../../../../../lib/sdk", () => ({
  contentClient: {
    listThreadMessages: mocks.list,
    getActiveThreadRun: mocks.active,
  },
}));
vi.mock("../streaming-assistant-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../streaming-assistant-state")>()),
  useStreamingAssistantTransientState: () => ({
    setStreamingAssistantSnapshot: mocks.setSnapshot,
    mergeStreamingAssistantIntoMessages: mocks.merge,
  }),
}));

let latest: ReturnType<typeof useThreadMessages>;
let root: Root;
let container: HTMLDivElement;
const failure = {
  id: "failed-run",
  idempotencyKey: "failed-key",
  errorCode: "MODEL_CONFIG_MISSING",
  errorMessage: "Image model is unavailable",
};
const refs = {
  activeThreadRunRef: { current: null },
  attachedRunKeyRef: { current: null },
  streamThreadActionRef: { current: null },
  clearTerminalLocalRunState: () => {},
  setActiveThreadRun: () => {},
};

function Harness({
  workspaceId = "workspace-1",
  threadId = "thread-1",
}: {
  workspaceId?: string;
  threadId?: string;
}) {
  latest = useThreadMessages({ ...refs, workspaceId, threadId });
  return latest.latestRunFailure
    ? createElement(ChatErrorNotice, {
        title: "Message could not be started",
        code: latest.latestRunFailure.errorCode,
        message: latest.latestRunFailure.errorMessage,
      })
    : null;
}

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  mocks.active
    .mockReset()
    .mockResolvedValue({ threadRun: null, latestFailure: failure });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("reload exposes a persisted early failure without inventing a message", async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => latest.loadThreadMessages());
  assert.equal(latest.messages.length, 0);
  assert.deepEqual(latest.latestRunFailure, failure);
  assert.match(
    container.querySelector('[role="alert"]')?.textContent ?? "",
    /Image model is unavailable/,
  );
  assert.match(container.textContent ?? "", /MODEL_CONFIG_MISSING/);
});

test("the same local error suppresses a duplicate banner, while an older run does not", async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => latest.loadThreadMessages());
  const message = {
    id: "temp-assistant",
    role: "assistant" as const,
    content: "",
    contentJson: {},
    parentMessageId: null,
    createdAt: new Date().toISOString(),
    metadata: {
      isError: true,
      error: failure.errorMessage,
      threadRun: { idempotencyKey: failure.idempotencyKey },
    },
  };
  await act(async () => latest.setMessages([message]));
  assert.equal(latest.latestRunFailure, null);
  await act(async () =>
    latest.setMessages([
      {
        ...message,
        metadata: {
          ...message.metadata,
          threadRun: { idempotencyKey: "older-failed-key" },
        },
      },
    ]),
  );
  assert.deepEqual(latest.latestRunFailure, failure);
  await act(async () => latest.setMessages([]));
  assert.deepEqual(latest.latestRunFailure, failure);
});

test("a new active run and a later clear status remove the old failure", async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => latest.loadThreadMessages());
  mocks.active.mockResolvedValue({
    threadRun: {
      id: "new-run",
      idempotencyKey: "new-key",
      status: "running",
      mode: "send",
      userId: "user",
      userMessageId: null,
      assistantMessageId: null,
    },
    latestFailure: failure,
  });
  await act(async () => latest.loadThreadMessages());
  assert.equal(latest.latestRunFailure, null);
  assert.equal(container.querySelector('[role="alert"]'), null);
  await act(async () => latest.setLatestRunFailure(failure));
  mocks.active.mockResolvedValue({ threadRun: null, latestFailure: null });
  await act(async () => latest.loadThreadMessages());
  assert.equal(latest.latestRunFailure, null);
});

test("switching workspace or thread never flashes the previous failure", async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => latest.loadThreadMessages());
  await act(async () =>
    root.render(createElement(Harness, { workspaceId: "workspace-2" })),
  );
  assert.equal(latest.latestRunFailure, null);
  assert.equal(container.querySelector('[role="alert"]'), null);
  await act(async () => latest.setLatestRunFailure(failure));
  await act(async () =>
    root.render(
      createElement(Harness, {
        workspaceId: "workspace-2",
        threadId: "thread-2",
      }),
    ),
  );
  assert.equal(latest.latestRunFailure, null);
  assert.equal(container.querySelector('[role="alert"]'), null);
});
