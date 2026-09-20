// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

import type { SourceItem } from "../../source-types";
import type { SourceTreeNode } from "../source-tree";
import { useSources } from "./use-sources";
import messages from "../../../../../../messages/en.json";

const intlMessages = messages as ComponentProps<
  typeof NextIntlClientProvider
>["messages"];

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
    created.render(
      // This file has a .ts extension (no JSX), and NextIntlClientProvider's
      // props type requires `children`, so the 3-arg createElement overload
      // (children as a trailing positional arg) does not type-check here —
      // children must be passed inside the props object.
      // eslint-disable-next-line react/no-children-prop -- see above
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: intlMessages,
        children: createElement(Harness),
      }),
    );
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
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("processing completion updates only that source without loading the list", async () => {
  vi.useFakeTimers();
  sdk.listSources.mockResolvedValue({
    items: [apiSource("ready"), apiSource("upload", { status: "processing" })],
  });
  sdk.listSourceStatuses.mockResolvedValue({
    items: [{ id: "upload", status: { status: "indexed" } }],
  });
  let finish!: (value: unknown) => void;
  sdk.getSource.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const props = makeProps({ selectedIds: ["ready"] });
  const captured = await renderHook(props);
  const unchanged = captured.api!.sources.find((source) => source.id === "ready");
  vi.mocked(props.onSelectionChange).mockClear();

  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(sdk.getSource).toHaveBeenCalledWith("ws1", "upload");
  expect(captured.api!.isLoading).toBe(false);
  // A slow detail request must not start overlapping polls.
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(sdk.listSourceStatuses).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ source: apiSource("upload", { contentText: "Parsed text" }) });
  });
  expect(captured.api!.sources.map((source) => source.id)).toEqual(["ready", "upload"]);
  expect(captured.api!.sources[0]).toBe(unchanged);
  expect(captured.api!.sources[1]).toMatchObject({ status: "Indexed", contentText: "Parsed text" });
  expect(captured.api!.isLoading).toBe(false);
  expect(sdk.listSources).toHaveBeenCalledTimes(1);
  expect(props.onSourceMerge).toHaveBeenLastCalledWith([captured.api!.sources[1]]);
  expect(props.onSelectionChange).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(sdk.listSourceStatuses).toHaveBeenCalledTimes(1);
});

test("failed detail requests retry individually while other completed sources update", async () => {
  vi.useFakeTimers();
  sdk.listSources.mockResolvedValue({
    items: [apiSource("s1", { status: "processing" }), apiSource("s2", { status: "queued" })],
  });
  sdk.listSourceStatuses.mockResolvedValueOnce({
    items: [
      { id: "s1", status: { status: "indexed" } },
      { id: "s2", status: { status: "failed" } },
    ],
  }).mockResolvedValue({ items: [{ id: "s1", status: { status: "indexed" } }] });
  sdk.getSource.mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValueOnce({ source: apiSource("s2", { status: "failed" }) })
    .mockResolvedValueOnce({ source: apiSource("s1") });
  const captured = await renderHook(makeProps());
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(captured.api!.sources.map((source) => source.status)).toEqual(["Syncing", "Failed"]);
  expect(toast.error).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(sdk.listSourceStatuses).toHaveBeenLastCalledWith("ws1", { ids: ["s1"] });
  expect(captured.api!.sources.map((source) => source.status)).toEqual(["Indexed", "Failed"]);
  expect(sdk.listSources).toHaveBeenCalledTimes(1);
  expect(captured.api!.loadingError).toBeNull();
});

test("initial mount loads sources and reports them via onSourceLoad", async () => {
  sdk.listSources.mockResolvedValue({
    items: [
      apiSource("s1", { title: "Alpha" }),
      apiSource("s2", { title: "Beta" }),
    ],
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
    items: [
      apiSource("s1", { title: "Alpha" }),
      apiSource("s2", { title: "Beta" }),
    ],
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
    items: [
      apiSource("s1", { title: "Alpha" }),
      apiSource("s2", { title: "Beta" }),
    ],
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
