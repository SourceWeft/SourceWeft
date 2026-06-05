import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveWorkspaceSwitchTransition,
  type WorkspaceSwitchTransitionState,
} from "./dashboard-chat-transitions";

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
