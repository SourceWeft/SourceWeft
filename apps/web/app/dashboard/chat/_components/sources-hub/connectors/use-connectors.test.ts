// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { SourceConnector } from "@sourceweft/sdk";
import { useConnectors } from "./use-connectors";

// The hook imports `connectorsClient` from the web app's SDK barrel. From this
// `connectors/` subdir that module is six levels up (one deeper than the
// sources-hub index.tsx which uses "../../../../../lib/sdk").
const {
  list,
  listAccounts,
  getWebhookConfig,
  listWebhookEvents,
  listActivity,
  sync,
  update,
  deleteConnector,
  create,
} = vi.hoisted(() => ({
  list: vi.fn(),
  listAccounts: vi.fn(),
  getWebhookConfig: vi.fn(),
  listWebhookEvents: vi.fn(),
  listActivity: vi.fn(),
  sync: vi.fn(),
  update: vi.fn(),
  deleteConnector: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../../../../../../lib/sdk", () => ({
  connectorsClient: {
    list,
    listAccounts,
    getWebhookConfig,
    listWebhookEvents,
    listActivity,
    sync,
    update,
    delete: deleteConnector,
    create,
  },
}));

const { toastError, toastSuccess, toastInfo } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
    info: toastInfo,
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function flushMicrotasks() {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
  }
}

function fakeConnector(
  overrides: Partial<SourceConnector> = {},
): SourceConnector {
  return {
    id: "c1",
    teamId: "t1",
    workspaceId: "ws",
    // A connectorType that is NOT in the catalog so the webhook-config fetch
    // path is skipped entirely (catalogItem is undefined -> no extra calls).
    connectorType: "test-connector",
    name: "Test Connector",
    configJson: {},
    oauthAccountId: null,
    status: "active",
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: null,
    lastIndexedAt: null,
    nextScheduledAt: null,
    lastError: null,
    createdBy: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type HookInput = Parameters<typeof useConnectors>[0];
type HookApi = ReturnType<typeof useConnectors>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: HookApi | null = null;

function baseInput(
  workspaceId: string,
  overrides: Partial<HookInput> = {},
): HookInput {
  return {
    workspaceId,
    currentWorkspaceIdRef: { current: workspaceId },
    onConnectorsChange: vi.fn(),
    trackConnectorSyncRun: vi.fn(),
    refreshSources: vi.fn(),
    sources: [],
    manualConnectorSyncSourcesRef: { current: new Map() },
    ...overrides,
  };
}

async function mountHook(input: HookInput) {
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  function Harness(props: HookInput) {
    latest = useConnectors(props);
    return null;
  }
  await act(async () => {
    created.render(createElement(Harness, input));
  });
  // Let the mount-time refreshConnectors() resolve.
  await act(async () => {
    await flushMicrotasks();
  });
}

function api(): HookApi {
  if (!latest) throw new Error("hook not mounted");
  return latest;
}

beforeEach(() => {
  for (const fn of [
    list,
    listAccounts,
    getWebhookConfig,
    listWebhookEvents,
    listActivity,
    sync,
    update,
    deleteConnector,
    create,
    toastError,
    toastSuccess,
    toastInfo,
  ]) {
    fn.mockReset();
  }
  // Sensible defaults; individual tests override as needed.
  list.mockResolvedValue({ items: [] });
  listAccounts.mockResolvedValue({ items: [] });
  listActivity.mockResolvedValue({ items: [] });
  getWebhookConfig.mockResolvedValue(null);
  listWebhookEvents.mockResolvedValue({ items: [] });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

test("initial load populates connectors and accounts and clears loading", async () => {
  const onConnectorsChange = vi.fn();
  list.mockResolvedValue({ items: [fakeConnector()] });
  listAccounts.mockResolvedValue({
    items: [
      { id: "acc1", status: "active", createdAt: "2024-01-01T00:00:00.000Z" },
    ],
  });

  await mountHook(baseInput("ws-load", { onConnectorsChange }));

  expect(list).toHaveBeenCalledWith("ws-load", { includeDisabled: true });
  expect(listAccounts).toHaveBeenCalledWith("ws-load");
  expect(api().connectors).toHaveLength(1);
  expect(api().connectors[0]).toMatchObject({
    id: "c1",
    name: "Test Connector",
    status: "active",
  });
  expect(api().connectorAccounts).toHaveLength(1);
  expect(api().isLoadingConnectors).toBe(false);
  expect(api().connectorsLoadingError).toBeNull();
  // Raw SDK items are forwarded to the change callback.
  expect(onConnectorsChange).toHaveBeenCalledTimes(1);
  expect(onConnectorsChange.mock.calls[0]![0]).toHaveLength(1);
});

test("load error sets connectorsLoadingError and clears loading", async () => {
  list.mockRejectedValue(new Error("boom"));

  await mountHook(baseInput("ws-error"));

  expect(api().connectorsLoadingError).toBe("boom");
  expect(api().isLoadingConnectors).toBe(false);
  expect(api().connectors).toHaveLength(0);
});

test("handleSyncConnector marks connector busy, syncs, tracks run, then clears busy", async () => {
  const trackConnectorSyncRun = vi.fn();
  list.mockResolvedValue({ items: [fakeConnector()] });
  sync.mockResolvedValue({
    run: {
      id: "run1",
      connectorId: "c1",
      discoveredCount: 0,
      indexedCount: 0,
      failedCount: 0,
    },
    skipped: false,
    alreadyRunning: false,
  });

  await mountHook(baseInput("ws-sync", { trackConnectorSyncRun }));
  const connector = api().connectors[0]!;

  // Kick off the async handler without awaiting its internal promise so we can
  // observe the busy flag being set synchronously before the first await.
  act(() => {
    void api().handleSyncConnector(connector);
  });
  expect(api().connectorBusyById[connector.id]).toBe(true);

  // Now let the sync + follow-up refresh resolve.
  await act(async () => {
    await flushMicrotasks();
  });

  expect(sync).toHaveBeenCalledWith("ws-sync", "c1");
  expect(trackConnectorSyncRun).toHaveBeenCalledTimes(1);
  expect(api().connectorBusyById[connector.id]).toBeUndefined();
});

test("handleToggleConnectorStatus pauses an active connector via update", async () => {
  list.mockResolvedValue({ items: [fakeConnector({ status: "active" })] });
  update.mockResolvedValue({});

  await mountHook(baseInput("ws-toggle"));
  const connector = api().connectors[0]!;

  await act(async () => {
    await api().handleToggleConnectorStatus(connector);
    await flushMicrotasks();
  });

  expect(update).toHaveBeenCalledWith("ws-toggle", "c1", { status: "paused" });
  expect(api().connectorBusyById[connector.id]).toBeUndefined();
});

test("openConnectorSettings resolves connectorSettingsConnector; unknown id toasts", async () => {
  list.mockResolvedValue({ items: [fakeConnector()] });

  await mountHook(baseInput("ws-settings"));
  const connector = api().connectors[0]!;

  await act(async () => {
    api().openConnectorSettings(connector);
    await flushMicrotasks();
  });
  expect(api().connectorSettingsConnector?.id).toBe("c1");

  // handleOpenConnectorSettingsById with an unknown id surfaces an error toast
  // and leaves the selection untouched.
  await act(async () => {
    api().handleOpenConnectorSettingsById("does-not-exist");
    await flushMicrotasks();
  });
  expect(toastError).toHaveBeenCalledWith(
    "Connector settings are not available yet.",
  );
  expect(api().connectorSettingsConnector?.id).toBe("c1");
});

test("handleOpenConnectorSettingsById selects a known connector", async () => {
  list.mockResolvedValue({ items: [fakeConnector()] });

  await mountHook(baseInput("ws-settings-byid"));

  await act(async () => {
    api().handleOpenConnectorSettingsById("c1");
    await flushMicrotasks();
  });

  expect(api().connectorSettingsConnector?.id).toBe("c1");
});

test("handleConfirmDisconnectConnector deletes (soft) and clears pending state", async () => {
  const refreshSources = vi.fn();
  list.mockResolvedValue({ items: [fakeConnector()] });
  deleteConnector.mockResolvedValue({ hardDeleted: false });

  await mountHook(baseInput("ws-disconnect", { refreshSources }));
  const connector = api().connectors[0]!;

  await act(async () => {
    api().setPendingDisconnectConnector(connector);
    await flushMicrotasks();
  });
  expect(api().pendingDisconnectConnector?.id).toBe("c1");

  await act(async () => {
    await api().handleConfirmDisconnectConnector();
    await flushMicrotasks();
  });

  // disconnectConnectorHardDelete defaults to false -> disable: true.
  expect(deleteConnector).toHaveBeenCalledWith("ws-disconnect", "c1", {
    disable: true,
  });
  expect(api().pendingDisconnectConnector).toBeNull();
  // Soft delete (not hardDeleted) must NOT trigger a sources refresh.
  expect(refreshSources).not.toHaveBeenCalled();
});
