// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { ConnectorActivityItem, SourceConnector } from "@sourceweft/sdk";
import {
  button,
  click,
  flush,
  mountWithIntl,
  unmountAll,
  withIntl,
} from "@/test/react";

const { dropboxDescribe, dropboxBrowse, listSources } = vi.hoisted(() => ({
  dropboxDescribe: vi.fn(),
  dropboxBrowse: vi.fn(),
  listSources: vi.fn(),
}));

vi.mock("../../../../../../lib/sdk", () => ({
  connectorsClient: {
    dropboxDescribe,
    dropboxBrowse,
    dropboxSearch: vi.fn(),
  },
  contentClient: { listSources },
}));

vi.mock("@/lib/billing-edition/capabilities", () => ({
  useBillingAvailable: () => false,
}));

import { DropboxItems } from "./dropbox-items";
import { ConnectorSettingsDialog } from "./settings-dialog";
import type { ConnectorItem } from "./types";

function dropboxConnector(items: Array<{ id: string; kind: string }>) {
  return {
    id: "c-1",
    name: "Person",
    status: "active",
    meta: "",
    raw: {
      id: "c-1",
      teamId: "t-1",
      workspaceId: "ws-1",
      connectorType: "dropbox",
      name: "Person",
      configJson: { items },
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
  return {
    id,
    kind: "folder",
    name: null,
    pathDisplay: null,
    pathLower: null,
    exists: true,
    ...overrides,
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
  latestSyncRun?: ConnectorActivityItem | null;
  onChangeItems?: (
    items: Array<{ id: string; kind: "file" | "folder" }>,
  ) => Promise<boolean>;
}) {
  const onChangeItems = input.onChangeItems ?? vi.fn(async () => true);
  const element = (
    connector: ConnectorItem,
    latestSyncRun: ConnectorActivityItem | null,
  ) =>
    createElement(DropboxItems, {
      connector,
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
      webhookConfig: null,
      ...overrides,
    }),
  );
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (node) => node.textContent?.trim() === "Configuration",
  )!;
  await act(async () => {
    tab.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
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
  dropboxDescribe.mockReset();
  dropboxBrowse.mockReset();
  listSources.mockReset();
  listSources.mockResolvedValue({ items: [] });
  dropboxDescribe.mockResolvedValue({ items: [] });
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
  dropboxDescribe.mockResolvedValue({
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

  // Folders are described straight away; a file only once the sources show
  // that neither a source nor a skipped item names it. Each id is asked once.
  expect(dropboxDescribe.mock.calls.map((call) => call[2].ids)).toEqual([
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
  dropboxDescribe.mockResolvedValue({
    items: [describeItem("id:gone", { exists: false, kind: null })],
  });
  const { container } = await mountItems({
    connector: dropboxConnector([{ id: "id:gone", kind: "folder" }]),
  });

  // No name from describe: the row falls back to the id.
  expect(rows(group(container, "Folders"))).toEqual([
    "id:goneNo longer exists",
  ]);
  expect(group(container, "Files")).toBeNull();
});

test("a failed describe falls back to ids", async () => {
  dropboxDescribe.mockRejectedValue(new Error("network"));
  const { container } = await mountItems({
    connector: dropboxConnector([{ id: "id:f1", kind: "folder" }]),
  });

  expect(rows(group(container, "Folders"))).toEqual(["id:f1"]);
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

  expect(dropboxDescribe).toHaveBeenCalledTimes(2);
  expect(dropboxDescribe.mock.calls[0]![2].ids).toHaveLength(100);
  expect(dropboxDescribe.mock.calls[1]![2].ids).toEqual(
    items.slice(100).map((item) => item.id),
  );
});

test("a sync status change does not re-describe already-described folders", async () => {
  dropboxDescribe.mockResolvedValue({
    items: [describeItem("id:f1", { name: "Q3", pathLower: "/q3" })],
  });
  const connector = dropboxConnector([{ id: "id:f1", kind: "folder" }]);
  const running = { ...syncRun({}), status: "running" };
  const mounted = await mountItems({ connector, latestSyncRun: running });
  expect(dropboxDescribe).toHaveBeenCalledTimes(1);
  expect(listSources).toHaveBeenCalledTimes(1);

  await mounted.rerender(connector, syncRun({}));

  // The sources reload for the new run status, but the folder is not asked
  // about again.
  expect(listSources).toHaveBeenCalledTimes(2);
  expect(dropboxDescribe).toHaveBeenCalledTimes(1);
  expect(rows(group(mounted.container, "Folders"))).toEqual([
    "Q30 files indexed",
  ]);
});

test("a failed describe keeps previously known names", async () => {
  dropboxDescribe.mockResolvedValueOnce({
    items: [describeItem("id:f1", { name: "Q3", pathLower: "/q3" })],
  });
  const mounted = await mountItems({
    connector: dropboxConnector([{ id: "id:f1", kind: "folder" }]),
  });
  expect(rows(group(mounted.container, "Folders"))).toEqual([
    "Q30 files indexed",
  ]);

  dropboxDescribe.mockRejectedValueOnce(new Error("network"));
  await mounted.rerender(
    dropboxConnector([
      { id: "id:f1", kind: "folder" },
      { id: "id:f2", kind: "folder" },
    ]),
    null,
  );

  // Only the new folder is described; its failure leaves the known name.
  expect(dropboxDescribe).toHaveBeenCalledTimes(2);
  expect(dropboxDescribe.mock.calls[1]![2].ids).toEqual(["id:f2"]);
  expect(rows(group(mounted.container, "Folders"))).toEqual([
    "Q30 files indexed",
    "id:f2",
  ]);
});

test("describe chunks run one at a time", async () => {
  const resolvers: Array<() => void> = [];
  dropboxDescribe.mockImplementation(
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
  expect(dropboxDescribe).toHaveBeenCalledTimes(1);

  await act(async () => resolvers[0]!());
  await flush(10);
  expect(dropboxDescribe).toHaveBeenCalledTimes(2);
  await act(async () => resolvers[1]!());
  await flush(10);
  expect(dropboxDescribe).toHaveBeenCalledTimes(2);
});

test("a failed chunk is not retried when a later chunk succeeds", async () => {
  dropboxDescribe
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

  expect(dropboxDescribe).toHaveBeenCalledTimes(2);
  const shown = rows(group(container, "Folders"));
  expect(shown[0]).toBe("id:f0");
  expect(shown[100]).toBe("Last0 files indexed");
});

test("Escape closes the browser but not the settings dialog", async () => {
  dropboxBrowse.mockResolvedValue({
    folder: null,
    breadcrumbs: [],
    entries: [],
    cursor: "end",
    hasMore: false,
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
  dropboxDescribe.mockResolvedValue({
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

  await click(
    document.querySelector<HTMLElement>('button[title="Remove Q3"]')!,
  );
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
