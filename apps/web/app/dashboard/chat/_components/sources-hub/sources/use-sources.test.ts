// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { SourceItem } from "../../source-types";
import type { SourceTreeNode } from "../source-tree";
import { useSources } from "./use-sources";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// SDK mock. From the sources/ subdir the specifier the hook imports is one
// level deeper than index.tsx's: "../../../../../../lib/sdk".
const sdk = vi.hoisted(() => ({
  listSources: vi.fn(),
  listSourceStatuses: vi.fn(),
  createSource: vi.fn(),
  createUrlSource: vi.fn(),
  indexSource: vi.fn(),
  deleteSource: vi.fn(),
  bulkDeleteSources: vi.fn(),
  updateSource: vi.fn(),
  retrySource: vi.fn(),
  getSource: vi.fn(),
  uploadSource: vi.fn(),
}));

vi.mock("../../../../../../lib/sdk", () => ({
  apiBaseUrl: "http://localhost",
  contentClient: {
    listSources: sdk.listSources,
    listSourceStatuses: sdk.listSourceStatuses,
    createSource: sdk.createSource,
    createUrlSource: sdk.createUrlSource,
    indexSource: sdk.indexSource,
    deleteSource: sdk.deleteSource,
    bulkDeleteSources: sdk.bulkDeleteSources,
    updateSource: sdk.updateSource,
    retrySource: sdk.retrySource,
    getSource: sdk.getSource,
    uploadSource: sdk.uploadSource,
  },
}));

// Silence toast so error/success paths never throw.
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

// ---------------------------------------------------------------------------
// Fixtures + harness
// ---------------------------------------------------------------------------

/** A raw source record as returned by contentClient.listSources().items[]. */
function apiSource(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id,
    title: id.toUpperCase(),
    sourceType: "note",
    parentSourceId: null,
    status: "indexed",
    mimeType: null,
    contentText: "",
    connectorId: null,
    externalUri: null,
    metadata: null,
    storageKey: null,
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type HookInput = Parameters<typeof useSources>[0];
type HookApi = ReturnType<typeof useSources>;

function makeAddSourceDialog(overrides: Record<string, unknown> = {}) {
  return {
    reset: vi.fn(),
    close: vi.fn(),
    setUploadProgress: vi.fn(),
    textContent: "",
    textTitle: "",
    urlValue: "",
    urlTitle: "",
    parentSourceId: null,
    files: [],
    ...overrides,
  } as unknown as HookInput["addSourceDialog"];
}

function makeProps(overrides: Partial<HookInput> = {}): HookInput {
  return {
    workspaceId: "ws1",
    currentWorkspaceIdRef: { current: "ws1" },
    initialSources: [],
    initialSourcesLoaded: false,
    onSourceLoad: vi.fn(),
    onSourceMerge: vi.fn(),
    selectedIds: [],
    onSelectionChange: vi.fn(),
    manualConnectorSyncSourcesRef: { current: new Map() },
    addSourceDialog: makeAddSourceDialog(),
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 25; i += 1) {
      await Promise.resolve();
    }
  });
}

/** Mount the hook once with a fixed (referentially stable) props object. */
async function renderHook(input: HookInput) {
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  const captured: { api: HookApi | null } = { api: null };
  function Harness() {
    captured.api = useSources(input);
    return null;
  }
  await act(async () => {
    created.render(createElement(Harness));
  });
  await flush();
  return captured;
}

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  // Sensible defaults so unrelated mount-time calls resolve.
  sdk.listSources.mockResolvedValue({ items: [] });
  sdk.listSourceStatuses.mockResolvedValue({ items: [] });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("initial mount loads sources and reports them via onSourceLoad", async () => {
  sdk.listSources.mockResolvedValue({
    items: [apiSource("s1", { title: "Alpha" }), apiSource("s2", { title: "Beta" })],
  });
  const onSourceLoad = vi.fn();
  const props = makeProps({ onSourceLoad });

  const captured = await renderHook(props);

  expect(sdk.listSources).toHaveBeenCalledWith("ws1", { view: "tree" });
  expect(captured.api?.sources.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  expect(captured.api?.isLoading).toBe(false);
  expect(captured.api?.loadingError).toBeNull();
  expect(onSourceLoad).toHaveBeenCalled();
  const lastLoad = onSourceLoad.mock.calls.at(-1)![0] as SourceItem[];
  expect(lastLoad.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
});

test("a failing list call sets loadingError and clears loading", async () => {
  sdk.listSources.mockRejectedValue(new Error("boom"));
  const props = makeProps();

  const captured = await renderHook(props);

  expect(captured.api?.loadingError).toBe("boom");
  expect(captured.api?.isLoading).toBe(false);
  expect(captured.api?.sources).toHaveLength(0);
});

test("derived tree state reflects the loaded sources", async () => {
  sdk.listSources.mockResolvedValue({
    items: [apiSource("s1", { title: "Alpha" }), apiSource("s2", { title: "Beta" })],
  });
  const captured = await renderHook(makeProps());

  expect(captured.api?.selectableSourceIds.slice().sort()).toEqual([
    "s1",
    "s2",
  ]);
  expect(captured.api?.sourceTreeIndex.byParent.get(null)).toHaveLength(2);
  // Nothing is selected yet, so the "all selected" flag is false.
  expect(captured.api?.allSelectableSourcesSelected).toBe(false);
});

test("selection handlers emit the expected ids", async () => {
  sdk.listSources.mockResolvedValue({
    items: [apiSource("s1", { title: "Alpha" }), apiSource("s2", { title: "Beta" })],
  });
  const onSelectionChange = vi.fn();
  const captured = await renderHook(makeProps({ onSelectionChange }));

  // Toggle a single leaf node -> selects just that source.
  const s1 = captured.api!.sources.find((s) => s.id === "s1")!;
  const node: SourceTreeNode = { source: s1, children: [] };
  act(() => {
    captured.api!.handleToggle(node);
  });
  expect(onSelectionChange).toHaveBeenLastCalledWith(["s1"]);

  // Toggle-all (none selected yet) -> selects every selectable source.
  act(() => {
    captured.api!.handleToggleAllSources();
  });
  expect(onSelectionChange.mock.calls.at(-1)![0].slice().sort()).toEqual([
    "s1",
    "s2",
  ]);
});

test("handleConfirmDeleteSource deletes then re-fetches without the source", async () => {
  sdk.listSources
    .mockResolvedValueOnce({
      items: [
        apiSource("s1", { title: "Alpha" }),
        apiSource("s2", { title: "Beta" }),
      ],
    })
    .mockResolvedValue({ items: [apiSource("s2", { title: "Beta" })] });
  sdk.deleteSource.mockResolvedValue(undefined);
  const onSelectionChange = vi.fn();

  const captured = await renderHook(makeProps({ onSelectionChange }));
  const s1 = captured.api!.sources.find((s) => s.id === "s1")!;

  await act(async () => {
    await captured.api!.handleConfirmDeleteSource(s1);
  });
  await flush();

  expect(sdk.deleteSource).toHaveBeenCalledWith("ws1", "s1");
  expect(captured.api?.sources.map((s) => s.id)).toEqual(["s2"]);
  expect(toast.success).toHaveBeenCalledWith("Source deleted.");
});

test("handleCreateTextSource creates + indexes and auto-selects the new source", async () => {
  sdk.listSources
    .mockResolvedValueOnce({ items: [] })
    .mockResolvedValue({ items: [apiSource("s3", { title: "Fresh" })] });
  sdk.createSource.mockResolvedValue({ source: { id: "s3" } });
  sdk.indexSource.mockResolvedValue(undefined);
  const onSelectionChange = vi.fn();
  const addSourceDialog = makeAddSourceDialog({ textContent: "hello world" });

  const captured = await renderHook(
    makeProps({ onSelectionChange, addSourceDialog }),
  );

  await act(async () => {
    await captured.api!.handleCreateTextSource();
  });
  await flush();

  expect(sdk.createSource).toHaveBeenCalledWith("ws1", {
    title: undefined,
    contentText: "hello world",
    parentSourceId: null,
  });
  expect(sdk.indexSource).toHaveBeenCalledWith("ws1", "s3", {});
  expect(addSourceDialog.close).toHaveBeenCalledWith(false);
  expect(captured.api?.sources.map((s) => s.id)).toEqual(["s3"]);
  // The freshly created source is auto-selected once the refresh surfaces it.
  expect(onSelectionChange).toHaveBeenLastCalledWith(["s3"]);
});

test("refreshSources re-fetches and updates the source list", async () => {
  sdk.listSources
    .mockResolvedValueOnce({ items: [apiSource("s1", { title: "Alpha" })] })
    .mockResolvedValue({
      items: [
        apiSource("s1", { title: "Alpha" }),
        apiSource("s2", { title: "Beta" }),
      ],
    });

  const captured = await renderHook(makeProps());
  expect(captured.api?.sources.map((s) => s.id)).toEqual(["s1"]);

  await act(async () => {
    await captured.api!.refreshSources();
  });
  await flush();

  expect(captured.api?.sources.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  expect(sdk.listSources).toHaveBeenCalledTimes(2);
});
