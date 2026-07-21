import assert from "node:assert/strict";
import { test } from "vitest";
import {
  resolveChatUiState,
  type ChatUiStateInput,
  type ChatUiStatus,
} from "./chat-ui-state";

const shellReady = {
  shellStatus: "ready",
  workspaceStatus: "ready",
  modelCatalogStatus: "ready",
  sourcesStatus: "ready",
} satisfies Partial<ChatUiStateInput>;

function resolve(overrides: ChatUiStateInput) {
  return resolveChatUiState(overrides);
}

test("direct /dashboard/chat uses route bootstrap skeleton during initial route load", () => {
  const state = resolve({
    routeKind: "new",
    shellStatus: "loading",
    workspaceStatus: "loading",
    modelCatalogStatus: "loading",
    sourcesStatus: "loading",
    isInitialRouteLoad: true,
  });

  assert.equal(state.status, "route-bootstrap");
  assert.equal(state.skeletonPolicy, "route");
});

test("direct /dashboard/chat/[threadId] bootstraps thread canvas after shell is ready", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "thread",
    requestedThreadId: "thread-b",
    activeThreadId: "thread-b",
    threadStatus: "loading",
  });

  assert.equal(state.status, "thread-bootstrap");
  assert.equal(state.skeletonPolicy, "canvas");
});

test("thread loading keeps message list visible when messages are already present", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "thread",
    requestedThreadId: "thread-b",
    activeThreadId: "thread-b",
    threadStatus: "loading",
    hasMessages: true,
  });

  assert.equal(state.status, "thread-ready");
  assert.equal(state.skeletonPolicy, "none");
});

test("thread switching still hides stale messages behind overlay skeleton", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "thread",
    requestedThreadId: "thread-b",
    activeThreadId: "thread-a",
    threadStatus: "loading",
    hasMessages: true,
  });

  assert.equal(state.status, "thread-switching");
  assert.equal(state.skeletonPolicy, "overlay");
});

test("normal new chat after shell ready uses no route skeleton", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "new",
    hasMessages: false,
  });

  assert.equal(state.status, "new-ready");
  assert.notEqual(state.skeletonPolicy, "route");
  assert.equal(state.skeletonPolicy, "none");
});

test("first-message create success pending uses inline creating-thread state", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "new",
    creationStatus: "loading",
  });

  assert.equal(state.status, "creating-thread");
  assert.equal(state.skeletonPolicy, "inline");
});

test("create failure resolves to explicit creation error instead of loading", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "new",
    creationStatus: "error",
  });

  assert.equal(state.status, "fatal-error");
  assert.equal(state.skeletonPolicy, "inline");
  assert.equal(state.errorKind, "creation");
});

test("thread A to B switch keeps route skeleton off and uses overlay policy", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "thread",
    requestedThreadId: "thread-b",
    activeThreadId: "thread-a",
    threadStatus: "ready",
  });

  assert.equal(state.status, "thread-switching");
  assert.equal(state.skeletonPolicy, "overlay");
  assert.notEqual(state.skeletonPolicy, "route");
});

test("workspace shortcut pending uses workspace loading without route skeleton", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "new",
    workspaceStatus: "loading",
    isWorkspaceShortcutPending: true,
  });

  assert.equal(state.status, "workspace-loading");
  assert.equal(state.skeletonPolicy, "overlay");
  assert.notEqual(state.skeletonPolicy, "route");
});

test("model catalog error returns error state rather than loading state", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "thread",
    requestedThreadId: "thread-a",
    activeThreadId: "thread-a",
    modelCatalogStatus: "error",
    threadStatus: "loading",
  });

  assert.equal(state.status, "model-error");
  assert.equal(state.skeletonPolicy, "none");
  assert.equal(state.errorKind, "model-catalog");
  assert.notEqual(state.status, "model-loading");
});

test("source loading uses source skeleton policy without blocking canvas", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "new",
    sourcesStatus: "loading",
  });

  assert.equal(state.status, "sources-loading");
  assert.equal(state.skeletonPolicy, "sources");
});

test("source error returns error state rather than loading state", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "thread",
    requestedThreadId: "thread-a",
    activeThreadId: "thread-a",
    sourcesStatus: "error",
  });

  assert.equal(state.status, "sources-error");
  assert.equal(state.skeletonPolicy, "none");
  assert.equal(state.errorKind, "sources");
  assert.notEqual(state.status, "sources-loading");
});

test("invalid thread resolves to explicit empty/error state", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "thread",
    requestedThreadId: "missing-thread",
    activeThreadId: "missing-thread",
    threadStatus: "error",
  });

  assert.equal(state.status, "empty");
  assert.equal(state.skeletonPolicy, "none");
  assert.equal(state.errorKind, "thread");
});

test("streaming state is inline and keeps the active route region stable", () => {
  const state = resolve({
    ...shellReady,
    routeKind: "thread",
    requestedThreadId: "thread-a",
    activeThreadId: "thread-a",
    streamingStatus: "loading",
  });

  assert.equal(state.status, "streaming");
  assert.equal(state.skeletonPolicy, "inline");
});

test("helper status names are covered by state derivation fixtures", () => {
  const expected = new Set<ChatUiStatus>([
    "route-bootstrap",
    "workspace-loading",
    "new-ready",
    "creating-thread",
    "thread-switching",
    "thread-bootstrap",
    "thread-ready",
    "model-loading",
    "model-error",
    "sources-loading",
    "sources-error",
    "empty",
    "streaming",
    "fatal-error",
  ]);
  const fixtures: ChatUiStateInput[] = [
    { routeKind: "new", shellStatus: "loading", isInitialRouteLoad: true },
    { ...shellReady, routeKind: "new", workspaceStatus: "loading" },
    { ...shellReady, routeKind: "new" },
    { ...shellReady, routeKind: "new", creationStatus: "loading" },
    {
      ...shellReady,
      routeKind: "thread",
      requestedThreadId: "b",
      activeThreadId: "a",
    },
    { ...shellReady, routeKind: "thread", threadStatus: "loading" },
    { ...shellReady, routeKind: "thread", hasThread: true },
    { ...shellReady, routeKind: "new", modelCatalogStatus: "loading" },
    { ...shellReady, routeKind: "new", modelCatalogStatus: "error" },
    { ...shellReady, routeKind: "new", sourcesStatus: "loading" },
    { ...shellReady, routeKind: "new", sourcesStatus: "error" },
    { ...shellReady, routeKind: "thread", threadStatus: "error" },
    { ...shellReady, routeKind: "thread", streamingStatus: "loading" },
    { ...shellReady, routeKind: "new", creationStatus: "error" },
  ];

  const actual = new Set(fixtures.map((fixture) => resolve(fixture).status));
  assert.deepEqual(actual, expected);
});
