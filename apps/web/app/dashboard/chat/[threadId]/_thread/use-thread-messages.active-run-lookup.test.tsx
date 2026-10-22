// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { HttpClientError } from "@sourceweft/sdk";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mountWithIntl, unmountAll, withIntl } from "@/test/react";
import {
  resolveComposerRunControl,
  useChatStreamRunnerControl,
  type ComposerRunControl,
} from "../chat-stream-runner-control";
import { useThreadMessages } from "./use-thread-messages";
import type { ThreadStreamActionInput } from "./use-thread-stream-action";

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
vi.mock("@/lib/stop-thread-run", () => ({
  requestThreadRunStop: vi.fn(),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const runningRun = {
  id: "run-1",
  idempotencyKey: "run-key",
  status: "running" as const,
  mode: "send" as const,
  userId: "user-1",
  userMessageId: null,
  assistantMessageId: null,
};

let latest: {
  runner: ReturnType<typeof useChatStreamRunnerControl>;
  messages: ReturnType<typeof useThreadMessages>;
  control: ComposerRunControl;
};
// Every composer state rendered, in order: proves no Send flashes in between.
let rendered: ComposerRunControl[] = [];
const streamThreadAction = vi.fn<(input: ThreadStreamActionInput) => void>();

// The page's own pairing: the runner owns the active run, the messages hook
// owns the lookup, and the composer control is resolved from both exactly as
// ChatCanvas does for a member's own (non-other-member) run.
function Harness({ threadId = "thread-1" }: { threadId?: string }) {
  const runner = useChatStreamRunnerControl({
    getDisplayErrorMessage: () => "error",
    threadId,
    throwStreamRequestError: async () => {
      throw new Error("request failed");
    },
    workspaceId: "workspace-1",
  });
  const messages = useThreadMessages({
    activeThreadRunRef: runner.activeThreadRunRef,
    attachedRunKeyRef: runner.attachedRunKeyRef,
    clearTerminalLocalRunState: runner.clearTerminalLocalRunState,
    setActiveThreadRun: runner.setActiveThreadRun,
    streamThreadActionRef: {
      current: async (input) => {
        streamThreadAction(input);
      },
    },
    threadId,
    workspaceId: "workspace-1",
  });
  const control = resolveComposerRunControl({
    activeRunLookupPending: messages.isActiveRunLookupPending,
    chatExecutionState: runner.chatExecutionState,
    otherUserRunActive: false,
  });
  latest = { runner, messages, control };
  if (rendered.at(-1) !== control) rendered.push(control);
  return null;
}

beforeEach(() => {
  rendered = [];
  streamThreadAction.mockReset();
  mocks.list.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  mocks.active
    .mockReset()
    .mockResolvedValue({ threadRun: null, latestFailure: null });
});
afterEach(unmountAll);

test("before the active-run lookup resolves the composer holds a pending Stop", async () => {
  const lookup = deferred<{ threadRun: null; latestFailure: null }>();
  mocks.active.mockReturnValue(lookup.promise);
  await mountWithIntl(createElement(Harness));
  // First paint, before any load has even started.
  assert.equal(latest.messages.isActiveRunLookupPending, true);
  assert.equal(latest.control, "pending-stop");

  let load!: Promise<void>;
  await act(async () => {
    load = latest.messages.loadThreadMessages();
  });
  assert.equal(latest.control, "pending-stop");

  await act(async () => {
    lookup.resolve({ threadRun: null, latestFailure: null });
    await load;
  });
  assert.equal(latest.messages.isActiveRunLookupPending, false);
});

test("a lookup that finds an active run goes straight from pending Stop to Stop", async () => {
  mocks.active.mockResolvedValue({
    threadRun: runningRun,
    latestFailure: null,
  });
  await mountWithIntl(createElement(Harness));
  await act(async () => latest.messages.loadThreadMessages());

  assert.equal(latest.runner.activeThreadRun?.idempotencyKey, "run-key");
  assert.equal(latest.control, "stop");
  assert.deepEqual(rendered, ["pending-stop", "stop"]);
  // The reload attach still starts for the running run.
  assert.equal(streamThreadAction.mock.calls[0]?.[0].durableRunKey, "run-key");
});

test("a lookup that finds no active run shows Send", async () => {
  await mountWithIntl(createElement(Harness));
  await act(async () => latest.messages.loadThreadMessages());

  assert.equal(latest.runner.activeThreadRun, null);
  assert.equal(latest.control, "send");
  assert.deepEqual(rendered, ["pending-stop", "send"]);
});

test("a failed load settles instead of leaving the composer blocked", async () => {
  mocks.active.mockRejectedValue(
    new HttpClientError({
      message: "Forbidden",
      status: 403,
      statusText: "Forbidden",
      code: "FORBIDDEN",
    }),
  );
  await mountWithIntl(createElement(Harness));
  let result: string | undefined;
  await act(async () => {
    result = await latest.messages.loadThreadMessagesWithResult();
  });

  assert.equal(result, "failed");
  assert.equal(latest.messages.isActiveRunLookupPending, false);
  assert.equal(latest.control, "send");
});

test("a superseded load keeps the pending Stop until the newer load settles", async () => {
  const first = deferred<{ threadRun: null; latestFailure: null }>();
  const second = deferred<{
    threadRun: typeof runningRun;
    latestFailure: null;
  }>();
  mocks.active
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await mountWithIntl(createElement(Harness));

  let firstLoad!: Promise<string>;
  let secondLoad!: Promise<string>;
  await act(async () => {
    firstLoad = latest.messages.loadThreadMessagesWithResult();
    secondLoad = latest.messages.loadThreadMessagesWithResult();
  });
  await act(async () => {
    first.resolve({ threadRun: null, latestFailure: null });
    assert.equal(await firstLoad, "superseded");
  });
  assert.equal(latest.control, "pending-stop");

  await act(async () => {
    second.resolve({ threadRun: runningRun, latestFailure: null });
    assert.equal(await secondLoad, "loaded");
  });
  assert.equal(latest.control, "stop");
  assert.equal(rendered.includes("send"), false);
});

test("switching threads makes the run unknown again, even if the old load lands late", async () => {
  const view = await mountWithIntl(createElement(Harness));
  await act(async () => latest.messages.loadThreadMessages());
  assert.equal(latest.control, "send");

  const oldThreadLookup = deferred<{ threadRun: null; latestFailure: null }>();
  mocks.active.mockReturnValueOnce(oldThreadLookup.promise);
  let oldLoad!: Promise<void>;
  await act(async () => {
    oldLoad = latest.messages.loadThreadMessages();
  });
  await view.render(withIntl(createElement(Harness, { threadId: "thread-2" })));
  assert.equal(latest.control, "pending-stop");

  // The previous thread's lookup settling says nothing about thread-2.
  await act(async () => {
    oldThreadLookup.resolve({ threadRun: null, latestFailure: null });
    await oldLoad;
  });
  assert.equal(latest.control, "pending-stop");

  await act(async () => latest.messages.loadThreadMessages());
  assert.equal(latest.control, "send");
});

test("a run started before the lookup settles (first message just sent) shows Stop at once", async () => {
  const lookup = deferred<{
    threadRun: typeof runningRun;
    latestFailure: null;
  }>();
  mocks.active.mockReturnValue(lookup.promise);
  await mountWithIntl(createElement(Harness));
  assert.equal(latest.control, "pending-stop");

  // A brand-new thread's first turn starts its stream: our own run is known.
  await act(async () => {
    latest.runner.markRunStarted({
      idempotencyKey: "run-key",
      status: "running",
    });
  });
  assert.equal(latest.control, "stop");

  let load!: Promise<void>;
  await act(async () => {
    load = latest.messages.loadThreadMessages();
  });
  await act(async () => {
    lookup.resolve({ threadRun: runningRun, latestFailure: null });
    await load;
  });
  assert.equal(latest.control, "stop");
  assert.equal(rendered.includes("send"), false);
});
