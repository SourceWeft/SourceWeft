import assert from "node:assert/strict";
import { test } from "vitest";
import {
  planQueuedSendRetry,
  queuedSendPreview,
  shouldQueueSend,
  type QueuedSend,
} from "./chat-send-queue";
import type { ChatSendInput } from "../../_components/chat-canvas";

function sendInput(overrides: Partial<ChatSendInput> = {}): ChatSendInput {
  return { content: "hello", ...overrides };
}

function queued(id: string, attempts = 0): QueuedSend {
  return {
    id,
    input: sendInput({ content: id }),
    durableRunKey: `key-${id}`,
    attempts,
  };
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
    queue = [...queue, queued(id)];
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

test("planQueuedSendRetry re-queues under the cap (attempts bumped, id/key stable)", () => {
  const plan = planQueuedSendRetry({ queued: queued("a", 2), maxAttempts: 8 });
  assert.ok("requeued" in plan);
  assert.equal(plan.requeued.id, "a");
  assert.equal(plan.requeued.durableRunKey, "key-a");
  assert.equal(plan.requeued.attempts, 3);
});

test("planQueuedSendRetry drops once the attempt cap is exceeded", () => {
  const plan = planQueuedSendRetry({ queued: queued("a", 8), maxAttempts: 8 });
  assert.ok("dropped" in plan);
});

test("preview prefers text, then image count, then a fallback", () => {
  assert.equal(queuedSendPreview(sendInput({ content: "  hi  " })), "hi");
  assert.equal(
    queuedSendPreview(sendInput({ content: "", images: [{}, {}] as never })),
    "2 images",
  );
  assert.equal(queuedSendPreview(sendInput({ content: "   " })), "Queued message");
});
