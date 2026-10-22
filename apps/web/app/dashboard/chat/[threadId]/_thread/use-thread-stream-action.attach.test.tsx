// @vitest-environment jsdom

import assert from "node:assert/strict";
import { act, createElement } from "react";
import { afterEach, beforeEach, test, vi } from "vitest";
import { mountWithIntl, unmountAll } from "@/test/react";
import type { ChatMessageItem } from "../streaming-assistant-state";
import { throwStreamRequestError } from "./message-normalizers";
import {
  useThreadStreamAction,
  type ThreadStreamActionInput,
} from "./use-thread-stream-action";

const mocks = vi.hoisted(() => ({
  runChatStream: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("../chat-stream-runner", () => ({
  runChatStream: mocks.runChatStream,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("../../../../../lib/sdk", () => ({
  contentClient: { getActiveThreadRun: vi.fn() },
}));
vi.mock("../../_components/local-conversation-status", () => ({
  useLocalConversationStatus: () => ({ ready: true, message: null }),
}));
vi.mock("../../../../../lib/local-availability-events", () => ({
  reportLocalAvailabilityError: vi.fn(),
}));

const assistantMessage: ChatMessageItem = {
  id: "assistant-1",
  role: "assistant",
  content: "partial answer",
  contentJson: {},
  parentMessageId: null,
  createdAt: new Date(0).toISOString(),
  metadata: {
    threadRun: { idempotencyKey: "run-key", status: "running", mode: "send" },
  },
};

let messages: ChatMessageItem[] = [];
const handlers = {
  attachReattach: {
    handleAttachFailure: vi.fn<(runKey: string, error: unknown) => "scheduled">(
      () => "scheduled",
    ),
    noteAttachProgress: vi.fn(),
    noteAttachSucceeded: vi.fn(),
    noteStreamStart: vi.fn(),
  },
  clearAttachedRunKeyIfCurrent: vi.fn(),
  clearRunIfCurrent: vi.fn(),
  loadThreadMessages: vi.fn(async () => {}),
  markRunStarted: vi.fn(),
  markRunTerminal: vi.fn(),
};
let latest: ReturnType<typeof useThreadStreamAction>;

function Harness() {
  latest = useThreadStreamAction({
    ...handlers,
    catalogKindEnabled: {} as never,
    clearEditingState: () => {},
    currentUserId: null,
    librarySources: [],
    messages,
    searchEnabled: false,
    selectedByokModels: {},
    selectedModels: {} as never,
    setArtifactsRefreshKey: () => {},
    setComposerInitialInput: () => {},
    setComposerResetKey: () => {},
    setMessages: (updater) => {
      messages = updater(messages);
    },
    setStreamingAssistantSnapshot: () => {},
    setWorkfilesRefreshKey: () => {},
    streamWithSelectedLlm: false,
    thinkingSettings: {} as never,
    threadId: "thread-1",
    updateActiveRunIfCurrent: () => {},
    updateChatSourceCount: () => {},
    updateChatTitle: () => {},
    workspaceId: "workspace-1",
  });
  return null;
}

/** The attach issued by the reload path (loadThreadMessages). */
function reloadAttachInput(): ThreadStreamActionInput {
  return {
    mode: "send",
    attachOnly: true,
    reattachOnFailure: true,
    durableRunKey: "run-key",
    assistantMessageId: assistantMessage.id,
    baseMessages: messages,
    runOwnerUserId: "user-1",
  };
}

type RunnerInput = {
  markStreamingAssistantAsError: (input: { error: string }) => void;
  onStreamError: (error: Error) => void;
  updateStreamingAssistantMessage: (
    updater: (message: ChatMessageItem) => ChatMessageItem,
  ) => void;
};

/** What the real runner does on an SSE `error` event (handleStreamingError). */
function emitServerError(input: RunnerInput, message: string) {
  input.markStreamingAssistantAsError({ error: message });
  input.onStreamError(new Error(message));
}

async function httpError(status: number) {
  return throwStreamRequestError(
    new Response(JSON.stringify({ error: { message: `HTTP ${status}` } }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ).catch((error: unknown) => error);
}

async function run(input: ThreadStreamActionInput) {
  await mountWithIntl(createElement(Harness));
  await act(async () => latest.streamThreadAction(input));
}

function hasErrorBubble() {
  return messages.some((message) => message.metadata.isError === true);
}

function terminalCall() {
  return handlers.markRunTerminal.mock.calls[0]?.[0] as
    { attachFailed: boolean; detachedWithoutFinish: boolean } | undefined;
}

function assertRecovered(failure?: unknown) {
  assert.equal(
    handlers.attachReattach.handleAttachFailure.mock.calls.length,
    1,
  );
  const [runKey, error] =
    handlers.attachReattach.handleAttachFailure.mock.calls[0] ?? [];
  assert.equal(runKey, "run-key");
  if (failure !== undefined) assert.equal(error, failure);
  assert.equal(terminalCall()?.attachFailed, true);
  assert.equal(handlers.clearRunIfCurrent.mock.calls.length, 0);
  assert.equal(hasErrorBubble(), false);
  assert.equal(mocks.toastError.mock.calls.length, 0);
  // The partial render stays in the list (not removed as a failed temp row).
  assert.equal(
    messages.find((message) => message.id === assistantMessage.id)?.content,
    "partial answer",
  );
}

function assertOldErrorPath() {
  assert.equal(
    handlers.attachReattach.handleAttachFailure.mock.calls.length,
    0,
  );
  assert.equal(terminalCall()?.attachFailed, false);
  assert.equal(mocks.toastError.mock.calls.length, 1);
}

beforeEach(() => {
  messages = [assistantMessage];
  mocks.runChatStream.mockReset();
  mocks.toastError.mockReset();
  for (const fn of [
    handlers.attachReattach.handleAttachFailure,
    handlers.attachReattach.noteAttachProgress,
    handlers.attachReattach.noteAttachSucceeded,
    handlers.attachReattach.noteStreamStart,
    handlers.clearAttachedRunKeyIfCurrent,
    handlers.clearRunIfCurrent,
    handlers.loadThreadMessages,
    handlers.markRunStarted,
    handlers.markRunTerminal,
  ]) {
    fn.mockClear();
  }
});
afterEach(unmountAll);

test("a reload attach network failure keeps the run, frees the attach slot and shows no error bubble", async () => {
  const failure = new TypeError("network error");
  mocks.runChatStream.mockRejectedValue(failure);

  await run(reloadAttachInput());

  assert.deepEqual(handlers.attachReattach.noteStreamStart.mock.calls, [
    ["run-key", true],
  ]);
  assertRecovered(failure);
  assert.deepEqual(terminalCall(), {
    attachFailed: true,
    detachedWithoutFinish: false,
    durableRunKey: "run-key",
    waitingForApproval: false,
  });
  assert.equal(
    handlers.attachReattach.noteAttachSucceeded.mock.calls.length,
    0,
  );
});

test("a reload attach 5xx is recovered", async () => {
  const failure = await httpError(503);
  mocks.runChatStream.mockRejectedValue(failure);

  await run(reloadAttachInput());

  assertRecovered(failure);
});

test("a reload attach 4xx keeps the old error path and is not retried", async () => {
  mocks.runChatStream.mockRejectedValue(await httpError(404));

  await run(reloadAttachInput());

  assertOldErrorPath();
});

test("an SSE error without a finish on a reload attach is an attach failure (run kept, no bubble)", async () => {
  mocks.runChatStream.mockImplementation(async (input: RunnerInput) => {
    emitServerError(input, "attach failed");
    return { receivedFinishEvent: false, finishReason: null };
  });

  await run(reloadAttachInput());

  assertRecovered();
  // An error-only stream is not progress: the retry budget is not reset.
  assert.equal(handlers.attachReattach.noteAttachProgress.mock.calls.length, 0);
});

test("a server-reported run error with a finish keeps the error path", async () => {
  mocks.runChatStream.mockImplementation(async (input: RunnerInput) => {
    emitServerError(input, "model failed");
    return { receivedFinishEvent: true, finishReason: "error" };
  });

  await run(reloadAttachInput());

  assertOldErrorPath();
});

test("a reload attach that ends cleanly without a finish is recovered", async () => {
  mocks.runChatStream.mockResolvedValue({
    receivedFinishEvent: false,
    finishReason: null,
  });

  await run(reloadAttachInput());

  assertRecovered();
  assert.equal(terminalCall()?.detachedWithoutFinish, false);
  assert.equal(
    handlers.attachReattach.noteAttachSucceeded.mock.calls.length,
    0,
  );
});

test("the first event of a reload attach resets the retry streak", async () => {
  mocks.runChatStream.mockImplementation(async (input: RunnerInput) => {
    input.updateStreamingAssistantMessage((message) => message);
    input.updateStreamingAssistantMessage((message) => message);
    throw new TypeError("network error");
  });

  await run(reloadAttachInput());

  assert.deepEqual(handlers.attachReattach.noteAttachProgress.mock.calls, [
    ["run-key"],
  ]);
  assertRecovered();
});

test("a clean reload attach reports success to recovery", async () => {
  mocks.runChatStream.mockResolvedValue({
    receivedFinishEvent: true,
    finishReason: "stop",
  });

  await run(reloadAttachInput());

  assert.deepEqual(handlers.attachReattach.noteAttachSucceeded.mock.calls, [
    ["run-key"],
  ]);
  assert.equal(
    handlers.attachReattach.handleAttachFailure.mock.calls.length,
    0,
  );
  assert.equal(terminalCall()?.attachFailed, false);
});

test("a tool-approval resume attach failure keeps the old error path", async () => {
  mocks.runChatStream.mockRejectedValue(new TypeError("network error"));

  await run({
    mode: "resume",
    attachOnly: true,
    durableRunKey: "resume-key",
    assistantMessageId: assistantMessage.id,
    baseMessages: messages,
  });

  assertOldErrorPath();
  assert.equal(handlers.attachReattach.noteAttachProgress.mock.calls.length, 0);
});

test("a user-initiated send failure keeps its existing behaviour", async () => {
  mocks.runChatStream.mockRejectedValue(new TypeError("network error"));

  await run({ mode: "send", content: "hello" });

  const [startKey, startAttach] =
    handlers.attachReattach.noteStreamStart.mock.calls[0] ?? [];
  assert.equal(typeof startKey, "string");
  assert.equal(startAttach, false);
  assertOldErrorPath();
  // The optimistic rows are dropped, as before.
  assert.deepEqual(
    messages.map((message) => message.id),
    [assistantMessage.id],
  );
});
