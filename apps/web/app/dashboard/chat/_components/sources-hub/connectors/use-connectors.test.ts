// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { HttpClientError, type SourceConnector } from "@sourceweft/sdk";
import { useConnectors } from "./use-connectors";
import { flush, mountWithIntl, unmountAll, withIntl } from "@/test/react";

// The hook imports `connectorsClient` from the web app's SDK barrel. From this
// `connectors/` subdir that module is six levels up (one deeper than the
// sources-hub index.tsx which uses "../../../../../lib/sdk").
const {
  list,
  listAccounts,
  listManifests,
  getWebhookConfig,
  listWebhookEvents,
  listActivity,
  sync,
  update,
  deleteConnector,
  deleteAccount,
  create,
} = vi.hoisted(() => ({
  list: vi.fn(),
  listAccounts: vi.fn(),
  listManifests: vi.fn(),
  getWebhookConfig: vi.fn(),
  listWebhookEvents: vi.fn(),
  listActivity: vi.fn(),
  sync: vi.fn(),
  update: vi.fn(),
  deleteConnector: vi.fn(),
  deleteAccount: vi.fn(),
  create: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({ userId: "user-1" }));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: sessionState.userId } } }),
  },
}));

vi.mock("../../../../../../lib/sdk", () => ({
  connectorsClient: {
    list,
    listAccounts,
    listManifests,
    getWebhookConfig,
    listWebhookEvents,
    listActivity,
    sync,
    update,
    delete: deleteConnector,
    deleteAccount,
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
  function Harness(props: HookInput) {
    latest = useConnectors(props);
    return null;
  }
  await mountWithIntl(createElement(Harness, input));
  // Let the mount-time refreshConnectors() resolve.
  await flush(25);
}

function api(): HookApi {
  if (!latest) throw new Error("hook not mounted");
  return latest;
}

beforeEach(() => {
  sessionState.userId = "user-1";
  for (const fn of [
    list,
    listAccounts,
    listManifests,
    getWebhookConfig,
    listWebhookEvents,
    listActivity,
    sync,
    update,
    deleteConnector,
    deleteAccount,
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
  listManifests.mockResolvedValue({ items: [{ type: "notion" }] });
  listActivity.mockResolvedValue({ items: [] });
  getWebhookConfig.mockResolvedValue(null);
  listWebhookEvents.mockResolvedValue({ items: [] });
});

afterEach(async () => {
  await unmountAll();
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
  await flush(25);

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

test("account switch clears prior manifest eligibility even while the next fetch is pending", async () => {
  listManifests.mockResolvedValueOnce({ items: [{ type: "gmail" }] });
  const input = baseInput("ws-shared-preview");
  function Harness() {
    latest = useConnectors(input);
    return null;
  }
  const view = await mountWithIntl(createElement(Harness));
  await flush(25);
  expect(api().availableConnectorTypes).toEqual(["gmail"]);
  listManifests.mockImplementationOnce(() => new Promise(() => {}));
  sessionState.userId = "user-2";
  await view.render(withIntl(createElement(Harness)));
  expect(api().availableConnectorTypes).toEqual([]);
});

test("failed manifest refresh clears old Gmail eligibility", async () => {
  listManifests.mockResolvedValueOnce({ items: [{ type: "gmail" }] });
  await mountHook(baseInput("ws-preview-error"));
  expect(api().availableConnectorTypes).toEqual(["gmail"]);
  listManifests.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await api().refreshConnectors();
  });
  expect(api().availableConnectorTypes).toEqual([]);
});

// --- Reconnecting an existing connector -----------------------------------
// The provider redirects back with the authorization's account id in the URL.
// The hook handles it on mount, before its own connector list has loaded.

function returnFromAuthorization(input: {
  workspaceId: string;
  connectorType: string;
  accountId: string;
}) {
  const url = new URL(window.location.href);
  url.searchParams.set("connector_oauth", "success");
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("connector_type", input.connectorType);
  url.searchParams.set("account_id", input.accountId);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function driveConnector(overrides: Partial<SourceConnector> = {}) {
  return fakeConnector({
    id: "drive-1",
    connectorType: "google_drive",
    name: "Person",
    oauthAccountId: "acc-1",
    configJson: { fileIds: ["file-1"] },
    ...overrides,
  });
}

test("reconnecting with the same account keeps the connector and clears its error", async () => {
  list.mockResolvedValue({
    items: [driveConnector({ status: "error", lastError: "request failed" })],
  });
  update.mockResolvedValue({ connector: driveConnector() });
  returnFromAuthorization({
    workspaceId: "ws-reconnect",
    connectorType: "google_drive",
    accountId: "acc-1",
  });

  await mountHook(baseInput("ws-reconnect"));

  expect(update).toHaveBeenCalledWith("ws-reconnect", "drive-1", {
    status: "active",
  });
  expect(create).not.toHaveBeenCalled();
  expect(deleteAccount).not.toHaveBeenCalled();
  expect(toastSuccess).toHaveBeenCalledWith("Google Drive reconnected.");
  expect(toastError).not.toHaveBeenCalled();
  expect(window.location.search).not.toContain("connector_oauth");
});

test("reconnecting a connector that is not in error leaves its status alone", async () => {
  list.mockResolvedValue({ items: [driveConnector({ status: "paused" })] });
  returnFromAuthorization({
    workspaceId: "ws-reconnect-paused",
    connectorType: "google_drive",
    accountId: "acc-1",
  });

  await mountHook(baseInput("ws-reconnect-paused"));

  expect(update).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(toastSuccess).toHaveBeenCalledWith("Google Drive reconnected.");
});

test("reconnecting with a different account is refused and removes the unused authorization", async () => {
  list.mockResolvedValue({ items: [driveConnector()] });
  deleteAccount.mockResolvedValue({ deleted: true });
  returnFromAuthorization({
    workspaceId: "ws-reconnect-other",
    connectorType: "google_drive",
    accountId: "acc-2",
  });

  await mountHook(baseInput("ws-reconnect-other"));

  expect(toastError).toHaveBeenCalledWith(
    "That is a different Google Drive account. Reconnect with the account this connector already uses.",
  );
  expect(deleteAccount).toHaveBeenCalledWith("ws-reconnect-other", "acc-2");
  expect(update).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(toastSuccess).not.toHaveBeenCalled();
});

test("a Gmail reconnect refused for a different account removes the unused authorization", async () => {
  list.mockResolvedValue({
    items: [
      fakeConnector({
        id: "gmail-1",
        connectorType: "gmail",
        oauthAccountId: "acc-1",
      }),
    ],
  });
  update.mockRejectedValue(
    new HttpClientError({
      message: "Reconnect with the same provider account in this workspace",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_OAUTH_ACCOUNT_MISMATCH",
    }),
  );
  deleteAccount.mockResolvedValue({ deleted: true });
  returnFromAuthorization({
    workspaceId: "ws-gmail-other",
    connectorType: "gmail",
    accountId: "acc-2",
  });

  await mountHook(baseInput("ws-gmail-other"));

  expect(update).toHaveBeenCalledWith("ws-gmail-other", "gmail-1", {
    oauthAccountId: "acc-2",
    status: "active",
  });
  expect(toastError).toHaveBeenCalledWith(
    "Reconnect with the same provider account in this workspace",
  );
  expect(deleteAccount).toHaveBeenCalledWith("ws-gmail-other", "acc-2");
});

test("a first authorization still creates the connector", async () => {
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-1",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  create.mockResolvedValue({ connector: driveConnector() });
  returnFromAuthorization({
    workspaceId: "ws-first",
    connectorType: "google_drive",
    accountId: "acc-1",
  });

  await mountHook(baseInput("ws-first"));

  expect(create).toHaveBeenCalledWith(
    "ws-first",
    expect.objectContaining({
      connectorType: "google_drive",
      oauthAccountId: "acc-1",
      configJson: { fileIds: [] },
    }),
  );
  expect(update).not.toHaveBeenCalled();
  expect(toastSuccess).toHaveBeenCalledWith("Google Drive connected.");
});

test("handleReconnectConnector starts authorization for the connector's provider", async () => {
  list.mockResolvedValue({ items: [driveConnector()] });
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...original,
      href: original.href,
      origin: original.origin,
      assign,
    },
  });
  try {
    await mountHook(baseInput("ws-start"));
    act(() => {
      api().handleReconnectConnector(api().connectors[0]!);
    });

    expect(assign).toHaveBeenCalledTimes(1);
    const target = new URL(String(assign.mock.calls[0]![0]));
    expect(target.pathname).toBe("/dashboard/connectors/oauth/start");
    expect(target.searchParams.get("connector_type")).toBe("google_drive");
    expect(target.searchParams.get("workspace_id")).toBe("ws-start");
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
});
