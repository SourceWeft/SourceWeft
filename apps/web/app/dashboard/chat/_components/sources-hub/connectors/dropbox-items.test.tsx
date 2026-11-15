// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { ConnectorActivityItem, SourceConnector } from "@sourceweft/sdk";
import { click, flush, mountWithIntl, unmountAll } from "@/test/react";

const { dropboxDescribe, listSources } = vi.hoisted(() => ({
  dropboxDescribe: vi.fn(),
  listSources: vi.fn(),
}));

vi.mock("../../../../../../lib/sdk", () => ({
  connectorsClient: {
    dropboxDescribe,
    dropboxBrowse: vi.fn(),
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
  const mounted = await mountWithIntl(
    createElement(DropboxItems, {
      connector: input.connector,
      latestSyncRun: input.latestSyncRun ?? null,
      disabled: false,
      onChangeItems,
    }),
  );
  await flush(10);
  return { container: mounted.container, onChangeItems };
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

  // Folders are always described; a file only when no source or skipped item
  // names it.
  expect(dropboxDescribe).toHaveBeenCalledTimes(1);
  expect(dropboxDescribe).toHaveBeenCalledWith("ws-1", "c-1", {
    ids: ["id:f1", "id:a2"],
  });

  const folders = group(container, "Folders");
  expect(folders.textContent).toContain("Folders");
  expect(rows(folders)).toEqual(["Q32 files indexed"]);

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
      onSaveSettings,
      onSyncConnector,
      onToggleStatus: vi.fn(),
      open: true,
      webhookConfig: null,
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
