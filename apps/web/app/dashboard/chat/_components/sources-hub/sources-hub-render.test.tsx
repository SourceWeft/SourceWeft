// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import type { SourceItem } from "../source-types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Disable the connector sync-run polling engine entirely: its timers +
// BroadcastChannel are what made mounting SourcesHub hang under jsdom. The
// engine itself is covered by use-connector-sync-runs.test.ts. The returned API
// must be referentially stable (like the real useCallback-memoized hook).
const stableSyncRunApi = { trackConnectorSyncRun: () => {} };
vi.mock("./use-connector-sync-runs", () => ({
  useConnectorSyncRuns: () => stableSyncRunApi,
  isDocumentVisible: () => true,
}));

// Stub the SDK so all mount-time refreshes resolve immediately with empty data
// instead of hitting the network. The single shape covers every list/get call
// the mount path makes (listSources/listArtifacts/listWorkingFiles/
// listWorkspaceMcpInstalls/listAccounts -> items; getWorkingFile -> file; etc.).
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

const listArtifactSummariesMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
);

function makeStubClient(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get: (target, property) =>
      Reflect.has(target, property)
        ? Reflect.get(target, property)
        : vi.fn().mockResolvedValue(emptyResult),
  });
}

vi.mock("../../../../../lib/sdk", () => ({
  apiBaseUrl: "http://localhost",
  connectorsClient: makeStubClient(),
  contentClient: makeStubClient({
    listArtifactSummaries: listArtifactSummariesMock,
  }),
}));

import { SourcesHub } from "./index";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type SourcesHubProps = Parameters<typeof SourcesHub>[0];

// Stable prop values shared across renders. SourcesHub declares many props with
// `= []` / `= () => {}` defaults; if those defaults run (prop omitted) they
// produce a fresh value every render, and across the leaf-domain hooks that
// churn drives an unbounded re-render loop that never lets `act` settle. Real
// callers pass stable props, so the smoke test does too.
const EMPTY: never[] = [];
const noop = () => {};

async function renderHub(
  props: Partial<SourcesHubProps> = {},
  options: { strict?: boolean } = {},
) {
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  const merged: SourcesHubProps = {
    mode: "new",
    selectedIds: EMPTY,
    onSelectionChange: noop,
    workspaceId: "ws1",
    workspaceName: "Workspace",
    citations: EMPTY,
    threadCitations: EMPTY,
    installedSkills: EMPTY,
    selectedSkillIds: EMPTY,
    onSkillSelectionChange: noop,
    selectedMcpInstallIds: EMPTY,
    selectedMcpToolIds: EMPTY,
    onMcpSelectionChange: noop,
    disabledToolNames: EMPTY,
    initialSources: EMPTY,
    ...props,
  };
  await act(async () => {
    const hub = createElement(SourcesHub, merged);
    created.render(options.strict ? createElement(StrictMode, null, hub) : hub);
  });
  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

test("mounts in new mode and renders the hub tab strip", async () => {
  const el = await renderHub({ mode: "new" });
  // The hub renders one <button> per tab; assert a couple of stable labels.
  expect(el.textContent).toContain("Sources");
  expect(el.textContent).toContain("Workfiles");
  expect(el.querySelectorAll("button").length).toBeGreaterThan(3);
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
  const initialSources: SourceItem[] = [
    {
      id: "s1",
      title: "Doc One",
      sourceType: "file_upload",
      parentSourceId: null,
      type: "DOC",
      status: "Indexed",
      meta: "now",
      contentText: "",
      connectorId: null,
      externalUri: null,
      storageKey: null,
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ];
  const el = await renderHub({ initialSources, initialSourcesLoaded: true });
  expect(el.textContent).not.toBe("");
});

test("mounts without a workspace id", async () => {
  const el = await renderHub({ workspaceId: null });
  expect(el.textContent).not.toBe("");
});

test("does not load artifacts until the Artifacts tab becomes active", async () => {
  const el = await renderHub({ artifactsRefreshKey: 1 }, { strict: true });
  expect(listArtifactSummariesMock).not.toHaveBeenCalled();

  const artifactsButton = Array.from(el.querySelectorAll("button")).find(
    (button) => button.textContent?.trim().startsWith("Artifacts"),
  );
  expect(artifactsButton).toBeDefined();
  await act(async () => {
    artifactsButton!.click();
  });

  expect(listArtifactSummariesMock).toHaveBeenCalledTimes(1);
  expect(listArtifactSummariesMock).toHaveBeenCalledWith("ws1", { limit: 100 });
});
