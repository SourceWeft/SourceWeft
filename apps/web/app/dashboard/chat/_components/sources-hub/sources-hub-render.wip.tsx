// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Disable the connector sync-run polling engine entirely: its timers +
// BroadcastChannel are what made mounting SourcesHub hang under jsdom. The
// engine itself is covered by use-connector-sync-runs.test.ts. The returned
// API must be referentially stable (like the real useCallback-memoized hook),
// otherwise effects that depend on trackConnectorSyncRun re-run every render.
const stableSyncRunApi = { trackConnectorSyncRun: () => {} };
vi.mock("./use-connector-sync-runs", () => ({
  useConnectorSyncRuns: () => stableSyncRunApi,
  isDocumentVisible: () => true,
}));

// Stub the SDK so all mount-time refreshes resolve immediately with empty data
// instead of hitting the network.
const emptyResult = {
  items: [],
  nextCursor: null,
  accounts: [],
  connectors: [],
  installs: [],
  tools: [],
  catalog: [],
  file: null,
  webhookConfig: null,
  events: [],
};

function makeStubClient() {
  return new Proxy(
    {},
    {
      get: () => vi.fn().mockResolvedValue(emptyResult),
    },
  );
}

vi.mock("../../../../../lib/sdk", () => ({
  apiBaseUrl: "http://localhost",
  connectorsClient: makeStubClient(),
  contentClient: makeStubClient(),
}));

import { SourcesHub } from "./index";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type SourcesHubProps = Parameters<typeof SourcesHub>[0];

async function renderHub(props: Partial<SourcesHubProps> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  const merged: SourcesHubProps = {
    mode: "new",
    selectedIds: [],
    onSelectionChange: () => {},
    workspaceId: "ws1",
    workspaceName: "Workspace",
    ...props,
  };
  // Use a synchronous act(): SourcesHub runs background window.setInterval
  // pollers (waiting connectors, etc.) that never quiesce, so an async
  // act(async () => ...) would wait on them forever. A sync act commits the
  // initial render + passive effects, which is all this smoke test needs.
  act(() => {
    created.render(createElement(SourcesHub, merged));
  });
  // Let post-mount async state updates settle across a few macrotask ticks.
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

test("mounts in new mode without hanging", async () => {
  const el = await renderHub({ mode: "new" });
  expect(el.textContent).not.toBe("");
  expect(
    el.querySelector('[role="tablist"], [data-slot="tabs-list"]'),
  ).not.toBe(null);
});

test("mounts in thread mode with a threadId", async () => {
  const el = await renderHub({ mode: "thread", threadId: "t1" });
  expect(el.textContent).not.toBe("");
});

test("mounts as a drawer variant", async () => {
  const el = await renderHub({ variant: "drawer" });
  expect(el.textContent).not.toBe("");
});

test("mounts with initial sources provided", async () => {
  const el = await renderHub({
    initialSources: [
      {
        id: "s1",
        title: "Doc One",
        sourceType: "file",
        parentSourceId: null,
        type: "DOC",
        status: "Indexed",
        meta: "now",
        contentText: null,
        connectorId: null,
        externalUri: null,
        metadata: null,
        storageKey: null,
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ],
    initialSourcesLoaded: true,
  });
  expect(el.textContent).not.toBe("");
});

test("mounts without a workspace id", async () => {
  const el = await renderHub({ workspaceId: null });
  expect(el.textContent).not.toBe("");
});
