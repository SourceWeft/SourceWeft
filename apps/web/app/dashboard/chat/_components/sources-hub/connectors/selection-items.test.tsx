// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type {
  ConnectorActivityItem,
  ConnectorSelectionSpec,
  SourceConnector,
} from "@sourceweft/sdk";
import {
  button,
  click,
  flush,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

const { selectionDescribe, selectionBrowse, listSources } = vi.hoisted(() => ({
  selectionDescribe: vi.fn(),
  selectionBrowse: vi.fn(),
  listSources: vi.fn(),
}));

vi.mock("../../../../../../lib/sdk", () => ({
  connectorsClient: {
    selectionDescribe,
    selectionBrowse,
    selectionSearch: vi.fn(),
  },
  contentClient: { listSources },
}));

vi.mock("@/lib/billing-edition/capabilities", () => ({
  useBillingAvailable: () => false,
}));

import { SelectionItems } from "./selection-items";
import { ConnectorSettingsDialog } from "./settings-dialog";
import type { ConnectorItem } from "./types";

const dropboxSpec: ConnectorSelectionSpec = {
  actions: {
    browse: "dropbox.browse",
    search: "dropbox.search",
    describe: "dropbox.describe",
  },
  kinds: ["folder", "file"],
  maxItems: 500,
};

const toolsSpec: ConnectorSelectionSpec = {
  actions: { browse: "x.browse", describe: "x.describe" },
  kinds: ["item"],
  maxItems: 100,
};

function connectorFor(
  connectorType: string,
  items: Array<{ id: string; kind: string }>,
  configJson: Record<string, unknown> = {},
) {
  return {
    id: "c-1",
    name: "Person",
    status: "active",
    meta: "",
    raw: {
      id: "c-1",
      teamId: "t-1",
      workspaceId: "ws-1",
      connectorType,
      name: "Person",
      configJson: { items, ...configJson },
      oauthAccountId: "acc-1",
      status: "active",
      periodicIndexingEnabled: true,
      indexingFrequencyMinutes: 360,
      lastIndexedAt: null,
      nextScheduledAt: null,
      lastError: null,
      createdBy: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    } as SourceConnector,
  } satisfies ConnectorItem;
}

function dropboxConnector(items: Array<{ id: string; kind: string }>) {
  return connectorFor("dropbox", items);
}

function source(
  externalId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `src-${externalId}`,
    externalId,
    title: null,
    status: "indexed",
    indexedAt: null,
    metadata: {},
    ...overrides,
  };
}

function describeItem(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { pathLower, pathDisplay, meta, ...rest } = overrides as {
    pathLower?: string | null;
    pathDisplay?: string | null;
    meta?: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    id,
    kind: "folder",
    name: null,
    detail: pathDisplay ?? null,
    exists: true,
    ...rest,
    meta: meta ?? (pathLower !== undefined ? { pathLower } : {}),
  };
}

function syncRun(resultJson: Record<string, unknown>): ConnectorActivityItem {
  return {
    id: "run-1",
    kind: "sync",
    status: "succeeded",
    title: "Sync",
    summaryJson: {},
    resultJson,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    startedAt: "2026-11-01T00:00:00.000Z",
    finishedAt: "2026-11-01T00:01:00.000Z",
    durationMs: 60000,
    linkedRunId: null,
    linkedActionId: null,
    linkedWebhookEventId: null,
  };
}

async function mountItems(input: {
  connector: ConnectorItem;
  spec?: ConnectorSelectionSpec;
  latestSyncRun?: ConnectorActivityItem | null;
  onChangeItems?: (
    items: Array<{ id: string; kind: string }>,
  ) => Promise<boolean>;
}) {
  const onChangeItems = input.onChangeItems ?? vi.fn(async () => true);
  const spec = input.spec ?? dropboxSpec;
  const element = (
    connector: ConnectorItem,
    latestSyncRun: ConnectorActivityItem | null,
  ) =>
    createElement(SelectionItems, {
      connector,
      spec,
      latestSyncRun,
      disabled: false,
      onChangeItems,
    });
  const mounted = await mountWithIntl(
    element(input.connector, input.latestSyncRun ?? null),
  );
  await flush(10);
  return {
    container: mounted.container,
    onChangeItems,
    /** Re-render with new props, as the settings dialog does after a save or
     * as a sync advances. */
    async rerender(
      connector: ConnectorItem,
      latestSyncRun: ConnectorActivityItem | null,
    ) {
      await mounted.render(withIntl(element(connector, latestSyncRun)));
      await flush(10);
    },
  };
}

/** Mount the real settings dialog for a Dropbox connector, on its
 * Configuration tab. */
async function mountSettings(
  connector: ConnectorItem,
  overrides: Partial<Parameters<typeof ConnectorSettingsDialog>[0]> = {},
) {
  await mountWithIntl(
    createElement(ConnectorSettingsDialog, {
      activity: [],
      activityError: null,
      connector,
      connectorBusyById: {},
      connectorManifestInfoByType: {},
      connectorReadinessById: {},
      isLoadingActivity: false,
      onCopyWebhook: vi.fn(),
      onDisconnect: vi.fn(),
      onOpenChange: vi.fn(),
      onReconnect: vi.fn(),
      onSaveSettings: vi.fn(async () => true),
      onSyncConnector: vi.fn(),
      onToggleStatus: vi.fn(),
      open: true,
      selectionSpec: dropboxSpec,
      webhookConfig: null,
      ...overrides,
    }),
  );
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (node) => node.textContent?.trim() === "Configuration",
  )!;
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
  await flush(10);
}

function openDialogs() {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
}

function group(container: ParentNode, label: string) {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
}

function rows(scope: ParentNode) {
  return [...scope.querySelectorAll<HTMLElement>("li")].map((row) =>
    row.textContent?.replace(/Remove .*$/, "").trim(),
  );
}

beforeEach(() => {
  selectionDescribe.mockReset();
  selectionBrowse.mockReset();
  listSources.mockReset();
  listSources.mockResolvedValue({ items: [] });
  selectionDescribe.mockResolvedValue({ items: [] });
});

afterEach(unmountAll);

test("groups folders and files with counts and states", async () => {
  listSources.mockResolvedValue({
    items: [
      source("file:id:a1", { title: "Report.pdf", status: "indexed" }),
      source("file:id:in1", {
        status: "indexed",
        metadata: { pathLower: "/work/q3/x.pdf" },
      }),
      source("file:id:in2", {
        status: "processing",
        metadata: { pathLower: "/work/q3/deep/y.md" },
      }),
      // Same prefix, different folder: must not count toward /work/q3.
      source("file:id:in3", { metadata: { pathLower: "/work/q30/z.pdf" } }),
    ],
  });
  selectionDescribe.mockResolvedValue({
    items: [
      describeItem("id:f1", {
        name: "Q3",
        pathDisplay: "/Work/Q3",
        pathLower: "/work/q3",
      }),
      describeItem("id:a2", {
        kind: "file",
        name: "Notes.paper",
        pathDisplay: "/Notes.paper",
        pathLower: "/notes.paper",
      }),
    ],
  });
  const { container } = await mountItems({
    connector: dropboxConnector([
      { id: "id:f1", kind: "folder" },
      { id: "id:a1", kind: "file" },
      { id: "id:a2", kind: "file" },
      { id: "id:a3", kind: "file" },
    ]),
    latestSyncRun: syncRun({
      skippedItems: [
        { externalId: "file:id:a3", title: "huge.pdf", reason: "too_large" },
      ],
    }),
  });

  // Containers are described straight away; a file only once the sources show
  // that neither a source nor a skipped item names it. Each id is asked once.
  expect(selectionDescribe.mock.calls.map((call) => call[2].ids)).toEqual([
    ["id:f1"],
    ["id:a2"],
  ]);

  const folders = group(container, "Folders");
  expect(folders.textContent).toContain("Folders");
  // Only the indexed source counts; the processing one under the folder and
  // the one under /work/q30 do not.
  expect(rows(folders)).toEqual(["Q31 file indexed"]);

  const files = group(container, "Files");
  expect(rows(files)).toEqual([
    "Report.pdfIndexed",
    "Notes.paperDeleted in Dropbox or access was lost",
    "huge.pdfSkippedFile is too large to index",
  ]);
  expect(container.textContent).toContain("4 / 500");
});

test("missing folder shows no longer exists", async () => {
  selectionDescribe.mockResolvedValue({
    items: [describeItem("id:gone", { exists: false, kind: null })],
  });
  const { container } = await mountItems({
    connector: dropboxConnector([{ id: "id:gone", kind: "folder" }]),
  });

  // No name from describe: the row shows the kind placeholder, never the raw
  // id, and keeps the "no longer exists" mark.
  expect(rows(group(container, "Folders"))).toEqual([
    "Folders · Name unavailableNo longer exists",
  ]);
  expect(container.textContent).not.toContain("id:gone");
  expect(group(container, "Files")).toBeNull();
});

test("a row whose details could not be loaded shows a placeholder, not its id", async () => {
  selectionDescribe.mockRejectedValue(new Error("network"));
  const { container } = await mountItems({
    connector: dropboxConnector([{ id: "id:f1", kind: "folder" }]),
  });

  expect(rows(group(container, "Folders"))).toEqual([
    "Folders · Name unavailable",
  ]);
  expect(container.textContent).not.toContain("id:f1");
});

test("an id containing a comma is described intact", async () => {
  // A connector id may contain any character; it must reach describe whole,
  // not split on the separator a joined key would have used.
  await mountItems({
    connector: dropboxConnector([{ id: "id:a,b", kind: "folder" }]),
  });

  expect(selectionDescribe).toHaveBeenCalledTimes(1);
  expect(selectionDescribe.mock.calls[0]![2].ids).toEqual(["id:a,b"]);
});

test("loads sources without their content", async () => {
  await mountItems({ connector: dropboxConnector([]) });

  expect(listSources).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ includeContent: false }),
  );
});

test("describes folders in chunks of at most 100", async () => {
  const items = Array.from({ length: 150 }, (_, index) => ({
    id: `id:f${index}`,
    kind: "folder",
  }));
  await mountItems({ connector: dropboxConnector(items) });

  expect(selectionDescribe).toHaveBeenCalledTimes(2);
  expect(selectionDescribe.mock.calls[0]![2].ids).toHaveLength(100);
  expect(selectionDescribe.mock.calls[1]![2].ids).toEqual(
    items.slice(100).map((item) => item.id),
  );
});

test("a sync status change does not re-describe already-described folders", async () => {
  selectionDescribe.mockResolvedValue({
    items: [describeItem("id:f1", { name: "Q3", pathLower: "/q3" })],
  });
  const connector = dropboxConnector([{ id: "id:f1", kind: "folder" }]);
  const running = { ...syncRun({}), status: "running" };
  const mounted = await mountItems({ connector, latestSyncRun: running });
  expect(selectionDescribe).toHaveBeenCalledTimes(1);
  expect(listSources).toHaveBeenCalledTimes(1);

  await mounted.rerender(connector, syncRun({}));

  // The sources reload for the new run status, but the folder is not asked
  // about again.
  expect(listSources).toHaveBeenCalledTimes(2);
  expect(selectionDescribe).toHaveBeenCalledTimes(1);
  expect(rows(group(mounted.container, "Folders"))).toEqual([
    "Q30 files indexed",
  ]);
});

test("a failed describe keeps previously known names", async () => {
  selectionDescribe.mockResolvedValueOnce({
    items: [describeItem("id:f1", { name: "Q3", pathLower: "/q3" })],
  });
  const mounted = await mountItems({
    connector: dropboxConnector([{ id: "id:f1", kind: "folder" }]),
  });
  expect(rows(group(mounted.container, "Folders"))).toEqual([
    "Q30 files indexed",
  ]);

  selectionDescribe.mockRejectedValueOnce(new Error("network"));
  await mounted.rerender(
    dropboxConnector([
      { id: "id:f1", kind: "folder" },
      { id: "id:f2", kind: "folder" },
    ]),
    null,
  );

  // Only the new folder is described; its failure leaves the known name and the
  // new row shows the placeholder rather than its id.
  expect(selectionDescribe).toHaveBeenCalledTimes(2);
  expect(selectionDescribe.mock.calls[1]![2].ids).toEqual(["id:f2"]);
  expect(rows(group(mounted.container, "Folders"))).toEqual([
    "Q30 files indexed",
    "Folders · Name unavailable",
  ]);
});

test("describe chunks run one at a time", async () => {
  const resolvers: Array<() => void> = [];
  selectionDescribe.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve({ items: [] }));
      }),
  );
  const items = Array.from({ length: 150 }, (_, index) => ({
    id: `id:f${index}`,
    kind: "folder",
  }));
  await mountItems({ connector: dropboxConnector(items) });
  expect(selectionDescribe).toHaveBeenCalledTimes(1);

  await act(async () => resolvers[0]!());
  await flush(10);
  expect(selectionDescribe).toHaveBeenCalledTimes(2);
  await act(async () => resolvers[1]!());
  await flush(10);
  expect(selectionDescribe).toHaveBeenCalledTimes(2);
});

test("a failed chunk is not retried when a later chunk succeeds", async () => {
  selectionDescribe
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({
      items: [describeItem("id:f100", { name: "Last", pathLower: "/last" })],
    });
  const items = Array.from({ length: 101 }, (_, index) => ({
    id: `id:f${index}`,
    kind: "folder",
  }));
  const { container } = await mountItems({
    connector: dropboxConnector(items),
  });

  expect(selectionDescribe).toHaveBeenCalledTimes(2);
  const shown = rows(group(container, "Folders"));
  expect(shown[0]).toBe("Folders · Name unavailable");
  expect(shown[100]).toBe("Last0 files indexed");
});

test("tools-only connectors list names from describe and no state badges", async () => {
  selectionDescribe.mockResolvedValue({
    items: [
      describeItem("t1", {
        kind: "item",
        name: "Alpha",
        detail: "path/alpha",
      }),
      describeItem("t2", { kind: null, name: null, exists: false }),
    ],
  });
  const { container } = await mountItems({
    connector: connectorFor("unknown-type", [
      { id: "t1", kind: "item" },
      { id: "t2", kind: "item" },
    ]),
    spec: toolsSpec,
  });

  // A tools-only connector loads no sources and describes every selected id.
  expect(listSources).not.toHaveBeenCalled();
  expect(selectionDescribe).toHaveBeenCalledTimes(1);
  expect(selectionDescribe.mock.calls[0]![2].ids).toEqual(["t1", "t2"]);

  const section = group(container, "item");
  expect(rows(section)).toEqual([
    "Alphapath/alpha",
    "item · Name unavailableNo longer exists",
  ]);
  // No index-state badges for a tools-only connector.
  expect(container.textContent).not.toContain("Waiting for sync");
  expect(container.textContent).not.toContain("Indexed");
});

test("Escape closes the browser but not the settings dialog", async () => {
  selectionBrowse.mockResolvedValue({
    container: null,
    breadcrumbs: [],
    entries: [],
    cursor: "end",
    hasMore: false,
    helpLink: null,
  });
  const onOpenChange = vi.fn();
  await mountSettings(dropboxConnector([]), { onOpenChange });
  await click(button("Choose files"));
  await flush(10);

  expect(openDialogs()).toHaveLength(2);
  const browser = openDialogs().find((node) =>
    node.textContent?.includes("Choose from Dropbox"),
  )!;
  await act(async () => {
    browser.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await flush(10);

  const remaining = openDialogs();
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.textContent).not.toContain("Choose from Dropbox");
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
});

test("remove saves then syncs", async () => {
  selectionDescribe.mockResolvedValue({
    items: [describeItem("id:f1", { name: "Q3", pathLower: "/q3" })],
  });
  listSources.mockResolvedValue({
    items: [source("file:id:a1", { title: "Report.pdf" })],
  });
  const connector = dropboxConnector([
    { id: "id:f1", kind: "folder" },
    { id: "id:a1", kind: "file" },
  ]);
  const calls: string[] = [];
  const onSaveSettings = vi.fn(async () => {
    calls.push("save");
    return true;
  });
  const onSyncConnector = vi.fn(() => {
    calls.push("sync");
  });
  await mountSettings(connector, { onSaveSettings, onSyncConnector });

  await click(document.querySelector<HTMLElement>('button[title="Remove Q3"]')!);
  await flush(5);

  expect(onSaveSettings).toHaveBeenCalledWith(connector, {
    name: "Person",
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 360,
    configJson: { items: [{ id: "id:a1", kind: "file" }] },
  });
  expect(onSyncConnector).toHaveBeenCalledWith(connector);
  expect(calls).toEqual(["save", "sync"]);
});

test("keeps other config keys when the selection changes", async () => {
  selectionDescribe.mockResolvedValue({
    items: [describeItem("id:f1", { name: "Q3", pathLower: "/q3" })],
  });
  const connector = connectorFor("dropbox", [{ id: "id:f1", kind: "folder" }], {
    liveSearchEnabled: true,
  });
  const onSaveSettings = vi.fn(async () => true);
  await mountSettings(connector, { onSaveSettings });

  await click(document.querySelector<HTMLElement>('button[title="Remove Q3"]')!);
  await flush(5);

  expect(onSaveSettings).toHaveBeenCalledWith(connector, {
    name: "Person",
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 360,
    configJson: { items: [], liveSearchEnabled: true },
  });
});
