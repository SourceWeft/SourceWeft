// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { SourceItem } from "../source-types";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

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
const listWorkingFilesMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ items: [] }),
);
const listSourcesMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
);
const getSourceMock = vi.hoisted(() => vi.fn());
const getSourceGuideMock = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const localRequestMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: routerPush }),
}));
vi.mock("../../../../../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "owner" }, session: { id: "session" } },
    }),
  },
}));
vi.mock("../../../../../lib/local-execution", () => ({
  localRequest: localRequestMock,
}));

beforeEach(() => {
  localRequestMock.mockResolvedValue({ executionTarget: { kind: "cloud" } });
});

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
    listSources: listSourcesMock,
    getSource: getSourceMock,
    getSourceGuide: getSourceGuideMock,
    listArtifactSummaries: listArtifactSummariesMock,
    listWorkingFiles: listWorkingFilesMock,
  }),
}));

import { SourcesHub } from "./index";

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
  const hub = createElement(SourcesHub, merged);
  const { container } = await mountWithIntl(
    options.strict ? <StrictMode>{hub}</StrictMode> : hub,
  );
  return container;
}

afterEach(async () => {
  await unmountAll();
  window.sessionStorage.clear();
  vi.clearAllMocks();
  // jsdom has none; the preview tests install one.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

test("mounts in new mode and renders the hub tab strip", async () => {
  const el = await renderHub({ mode: "new" });
  // The hub renders one <button> per tab; assert a couple of stable labels.
  expect(el.textContent).toContain("Sources");
  expect(el.textContent).toContain("Files");
  expect(el.querySelectorAll("button").length).toBeGreaterThan(3);
});

test("restores the detached cloud Files tab after execution metadata loads", async () => {
  let resolveExecution!: (value: unknown) => void;
  localRequestMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveExecution = resolve;
    }),
  );
  const viewChanged = vi.fn();
  const el = await renderHub({
    mode: "thread",
    threadId: "cloud-restore",
    variant: "window",
    initialView: { tab: "Files" },
    onViewChange: viewChanged,
  });
  expect(listWorkingFilesMock).not.toHaveBeenCalled();
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(el.textContent).toContain("Loading Files location…");
  await act(async () =>
    resolveExecution({ executionTarget: { kind: "cloud" } }),
  );
  expect(el.textContent).toContain("Files");
  expect(listWorkingFilesMock).toHaveBeenCalledWith("ws1", "cloud-restore");
  expect(viewChanged.mock.calls.at(-1)?.[0].tab).toBe("Files");
  expect(el.querySelector('[role="alert"]')).toBeNull();
});

test("Hub shows a real initial execution request failure", async () => {
  localRequestMock.mockRejectedValueOnce(new Error("Network unavailable"));
  const el = await renderHub({
    mode: "thread",
    threadId: "execution-failure",
    initialView: { tab: "Sources" },
  });
  expect(el.querySelector('[role="alert"]')?.textContent).toBe(
    "Unable to read the file location: Network unavailable",
  );
});

test("Hub does not warn during a local connection recheck and reports confirmed unavailability", async () => {
  const online = {
    executionTarget: { kind: "local", deviceId: "pc" },
    availability: { ready: true },
  };
  let resolveExecution!: (value: unknown) => void;
  localRequestMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveExecution = resolve;
    }),
  );
  const el = await renderHub({
    mode: "thread",
    threadId: "local-recheck",
    initialView: { tab: "Sources" },
  });
  expect(el.querySelector('[role="alert"]')).toBeNull();
  await act(async () => resolveExecution(online));
  expect(el.querySelector('[role="alert"]')).toBeNull();

  localRequestMock.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveExecution = resolve;
    }),
  );
  const { reportLocalAvailabilityError } =
    await import("../../../../../lib/local-availability-events");
  await act(async () => {
    reportLocalAvailabilityError(
      "/v1/workspaces/ws1/threads/local-recheck/files",
      { code: "DEVICE_OFFLINE" },
    );
  });
  expect(el.querySelector('[role="alert"]')).toBeNull();
  await act(async () =>
    resolveExecution({
      ...online,
      availability: {
        ready: false,
        code: "DEVICE_OFFLINE",
        message: "Computer offline",
      },
    }),
  );
  expect(el.querySelector('[role="alert"]')?.textContent).toBe(
    "Unable to read the file location: Computer offline",
  );
});

test("a detached local conversation never loads cloud Files from a saved tab", async () => {
  localRequestMock.mockResolvedValueOnce({
    executionTarget: { kind: "local" },
  });
  const viewChanged = vi.fn();
  const el = await renderHub({
    mode: "thread",
    threadId: "local-restore",
    variant: "window",
    initialView: { tab: "Files" },
    onViewChange: viewChanged,
  });
  expect(el.textContent).toContain("Files");
  expect(listWorkingFilesMock).not.toHaveBeenCalled();
  expect(viewChanged.mock.calls.at(-1)?.[0].tab).toBe("Files");
});

test("mounts in thread mode with a threadId", async () => {
  const el = await renderHub({ mode: "thread", threadId: "t1" });
  expect(el.textContent).not.toBe("");
});

test("mounts as a drawer variant", async () => {
  const el = await renderHub({ variant: "drawer" });
  expect(el.textContent).not.toBe("");
});

const previewedSource: SourceItem = {
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
};

/** Open the source's preview from its Hub row and ask the guide's question. */
async function askFromPreview(props: Partial<SourcesHubProps>) {
  // A narrow screen, where the Hub is a drawer and the guide starts as a bar.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  // The Hub reloads its list on mount, so the server has to know the source.
  listSourcesMock.mockResolvedValueOnce({
    items: [
      {
        id: "s1",
        title: "Doc One",
        sourceType: "file_upload",
        parentSourceId: null,
        status: "indexed",
        mimeType: "text/plain",
        contentText: "",
        connectorId: null,
        externalUri: null,
        metadata: null,
        storageKey: null,
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ],
    nextCursor: null,
  });
  getSourceMock.mockResolvedValue({
    source: {
      id: "s1",
      title: "Doc One",
      sourceType: "file_upload",
      mimeType: "text/plain",
      contentText: "Revenue grew in 2025.",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    documents: [{ id: "d1", contentText: "Revenue grew in 2025." }],
    chunks: [],
  });
  getSourceGuideMock.mockResolvedValue({
    guide: {
      sourceId: "s1",
      status: "ready",
      content: {
        summary: "Revenue grew in 2025.",
        topics: ["Revenue"],
        suggestedQuestions: ["What drove growth?"],
      },
      errorCode: null,
      trigger: "auto",
      stale: false,
      updatedAt: "2026-11-14T00:00:00.000Z",
    },
  });
  await renderHub({
    initialSources: [previewedSource],
    initialSourcesLoaded: true,
    ...props,
  });
  const buttons = () => [...document.body.querySelectorAll("button")];
  const row = buttons().find((button) =>
    button.textContent?.includes("Doc One"),
  );
  expect(row).toBeTruthy();
  await click(row!);
  await flush();
  await flush();
  const guideBar = document.body.querySelector<HTMLElement>(
    "[data-source-guide-preview]",
  );
  expect(guideBar).toBeTruthy();
  await click(guideBar!);
  const question = buttons().find((button) =>
    button.textContent?.includes("What drove growth?"),
  );
  expect(question).toBeTruthy();
  await click(question!);
  expect(routerPush).toHaveBeenCalledTimes(1);
}

test("a question asked from the source preview closes the Hub drawer", async () => {
  const onClose = vi.fn();
  await askFromPreview({ variant: "drawer", onClose });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a question asked from the source preview leaves a docked Hub open", async () => {
  const onClose = vi.fn();
  await askFromPreview({ variant: "panel", onClose });
  expect(onClose).not.toHaveBeenCalled();
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
