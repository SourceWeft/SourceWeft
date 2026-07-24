import assert from "node:assert/strict";
import { test } from "vitest";
import {
  queuedSendPreview,
  shouldQueueSend,
  type QueuedSend,
} from "./chat-send-queue";
import type { ChatSendInput } from "../../_components/chat-canvas";

function sendInput(overrides: Partial<ChatSendInput> = {}): ChatSendInput {
  return { content: "hello", ...overrides };
}

test("an idle thread sends immediately (no queue)", () => {
  assert.equal(
    shouldQueueSend({ chatExecutionState: "idle" }),
    false,
  );
});

test("a streaming run queues the send — own or another member's", () => {
  for (const state of ["executing", "waiting_for_approval", "stopping"] as const) {
    assert.equal(
      shouldQueueSend({ chatExecutionState: state }),
      true,
      `expected ${state} to queue`,
    );
  }
});

test("the internal replay path never re-queues", () => {
  assert.equal(
    shouldQueueSend({
      chatExecutionState: "executing",
      allowWhileStreaming: true,
    }),
    false,
  );
});

test("FIFO: sends fire in the order they were queued", () => {
  // The controller shifts from the front and pushes to the back; model that
  // here to lock the ordering contract the auto-send effect relies on.
  let queue: QueuedSend[] = [];
  const enqueue = (id: string) => {
    queue = [...queue, { id, input: sendInput({ content: id }) }];
  };
  enqueue("a");
  enqueue("b");
  enqueue("c");

  const drained: string[] = [];
  let next = queue[0];
  while (next) {
    queue = queue.slice(1);
    drained.push(next.id);
    next = queue[0];
  }

  assert.deepEqual(drained, ["a", "b", "c"]);
});

test("preview prefers text, then image count, then a fallback", () => {
  assert.equal(queuedSendPreview(sendInput({ content: "  hi  " })), "hi");
  assert.equal(
    queuedSendPreview(sendInput({ content: "", images: [{}, {}] as never })),
    "2 images",
  );
  assert.equal(queuedSendPreview(sendInput({ content: "   " })), "Queued message");
});
