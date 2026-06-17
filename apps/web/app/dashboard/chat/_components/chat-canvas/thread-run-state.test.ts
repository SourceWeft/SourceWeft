import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveMessageVersionRunLifecycle,
  summarizeActiveThreadRun,
  summarizeMessageVersionThreadRun,
} from "./thread-run-state";
import type { ActiveThreadRun } from "../../[threadId]/chat-stream-runner-control";
import type { MessageVersion } from "./types";

const activeRun: ActiveThreadRun = {
  id: "run-1",
  idempotencyKey: "sw-run-1",
  status: "running",
  mode: "send",
  assistantMessageId: "assistant-1",
  userMessageId: "user-1",
};

function version(overrides: Partial<MessageVersion>): MessageVersion {
  return {
    id: "assistant-1",
    content: "",
    ...overrides,
  };
}

test("matches an active run by assistant message id", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      activeThreadRun: activeRun,
      version: version({ id: "assistant-1" }),
    }),
    "live",
  );
});

test("active run wins over stale local completed metadata", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      activeThreadRun: { ...activeRun, assistantMessageId: null },
      version: version({
        id: "assistant-2",
        threadRun: {
          idempotencyKey: "sw-run-1",
          status: "completed",
        },
      }),
    }),
    "live",
  );
});

test("does not match unrelated runs", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      activeThreadRun: { ...activeRun, assistantMessageId: null },
      isLatestAssistantGroup: false,
      version: version({
        id: "assistant-2",
        threadRun: {
          idempotencyKey: "sw-run-2",
          status: "running",
        },
      }),
    }),
    "idle",
  );
});

test("keeps latest assistant group live while active run has not attached", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      activeThreadRun: { ...activeRun, assistantMessageId: null },
      isLatestAssistantGroup: true,
      version: version({
        id: "assistant-2",
        content: "partial response",
      }),
    }),
    "live",
  );
});

test("does not keep terminal latest assistant group live", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      activeThreadRun: { ...activeRun, assistantMessageId: null },
      isLatestAssistantGroup: true,
      version: version({
        id: "assistant-2",
        finishReason: "stop",
      }),
    }),
    "terminal",
  );
});

test("resolves waiting active runs", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      activeThreadRun: {
        ...activeRun,
        status: "waiting_for_approval",
      },
      version: version({ id: "assistant-1" }),
    }),
    "waiting_for_approval",
  );
});

test("treats active transient message metadata as live while streaming", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      isStreaming: true,
      version: version({
        renderKey: "temp-assistant-1",
        threadRun: {
          idempotencyKey: "sw-run-1",
          status: "running",
        },
      }),
    }),
    "live",
  );
});

test("does not treat stale transient active metadata as live after streaming stops", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      version: version({
        renderKey: "temp-assistant-1",
        threadRun: {
          idempotencyKey: "sw-run-1",
          status: "running",
        },
      }),
    }),
    "idle",
  );
});

test("does not treat persisted active metadata as live", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      isStreaming: true,
      version: version({
        threadRun: {
          idempotencyKey: "sw-run-1",
          status: "running",
        },
      }),
    }),
    "idle",
  );
});

test("treats terminal transient metadata as terminal", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      version: version({
        renderKey: "temp-assistant-1",
        threadRun: {
          idempotencyKey: "sw-run-1",
          status: "completed",
        },
      }),
    }),
    "terminal",
  );
});

test("treats terminal finish reasons as terminal", () => {
  assert.equal(
    resolveMessageVersionRunLifecycle({
      version: version({
        finishReason: "stop",
      }),
    }),
    "terminal",
  );
});

test("summaries include run status fields used for memoized rendering", () => {
  assert.match(summarizeActiveThreadRun(activeRun), /running/);
  assert.match(
    summarizeMessageVersionThreadRun({
      id: "run-1",
      idempotencyKey: "sw-run-1",
      status: "completed",
      mode: "send",
    }),
    /completed/,
  );
});
