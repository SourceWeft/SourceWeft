import assert from "node:assert/strict";
import { test } from "vitest";
import { HttpClientError } from "@sourceweft/sdk";
import { retryOnceOnServiceUnavailable } from "./dashboard-chat-request-retry";
import {
  resolveWorkspaceSwitchTransition,
  type WorkspaceSwitchTransitionState,
} from "./dashboard-chat-transitions";

function httpError(status: number) {
  return new HttpClientError({
    message: `HTTP ${status}`,
    status,
    statusText: status === 503 ? "Service Unavailable" : "Error",
    code: "HTTP_ERROR",
  });
}

test("a 503 is retried once after a short backoff", async () => {
  const waits: number[] = [];
  let calls = 0;
  const request = async () => {
    calls += 1;
    if (calls === 1) throw httpError(503);
    return "ok";
  };

  const result = await retryOnceOnServiceUnavailable(request, {
    wait: async (ms) => {
      waits.push(ms);
    },
  });

  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [500]);
});

test("a second 503 is not retried again", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    throw httpError(503);
  };

  await assert.rejects(
    retryOnceOnServiceUnavailable(request, { wait: async () => {} }),
    (error: unknown) =>
      error instanceof HttpClientError && error.status === 503,
  );
  assert.equal(calls, 2);
});

test("other failures are not retried", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    throw httpError(500);
  };

  await assert.rejects(
    retryOnceOnServiceUnavailable(request, { wait: async () => {} }),
    (error: unknown) =>
      error instanceof HttpClientError && error.status === 500,
  );
  assert.equal(calls, 1);

  let plainCalls = 0;
  await assert.rejects(
    retryOnceOnServiceUnavailable(
      async () => {
        plainCalls += 1;
        throw new Error("offline");
      },
      { wait: async () => {} },
    ),
    /offline/,
  );
  assert.equal(plainCalls, 1);
});

const activeThreadState = {
  mode: "thread",
  activeChatId: "thread-a",
  threadTitle: "Existing thread",
  pendingWorkspaceId: null,
  workspaceSwitchStatus: "idle",
  lastChatTransitionError: null,
} satisfies WorkspaceSwitchTransitionState;

test("workspace switch start preserves active chat while marking pending workspace", () => {
  const state = resolveWorkspaceSwitchTransition(activeThreadState, {
    type: "start",
    targetWorkspaceId: "workspace-b",
  });

  assert.equal(state.mode, "thread");
  assert.equal(state.activeChatId, "thread-a");
  assert.equal(state.threadTitle, "Existing thread");
  assert.equal(state.pendingWorkspaceId, "workspace-b");
  assert.equal(state.workspaceSwitchStatus, "loading");
  assert.equal(state.lastChatTransitionError, null);
});

test("workspace switch success moves to new chat after target workspace is loaded", () => {
  const pendingState = resolveWorkspaceSwitchTransition(activeThreadState, {
    type: "start",
    targetWorkspaceId: "workspace-b",
  });
  const state = resolveWorkspaceSwitchTransition(pendingState, {
    type: "success",
  });

  assert.equal(state.mode, "new");
  assert.equal(state.activeChatId, "");
  assert.equal(state.threadTitle, "New chat");
  assert.equal(state.pendingWorkspaceId, null);
  assert.equal(state.workspaceSwitchStatus, "idle");
  assert.equal(state.lastChatTransitionError, null);
});

test("workspace switch failure restores coherent previous thread selection", () => {
  const pendingState = resolveWorkspaceSwitchTransition(activeThreadState, {
    type: "start",
    targetWorkspaceId: "workspace-b",
  });
  const state = resolveWorkspaceSwitchTransition(pendingState, {
    type: "failure",
    errorMessage: "Could not load workspace.",
  });

  assert.equal(state.mode, "thread");
  assert.equal(state.activeChatId, "thread-a");
  assert.equal(state.threadTitle, "Existing thread");
  assert.equal(state.pendingWorkspaceId, null);
  assert.equal(state.workspaceSwitchStatus, "error");
  assert.equal(state.lastChatTransitionError, "Could not load workspace.");
});
