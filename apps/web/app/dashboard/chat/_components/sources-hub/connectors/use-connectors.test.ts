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
  checkConfig,
  rotateCredential,
  startCredentialFlow,
  pollCredentialFlow,
  cancelCredentialFlow,
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
  checkConfig: vi.fn(),
  rotateCredential: vi.fn(),
  startCredentialFlow: vi.fn(),
  pollCredentialFlow: vi.fn(),
  cancelCredentialFlow: vi.fn(),
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
    checkConfig,
    rotateCredential,
    startCredentialFlow,
    pollCredentialFlow,
    cancelCredentialFlow,
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

// Add a tools-only connector type (no indexing, hidden behind rollout) to the
// catalog so a selection-spec connect can be driven through the OAuth return.
vi.mock("./catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalog")>();
  const { Box } = await import("lucide-react");
  return {
    ...actual,
    connectorCatalog: [
      ...actual.connectorCatalog,
      {
        id: "x-tools",
        name: "X Tools",
        category: "Knowledge & Docs",
        description: "",
        capabilities: [],
        postOAuthMode: "auto_create",
        requiresBackendRegistration: true,
        isIndexable: false,
        supportsPeriodicSync: false,
        supportsActions: true,
        supportsWebhook: false,
        icon: Box,
      },
    ],
  };
});

const dropboxSelectionSpec = {
  actions: {
    browse: "dropbox.browse",
    search: "dropbox.search",
    describe: "dropbox.describe",
  },
  kinds: ["folder", "file"],
  maxItems: 500,
};
const toolsSelectionSpec = {
  actions: { browse: "x.browse", describe: "x.describe" },
  kinds: ["item"],
  maxItems: 100,
};
const githubSelectionSpec = {
  actions: {
    browse: "github.browse",
    search: "github.search",
    describe: "github.describe",
  },
  kinds: ["account", "repository"],
  maxItems: 20,
};

const linearSelectionSpec = {
  actions: {
    browse: "linear.browse",
    search: "linear.search",
    describe: "linear.describe",
  },
  kinds: ["team", "project"],
  maxItems: 100,
};

const jiraSelectionSpec = {
  actions: {
    browse: "jira.browse",
    search: "jira.search",
    describe: "jira.describe",
  },
  kinds: ["site", "project"],
  maxItems: 100,
};

const confluenceSelectionSpec = {
  actions: {
    browse: "confluence.browse",
    search: "confluence.search",
    describe: "confluence.describe",
  },
  kinds: ["site", "space", "page"],
  maxItems: 100,
};

async function flushMicrotasks() {
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve();
  }
}

// Minimal shapes the hook actually reads (`auth.kind`/`auth.broker` and
// `sync.resources.length`), not the full `ConnectorManifest` contract shape —
// nothing else in the hook touches a manifest field.
function fakeManifest(
  type: string,
  overrides: {
    resources?: unknown[];
    auth?: { kind: "oauth2" } | { kind: "brokered"; broker: string };
  } = {},
) {
  return {
    type,
    auth: overrides.auth ?? { kind: "oauth2" },
    sync: { resources: overrides.resources ?? [{ type: "resource" }] },
  };
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
    checkConfig,
    rotateCredential,
    startCredentialFlow,
    pollCredentialFlow,
    cancelCredentialFlow,
    toastError,
    toastSuccess,
    toastInfo,
  ]) {
    fn.mockReset();
  }
  // Sensible defaults; individual tests override as needed.
  list.mockResolvedValue({ items: [] });
  listAccounts.mockResolvedValue({ items: [] });
  listManifests.mockResolvedValue({
    items: [
      fakeManifest("notion"),
      { ...fakeManifest("dropbox"), selection: dropboxSelectionSpec },
    ],
  });
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
  listManifests.mockResolvedValueOnce({ items: [fakeManifest("gmail")] });
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
  listManifests.mockResolvedValueOnce({ items: [fakeManifest("gmail")] });
  await mountHook(baseInput("ws-preview-error"));
  expect(api().availableConnectorTypes).toEqual(["gmail"]);
  listManifests.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await api().refreshConnectors();
  });
  expect(api().availableConnectorTypes).toEqual([]);
});

test("connectorManifestInfoByType derives supportsIndexing and broker from each manifest", async () => {
  listManifests.mockResolvedValueOnce({
    items: [
      fakeManifest("notion"),
      fakeManifest("gmail", {
        resources: [],
        auth: { kind: "brokered", broker: "composio" },
      }),
    ],
  });

  await mountHook(baseInput("ws-manifest-info"));

  expect(api().connectorManifestInfoByType).toEqual({
    notion: { supportsIndexing: true, broker: null },
    gmail: { supportsIndexing: false, broker: "composio" },
  });
});

// --- Connecting a tools-only, Composio-brokered Gmail ---------------------
// A manifest with no sync resources carries no mode to choose: the redirect
// never asks for one, and the connector created on return takes the
// tools-only config the brief requires, regardless of what a stale
// `gmail_mode` might otherwise suggest.

test("handleConnectConnector omits gmail_mode for a tools-only Gmail manifest", async () => {
  listManifests.mockResolvedValueOnce({
    items: [
      fakeManifest("gmail", {
        resources: [],
        auth: { kind: "brokered", broker: "composio" },
      }),
    ],
  });
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
    await mountHook(baseInput("ws-brokered-start"));
    act(() => {
      api().handleConnectConnector(
        { id: "gmail", name: "Gmail" } as never,
        "tools",
      );
    });

    expect(assign).toHaveBeenCalledTimes(1);
    const target = new URL(String(assign.mock.calls[0]![0]));
    const returnTo = new URL(target.searchParams.get("return_to")!);
    expect(returnTo.searchParams.has("gmail_mode")).toBe(false);
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
});

test("handleConnectConnector still carries gmail_mode for today's indexable Gmail manifest", async () => {
  listManifests.mockResolvedValueOnce({ items: [fakeManifest("gmail")] });
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
    await mountHook(baseInput("ws-indexable-start"));
    act(() => {
      api().handleConnectConnector(
        { id: "gmail", name: "Gmail" } as never,
        "both",
      );
    });

    const target = new URL(String(assign.mock.calls[0]![0]));
    const returnTo = new URL(target.searchParams.get("return_to")!);
    expect(returnTo.searchParams.get("gmail_mode")).toBe("both");
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
});

test("a first authorization for a tools-only, brokered Gmail creates it with liveSearchEnabled only", async () => {
  // Prove the direct-fetch fallback actually ran, not just that the manifest
  // was available by coincidence: the mount-time `refreshConnectors` call to
  // `listManifests` hangs forever, so `connectorManifestInfoByTypeRef` can
  // never be populated that way. The only remaining source for the tools-only
  // manifest is `ensureConnector`'s own direct `listManifests` call, which
  // gets the second queued response.
  listManifests
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce({
      items: [
        fakeManifest("gmail", {
          resources: [],
          auth: { kind: "brokered", broker: "composio" },
        }),
      ],
    });
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
  create.mockResolvedValue({
    connector: fakeConnector({
      id: "gmail-1",
      connectorType: "gmail",
      configJson: { liveSearchEnabled: true },
    }),
  });
  returnFromAuthorization({
    workspaceId: "ws-brokered-first",
    connectorType: "gmail",
    accountId: "acc-1",
  });

  await mountHook(baseInput("ws-brokered-first"));

  // The mount-time call never resolves, so `connectorManifestInfoByType`
  // (the hook's cached, state-backed view) never learns about Gmail through
  // the normal channel; `listManifests` was called again regardless,
  // confirming the fallback path, not the cache, is what ran.
  expect(listManifests.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(api().availableConnectorTypes).not.toContain("gmail");
  expect(create).toHaveBeenCalledWith(
    "ws-brokered-first",
    expect.objectContaining({
      connectorType: "gmail",
      configJson: { liveSearchEnabled: true },
    }),
  );
  // Settings are never auto-opened for the tools-only config.
  expect(api().connectorSettingsConnector).toBeNull();
});

test("a first authorization never guesses a Gmail mode when the direct manifest check fails", async () => {
  // Same race as above (the mount-time fetch never resolves), but this time
  // `ensureConnector`'s own direct `listManifests` call rejects. The brief's
  // "no silent fallback" rule means this must not default to either shape:
  // the connector is never created, and the failure surfaces through the
  // same error path any other failed connector creation already uses.
  listManifests
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockRejectedValueOnce(new Error("manifest fetch failed"));
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
  returnFromAuthorization({
    workspaceId: "ws-brokered-fails",
    connectorType: "gmail",
    accountId: "acc-1",
  });

  await mountHook(baseInput("ws-brokered-fails"));

  expect(create).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith("manifest fetch failed");
  expect(api().connectorWaitingByType.gmail).toBeUndefined();
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

test("dropbox connect creates an empty selection and opens settings", async () => {
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-db",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  const created = fakeConnector({
    id: "dropbox-1",
    connectorType: "dropbox",
    name: "Person",
    oauthAccountId: "acc-db",
    configJson: { items: [] },
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 360,
  });
  // The new connector is listed once it exists.
  create.mockImplementation(async () => {
    list.mockResolvedValue({ items: [created] });
    return { connector: created };
  });
  returnFromAuthorization({
    workspaceId: "ws-dropbox",
    connectorType: "dropbox",
    accountId: "acc-db",
  });

  await mountHook(baseInput("ws-dropbox"));

  expect(create).toHaveBeenCalledWith("ws-dropbox", {
    connectorType: "dropbox",
    name: "Person",
    oauthAccountId: "acc-db",
    configJson: { items: [] },
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 360,
  });
  // Nothing is selected yet, so nothing is synced; settings open instead.
  expect(sync).not.toHaveBeenCalled();
  expect(api().connectorSettingsConnector?.id).toBe("dropbox-1");
  expect(toastSuccess).toHaveBeenCalledWith("Dropbox connected.");
});

test("github connect creates an empty selection without periodic indexing and opens settings", async () => {
  listManifests.mockResolvedValue({
    items: [
      { type: "notion" },
      { type: "dropbox", selection: dropboxSelectionSpec },
      { type: "github", selection: githubSelectionSpec },
    ],
  });
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-gh",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  const created = fakeConnector({
    id: "github-1",
    connectorType: "github",
    name: "Person",
    oauthAccountId: "acc-gh",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  // The new connector is listed once it exists.
  create.mockImplementation(async () => {
    list.mockResolvedValue({ items: [created] });
    return { connector: created };
  });
  returnFromAuthorization({
    workspaceId: "ws-github",
    connectorType: "github",
    accountId: "acc-gh",
  });

  await mountHook(baseInput("ws-github"));

  expect(create).toHaveBeenCalledWith("ws-github", {
    connectorType: "github",
    name: "Person",
    oauthAccountId: "acc-gh",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  expect(create.mock.calls[0]?.[1]).not.toHaveProperty(
    "indexingFrequencyMinutes",
  );
  // Nothing is selected yet, so nothing is synced; settings open instead.
  expect(sync).not.toHaveBeenCalled();
  expect(api().connectorSettingsConnector?.id).toBe("github-1");
  expect(toastSuccess).toHaveBeenCalledWith("GitHub connected.");
});

test("linear connect creates an empty selection without periodic sync and opens settings", async () => {
  listManifests.mockResolvedValue({
    items: [
      { type: "notion" },
      { type: "dropbox", selection: dropboxSelectionSpec },
      { type: "linear", selection: linearSelectionSpec },
    ],
  });
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-linear",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  const created = fakeConnector({
    id: "linear-1",
    connectorType: "linear",
    name: "Person",
    oauthAccountId: "acc-linear",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  // The new connector is listed once it exists.
  create.mockImplementation(async () => {
    list.mockResolvedValue({ items: [created] });
    return { connector: created };
  });
  returnFromAuthorization({
    workspaceId: "ws-linear",
    connectorType: "linear",
    accountId: "acc-linear",
  });

  await mountHook(baseInput("ws-linear"));

  // A tools-only selection connector: an empty selection, periodic indexing
  // stays off (it is not in the explicit periodic-index list), no sync is
  // triggered (nothing selected), and settings open so the admin can choose
  // teams and projects.
  expect(create).toHaveBeenCalledWith("ws-linear", {
    connectorType: "linear",
    name: "Person",
    oauthAccountId: "acc-linear",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  expect(sync).not.toHaveBeenCalled();
  expect(api().connectorSettingsConnector?.id).toBe("linear-1");
  expect(toastSuccess).toHaveBeenCalledWith("Linear connected.");
});

test("jira connect creates an empty selection without periodic sync and opens settings", async () => {
  listManifests.mockResolvedValue({
    items: [
      { type: "notion" },
      { type: "dropbox", selection: dropboxSelectionSpec },
      { type: "jira", selection: jiraSelectionSpec },
    ],
  });
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-jira",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  const created = fakeConnector({
    id: "jira-1",
    connectorType: "jira",
    name: "Person",
    oauthAccountId: "acc-jira",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  create.mockImplementation(async () => {
    list.mockResolvedValue({ items: [created] });
    return { connector: created };
  });
  returnFromAuthorization({
    workspaceId: "ws-jira",
    connectorType: "jira",
    accountId: "acc-jira",
  });

  await mountHook(baseInput("ws-jira"));

  // Jira is a tools-only selection connector, not in the periodic-index list:
  // an empty selection is created, periodic indexing stays off, and settings
  // open so the admin can pick projects.
  expect(create).toHaveBeenCalledWith("ws-jira", {
    connectorType: "jira",
    name: "Person",
    oauthAccountId: "acc-jira",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  expect(sync).not.toHaveBeenCalled();
  expect(api().connectorSettingsConnector?.id).toBe("jira-1");
  expect(toastSuccess).toHaveBeenCalledWith("Jira connected.");
});

test("confluence connect creates an empty selection without periodic sync and opens settings", async () => {
  listManifests.mockResolvedValue({
    items: [
      { type: "notion" },
      { type: "dropbox", selection: dropboxSelectionSpec },
      { type: "confluence", selection: confluenceSelectionSpec },
    ],
  });
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-confluence",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  const created = fakeConnector({
    id: "confluence-1",
    connectorType: "confluence",
    name: "Person",
    oauthAccountId: "acc-confluence",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  create.mockImplementation(async () => {
    list.mockResolvedValue({ items: [created] });
    return { connector: created };
  });
  returnFromAuthorization({
    workspaceId: "ws-confluence",
    connectorType: "confluence",
    accountId: "acc-confluence",
  });

  await mountHook(baseInput("ws-confluence"));

  // Confluence is a tools-only selection connector, not in the periodic-index list:
  // an empty selection is created, periodic indexing stays off, and settings
  // open so the admin can pick spaces and pages.
  expect(create).toHaveBeenCalledWith("ws-confluence", {
    connectorType: "confluence",
    name: "Person",
    oauthAccountId: "acc-confluence",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  expect(sync).not.toHaveBeenCalled();
  expect(api().connectorSettingsConnector?.id).toBe("confluence-1");
  expect(toastSuccess).toHaveBeenCalledWith("Confluence connected.");
});

test("a manifest fetch that fails after OAuth return still creates the connector from the spec in state", async () => {
  // Call #1 is the mount-time refresh: it SUCCEEDS, so the spec is in state and
  // a manifest load has been recorded as successful. Call #2 is the
  // just-authorised fetch: it fails. The connect must not abort or show an auth
  // error — it falls back to the spec already loaded into state.
  listManifests
    .mockResolvedValueOnce({
      items: [
        fakeManifest("notion"),
        { ...fakeManifest("dropbox"), selection: dropboxSelectionSpec },
      ],
    })
    .mockRejectedValueOnce(new Error("manifests offline"));
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-db",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  const created = fakeConnector({
    id: "dropbox-2",
    connectorType: "dropbox",
    name: "Person",
    oauthAccountId: "acc-db",
    configJson: { items: [] },
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 360,
  });
  create.mockImplementation(async () => {
    list.mockResolvedValue({ items: [created] });
    return { connector: created };
  });
  returnFromAuthorization({
    workspaceId: "ws-db-fail",
    connectorType: "dropbox",
    accountId: "acc-db",
  });

  await mountHook(baseInput("ws-db-fail"));

  expect(create).toHaveBeenCalledWith(
    "ws-db-fail",
    expect.objectContaining({
      connectorType: "dropbox",
      configJson: { items: [] },
    }),
  );
  // The mount-time manifest load applied, so the spec was in state to fall
  // back to.
  expect(api().availableConnectorTypes).toContain("dropbox");
  expect(api().connectorSettingsConnector?.id).toBe("dropbox-2");
  expect(toastError).not.toHaveBeenCalled();
});

test("when manifests cannot be loaded at all after OAuth return, nothing is created and the person is told to connect again", async () => {
  // Every manifest load fails — the mount-time one and the just-authorised
  // one — so the selection capability is genuinely unknown. The connector must
  // not be created and no success-toned toast may appear.
  listManifests.mockRejectedValue(new Error("manifests offline"));
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-db",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  returnFromAuthorization({
    workspaceId: "ws-db-unknown",
    connectorType: "dropbox",
    accountId: "acc-db",
  });

  await mountHook(baseInput("ws-db-unknown"));

  expect(create).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith(
    "Dropbox was authorized, but setup could not finish. Connect it again.",
  );
  // No success toast of any kind, and the configure-next info toast is not
  // shown either.
  expect(toastSuccess).not.toHaveBeenCalled();
  expect(toastInfo).not.toHaveBeenCalled();
  // The waiting state is cleared, like the block's other failure exits.
  expect(api().connectorWaitingByType.dropbox).toBeFalsy();
});

test("an explicitly handled type without a selection spec keeps its own path", async () => {
  // Manifests load successfully but carry no selection for Google Drive, so the
  // capability is known-and-absent: Google Drive keeps its own create path
  // (empty file selection, settings opened), never the setup-incomplete exit.
  listManifests.mockResolvedValue({
    items: [
      fakeManifest("notion"),
      { ...fakeManifest("dropbox"), selection: dropboxSelectionSpec },
      fakeManifest("google_drive"),
    ],
  });
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
    workspaceId: "ws-drive-nosel",
    connectorType: "google_drive",
    accountId: "acc-1",
  });

  await mountHook(baseInput("ws-drive-nosel"));

  expect(create).toHaveBeenCalledWith(
    "ws-drive-nosel",
    expect.objectContaining({
      connectorType: "google_drive",
      configJson: { fileIds: [] },
    }),
  );
  expect(toastSuccess).toHaveBeenCalledWith("Google Drive connected.");
  expect(toastError).not.toHaveBeenCalled();
});

test("a type without a selection spec that is not specially handled gets the configure-next path", async () => {
  // x-tools declares no selection and is not one of the explicitly handled
  // types (notion / gmail / google_drive), so with the manifests known the
  // connect takes the configure-next path: nothing created, an info toast.
  listManifests.mockResolvedValue({
    items: [fakeManifest("notion"), fakeManifest("x-tools")],
  });
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-x",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  returnFromAuthorization({
    workspaceId: "ws-x-nosel",
    connectorType: "x-tools",
    accountId: "acc-x",
  });

  await mountHook(baseInput("ws-x-nosel"));

  expect(create).not.toHaveBeenCalled();
  expect(toastInfo).toHaveBeenCalledWith(
    "X Tools is connected. Configure syncing next.",
  );
  expect(toastError).not.toHaveBeenCalled();
});

test("a failed refresh keeps the selection specs", async () => {
  await mountHook(baseInput("ws-keep-specs"));
  expect(api().selectionSpecByType.dropbox).toBeTruthy();

  // A refresh whose manifest load rejects must not drop the last good spec.
  listManifests.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await api().refreshConnectors();
  });

  expect(api().selectionSpecByType.dropbox).toBeTruthy();
});

test("after a good load and a failed refresh, an OAuth return with a failing manifests fetch still creates the connector", async () => {
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-db",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  const created = fakeConnector({
    id: "dropbox-keep",
    connectorType: "dropbox",
    name: "Person",
    oauthAccountId: "acc-db",
    configJson: { items: [] },
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 360,
  });
  create.mockImplementation(async () => {
    list.mockResolvedValue({ items: [created] });
    return { connector: created };
  });

  // Mount: a successful manifest load records the spec in state.
  await mountHook(baseInput("ws-db-keep"));
  expect(api().selectionSpecByType.dropbox).toBeTruthy();

  // A failed refresh. Previously this wiped the specs while keeping the loaded
  // flag, so the later fallback read them as "no selection".
  listManifests.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await api().refreshConnectors();
  });

  // The OAuth return now arrives and its own manifest fetch also fails: the
  // connect falls back to the spec kept in state rather than creating nothing.
  listManifests.mockRejectedValueOnce(new Error("offline again"));
  await act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sourceweft:connectors:oauth",
        newValue: JSON.stringify({
          id: "dropbox:acc-db",
          workspaceId: "ws-db-keep",
          connectorType: "dropbox",
          accountId: "acc-db",
          status: "success",
          createdAt: new Date().toISOString(),
        }),
      }),
    );
    await flushMicrotasks();
  });

  expect(create).toHaveBeenCalledWith(
    "ws-db-keep",
    expect.objectContaining({
      connectorType: "dropbox",
      configJson: { items: [] },
    }),
  );
  expect(api().connectorSettingsConnector?.id).toBe("dropbox-keep");
  expect(toastError).not.toHaveBeenCalled();
});

test("switching workspace clears the selection specs", async () => {
  const input = baseInput("ws-a");
  function Harness() {
    latest = useConnectors(input);
    return null;
  }
  const view = await mountWithIntl(createElement(Harness));
  await flush(25);
  expect(api().selectionSpecByType.dropbox).toBeTruthy();

  // Switch to workspace B; its manifests have not loaded yet (the fetch hangs),
  // so A's specs must not be visible under B.
  listManifests.mockImplementationOnce(() => new Promise(() => {}));
  input.workspaceId = "ws-b";
  input.currentWorkspaceIdRef.current = "ws-b";
  await view.render(withIntl(createElement(Harness)));
  expect(api().selectionSpecByType.dropbox).toBeUndefined();
});

test("a tools-only selection connector connects with an empty selection and no periodic sync", async () => {
  listManifests.mockResolvedValue({
    items: [
      fakeManifest("notion"),
      { ...fakeManifest("x-tools"), selection: toolsSelectionSpec },
    ],
  });
  listAccounts.mockResolvedValue({
    items: [
      {
        id: "acc-x",
        status: "active",
        displayName: "Person",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });
  const created = fakeConnector({
    id: "x-1",
    connectorType: "x-tools",
    name: "Person",
    oauthAccountId: "acc-x",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  create.mockImplementation(async () => {
    list.mockResolvedValue({ items: [created] });
    return { connector: created };
  });
  returnFromAuthorization({
    workspaceId: "ws-x-tools",
    connectorType: "x-tools",
    accountId: "acc-x",
  });

  await mountHook(baseInput("ws-x-tools"));

  // A type with a selection spec but not in the periodic-index list creates an
  // empty selection, stays off periodic indexing, and opens settings.
  expect(create).toHaveBeenCalledWith("ws-x-tools", {
    connectorType: "x-tools",
    name: "Person",
    oauthAccountId: "acc-x",
    configJson: { items: [] },
    periodicIndexingEnabled: false,
  });
  expect(sync).not.toHaveBeenCalled();
  expect(api().connectorSettingsConnector?.id).toBe("x-1");
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

function webdavConnector(overrides: Partial<SourceConnector> = {}) {
  return fakeConnector({
    id: "webdav-1",
    connectorType: "webdav",
    name: "My WebDAV",
    oauthAccountId: "acc-webdav",
    configJson: { endpoint: "https://dav.example.com", roots: ["/"] },
    credentialConfigured: true,
    credentialDisplayName: "alice",
    ...overrides,
  });
}

test("handleReconnectConnector opens the rotate dialog for a credential connector, without redirecting", async () => {
  list.mockResolvedValue({ items: [webdavConnector()] });
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
    await mountHook(baseInput("ws-rotate"));
    expect(api().rotateCredentialConnector).toBeNull();
    act(() => {
      api().handleReconnectConnector(api().connectors[0]!);
    });

    expect(assign).not.toHaveBeenCalled();
    expect(api().rotateCredentialConnector?.id).toBe("webdav-1");
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
});

test("handleCheckCredential checks the webdav endpoint with the credential and whole-endpoint root", async () => {
  checkConfig.mockResolvedValue({ ready: true });
  await mountHook(baseInput("ws-cred"));

  const result = await api().handleCheckCredential({
    endpoint: "https://dav.example.com",
    username: "alice",
    secret: "app-pass",
  });

  expect(checkConfig).toHaveBeenCalledWith("ws-cred", {
    connectorType: "webdav",
    configJson: { endpoint: "https://dav.example.com", roots: ["/"] },
    credential: { username: "alice", secret: "app-pass" },
  });
  expect(result).toEqual({ ready: true, reason: "", message: "" });
});

test("handleAddCredential creates the webdav connector with the credential and chosen roots", async () => {
  create.mockResolvedValue({ connector: webdavConnector() });
  sync.mockResolvedValue({});
  await mountHook(baseInput("ws-add"));

  await act(async () => {
    await api().handleAddCredential({
      name: "My WebDAV",
      endpoint: "https://dav.example.com",
      username: "alice",
      secret: "app-pass",
      roots: ["/Documents/"],
      // Opt-in scheduled sync: the dialog forwards the member's choice.
      periodicIndexingEnabled: false,
    });
  });

  expect(create).toHaveBeenCalledWith("ws-add", {
    connectorType: "webdav",
    name: "My WebDAV",
    configJson: { endpoint: "https://dav.example.com", roots: ["/Documents/"] },
    credential: { username: "alice", secret: "app-pass" },
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: 360,
  });
});

test("handleAddCredential forwards an enabled scheduled sync", async () => {
  create.mockResolvedValue({ connector: webdavConnector() });
  sync.mockResolvedValue({});
  await mountHook(baseInput("ws-add2"));

  await act(async () => {
    await api().handleAddCredential({
      name: "My WebDAV",
      endpoint: "https://dav.example.com",
      username: "alice",
      secret: "app-pass",
      roots: ["/Documents/"],
      periodicIndexingEnabled: true,
    });
  });

  expect(create.mock.calls[0]?.[1]).toMatchObject({
    periodicIndexingEnabled: true,
  });
});

test("handleRotateCredential rotates the credential and closes the rotate dialog", async () => {
  list.mockResolvedValue({ items: [webdavConnector()] });
  rotateCredential.mockResolvedValue({
    credentialConfigured: true,
    displayName: "alice",
  });
  await mountHook(baseInput("ws-rotate2"));
  const connector = api().connectors[0]!;
  act(() => {
    api().setRotateCredentialConnector(connector);
  });
  expect(api().rotateCredentialConnector?.id).toBe("webdav-1");

  await act(async () => {
    await api().handleRotateCredential(connector, {
      username: "bob",
      secret: "new-pass",
    });
  });

  expect(rotateCredential).toHaveBeenCalledWith("ws-rotate2", "webdav-1", {
    username: "bob",
    secret: "new-pass",
  });
  expect(api().rotateCredentialConnector).toBeNull();
});

function zoteroConnector(overrides: Partial<SourceConnector> = {}) {
  return fakeConnector({
    id: "zotero-1",
    connectorType: "zotero",
    name: "Lab library",
    oauthAccountId: "acc-zotero",
    configJson: { libraryType: "group", libraryId: "2205533", items: [] },
    credentialConfigured: true,
    credentialDisplayName: "groups/2205533",
    ...overrides,
  });
}

test("handleCheckCredential forwards a generic api-key check untouched and keeps its metadata", async () => {
  checkConfig.mockResolvedValue({
    ready: true,
    message: "Key cannot read notes",
    metadata: { notesAccess: false },
  });
  await mountHook(baseInput("ws-zcheck"));

  const result = await api().handleCheckCredential({
    connectorType: "zotero",
    configJson: { libraryType: "user", libraryId: "42", items: [] },
    credential: { username: "users/42", secret: "AbC123" },
  });

  expect(checkConfig).toHaveBeenCalledWith("ws-zcheck", {
    connectorType: "zotero",
    configJson: { libraryType: "user", libraryId: "42", items: [] },
    credential: { username: "users/42", secret: "AbC123" },
  });
  expect(result).toEqual({
    ready: true,
    reason: "",
    message: "Key cannot read notes",
    metadata: { notesAccess: false },
  });
});

test("handleAddCredential creates a generic api-key connector with the given config and credential", async () => {
  create.mockResolvedValue({ connector: zoteroConnector() });
  sync.mockResolvedValue({});
  await mountHook(baseInput("ws-zadd"));

  await act(async () => {
    await api().handleAddCredential({
      connectorType: "zotero",
      name: "Lab library",
      configJson: { libraryType: "group", libraryId: "2205533", items: [] },
      credential: { username: "groups/2205533", secret: "AbC123" },
      periodicIndexingEnabled: false,
    });
  });

  expect(create).toHaveBeenCalledWith("ws-zadd", {
    connectorType: "zotero",
    name: "Lab library",
    configJson: { libraryType: "group", libraryId: "2205533", items: [] },
    credential: { username: "groups/2205533", secret: "AbC123" },
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: 360,
  });
  expect(sync).toHaveBeenCalled();
});

test("handleReconnectConnector opens the rotate dialog for an api-key connector, without redirecting", async () => {
  list.mockResolvedValue({ items: [zoteroConnector()] });
  await mountHook(baseInput("ws-zrotate"));
  act(() => {
    api().handleReconnectConnector(api().connectors[0]!);
  });
  expect(api().rotateCredentialConnector?.id).toBe("zotero-1");
});

test("handleRotateCredential sends the derived Zotero library username with the new key", async () => {
  list.mockResolvedValue({ items: [zoteroConnector()] });
  rotateCredential.mockResolvedValue({
    credentialConfigured: true,
    displayName: "groups/2205533",
  });
  await mountHook(baseInput("ws-zrotate2"));
  const connector = api().connectors[0]!;

  await act(async () => {
    await api().handleRotateCredential(connector, {
      username: "groups/2205533",
      secret: "NewKey9",
    });
  });

  expect(rotateCredential).toHaveBeenCalledWith("ws-zrotate2", "zotero-1", {
    username: "groups/2205533",
    secret: "NewKey9",
  });
});

function nextcloudConnector(overrides: Partial<SourceConnector> = {}) {
  return fakeConnector({
    id: "nc-1",
    connectorType: "nextcloud",
    name: "My Nextcloud",
    oauthAccountId: "acc-nc",
    configJson: {
      server: "https://cloud.example.com",
      endpoint: "https://cloud.example.com/remote.php/dav/files/alice/",
      userId: "alice",
      roots: ["/"],
    },
    credentialConfigured: true,
    credentialDisplayName: "alice",
    ...overrides,
  });
}

const nextcloudItem = {
  id: "nextcloud",
  name: "Nextcloud",
} as unknown as Parameters<HookApi["handleAddLoginFlow"]>[0];

test("handleAddLoginFlow opens the login-flow dialog in add mode", async () => {
  await mountHook(baseInput("ws-nc-add"));
  expect(api().loginFlowState).toBeNull();
  act(() => {
    api().handleAddLoginFlow(nextcloudItem);
  });
  expect(api().loginFlowState).toEqual({
    mode: "add",
    connectorType: "nextcloud",
  });
});

test("handleReconnectConnector starts the login flow with connectorId and shows no password dialog", async () => {
  list.mockResolvedValue({ items: [nextcloudConnector()] });
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
    await mountHook(baseInput("ws-nc-reconnect"));
    act(() => {
      api().handleReconnectConnector(api().connectors[0]!);
    });
    expect(assign).not.toHaveBeenCalled();
    // No password/rotate dialog for a login-flow connector.
    expect(api().rotateCredentialConnector).toBeNull();
    expect(api().loginFlowState).toEqual({
      mode: "reconnect",
      connectorType: "nextcloud",
      connectorId: "nc-1",
      serverUrl: "https://cloud.example.com",
      connectorName: "My Nextcloud",
    });
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  }
});

test("handleStartLoginFlow sends the add request without a connectorId", async () => {
  startCredentialFlow.mockResolvedValue({
    flowId: "f1",
    loginUrl: "https://x/login",
  });
  await mountHook(baseInput("ws-nc-start"));
  act(() => {
    api().handleAddLoginFlow(nextcloudItem);
  });
  await act(async () => {
    await api().handleStartLoginFlow({
      serverUrl: "https://cloud.example.com",
      name: "My Nextcloud",
      roots: ["/Documents/"],
      periodicIndexingEnabled: true,
    });
  });
  expect(startCredentialFlow).toHaveBeenCalledWith("ws-nc-start", "nextcloud", {
    serverUrl: "https://cloud.example.com",
    name: "My Nextcloud",
    roots: ["/Documents/"],
    periodicIndexingEnabled: true,
  });
});

test("handleStartLoginFlow adds the connectorId when reconnecting", async () => {
  list.mockResolvedValue({ items: [nextcloudConnector()] });
  startCredentialFlow.mockResolvedValue({
    flowId: "f2",
    loginUrl: "https://x/login",
  });
  await mountHook(baseInput("ws-nc-start2"));
  act(() => {
    api().handleReconnectConnector(api().connectors[0]!);
  });
  await act(async () => {
    await api().handleStartLoginFlow({
      serverUrl: "https://cloud.example.com",
      name: "My Nextcloud",
    });
  });
  expect(startCredentialFlow).toHaveBeenCalledWith(
    "ws-nc-start2",
    "nextcloud",
    {
      serverUrl: "https://cloud.example.com",
      name: "My Nextcloud",
      connectorId: "nc-1",
    },
  );
});

test("handlePollLoginFlow polls the connector type from the open dialog", async () => {
  pollCredentialFlow.mockResolvedValue({ status: "pending" });
  await mountHook(baseInput("ws-nc-poll"));
  act(() => {
    api().handleAddLoginFlow(nextcloudItem);
  });
  await act(async () => {
    await api().handlePollLoginFlow("flow-xyz");
  });
  expect(pollCredentialFlow).toHaveBeenCalledWith("ws-nc-poll", "nextcloud", {
    flowId: "flow-xyz",
  });
});

test("handleCancelLoginFlow deletes the flow and swallows failures", async () => {
  cancelCredentialFlow.mockRejectedValue(new Error("gone"));
  await mountHook(baseInput("ws-nc-cancel"));
  act(() => {
    api().handleAddLoginFlow(nextcloudItem);
  });
  await act(async () => {
    await api().handleCancelLoginFlow("flow-xyz");
  });
  expect(cancelCredentialFlow).toHaveBeenCalledWith(
    "ws-nc-cancel",
    "nextcloud",
    "flow-xyz",
  );
});

test("an add-mode connected flow triggers the first sync", async () => {
  sync.mockResolvedValue({});
  await mountHook(baseInput("ws-nc-connected"));
  act(() => {
    api().handleAddLoginFlow(nextcloudItem);
  });
  await act(async () => {
    await api().handleLoginFlowConnected(nextcloudConnector());
  });
  expect(sync).toHaveBeenCalledWith("ws-nc-connected", "nc-1");
  expect(toastSuccess).toHaveBeenCalled();
});

test("a reconnect connected flow refreshes without a first sync", async () => {
  await mountHook(baseInput("ws-nc-reconnected"));
  act(() => {
    api().setLoginFlowState({
      mode: "reconnect",
      connectorType: "nextcloud",
      connectorId: "nc-1",
    });
  });
  await act(async () => {
    await api().handleLoginFlowConnected(nextcloudConnector());
  });
  expect(sync).not.toHaveBeenCalled();
  expect(toastSuccess).toHaveBeenCalledWith("My Nextcloud reconnected.");
});

test("handleCheckFeed checks the rss config and maps title and item count", async () => {
  checkConfig.mockResolvedValue({
    ready: true,
    metadata: { title: "Example Blog", itemCount: 42 },
  });
  await mountHook(baseInput("ws-feed"));

  const result = await api().handleCheckFeed(
    "https://example.com/feed.xml?token=SECRET-TOKEN-123",
  );

  expect(checkConfig).toHaveBeenCalledWith("ws-feed", {
    connectorType: "rss",
    configJson: {
      feedUrl: "https://example.com/feed.xml?token=SECRET-TOKEN-123",
    },
  });
  expect(result).toEqual({
    ready: true,
    reason: "",
    message: "",
    title: "Example Blog",
    itemCount: 42,
  });
});

test("handleCheckFeed passes the not-ready reason through without a title", async () => {
  checkConfig.mockResolvedValue({
    ready: false,
    reason: "feed_timeout",
    message: "The feed request timed out.",
  });
  await mountHook(baseInput("ws-feed"));

  const result = await api().handleCheckFeed("https://example.com/feed.xml");

  expect(result).toEqual({
    ready: false,
    reason: "feed_timeout",
    message: "The feed request timed out.",
    title: null,
    itemCount: null,
  });
});

test("handleCheckFeed with no workspace toasts and does not call the API", async () => {
  await mountHook(baseInput("", { workspaceId: null }));

  const result = await api().handleCheckFeed("https://example.com/feed.xml");

  expect(checkConfig).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith("No workspace selected yet.");
  expect(result.ready).toBe(false);
});

test("handleAddFeed creates the connector with the exact body, refreshes, then syncs once", async () => {
  const created = fakeConnector({
    id: "feed-1",
    connectorType: "rss",
    name: "Example Blog",
    configJson: { feedUrl: "https://example.com/feed.xml" },
  });
  create.mockResolvedValue({ connector: created });
  sync.mockResolvedValue({
    run: {
      id: "run1",
      connectorId: "feed-1",
      discoveredCount: 0,
      indexedCount: 0,
      failedCount: 0,
    },
    skipped: false,
    alreadyRunning: false,
  });
  await mountHook(baseInput("ws-feed"));
  const listCallsBefore = list.mock.calls.length;

  await act(async () => {
    await api().handleAddFeed({
      name: "Example Blog",
      feedUrl: "https://example.com/feed.xml",
    });
  });
  await flush(25);

  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith("ws-feed", {
    connectorType: "rss",
    name: "Example Blog",
    configJson: { feedUrl: "https://example.com/feed.xml" },
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 360,
  });
  expect("oauthAccountId" in create.mock.calls[0]![1]).toBe(false);
  expect(list.mock.calls.length).toBeGreaterThan(listCallsBefore);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledWith("ws-feed", "feed-1");
});

test("handleAddFeed keeps the connector and tells the person when the first sync fails to start", async () => {
  create.mockResolvedValue({
    connector: fakeConnector({ id: "feed-2", connectorType: "rss" }),
  });
  sync.mockRejectedValue(new Error("queue down"));
  await mountHook(baseInput("ws-feed"));

  await act(async () => {
    await api().handleAddFeed({
      name: "Example Blog",
      feedUrl: "https://example.com/feed.xml",
    });
  });
  await flush(25);

  expect(create).toHaveBeenCalledTimes(1);
  expect(toastError).toHaveBeenCalledWith("queue down");
});

test("handleAddFeed rethrows a 409 without toasting, syncing or treating it as connected", async () => {
  create.mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_ALREADY_EXISTS",
    }),
  );
  await mountHook(baseInput("ws-feed"));

  await expect(
    api().handleAddFeed({
      name: "Example Blog",
      feedUrl: "https://example.com/feed.xml",
    }),
  ).rejects.toMatchObject({ code: "CONNECTOR_ALREADY_EXISTS" });

  expect(sync).not.toHaveBeenCalled();
  expect(toastError).not.toHaveBeenCalled();
  expect(toastSuccess).not.toHaveBeenCalled();
});

test("handleAddFeed with no workspace toasts and does not create", async () => {
  await mountHook(baseInput("", { workspaceId: null }));

  await expect(
    api().handleAddFeed({
      name: "Example Blog",
      feedUrl: "https://example.com/feed.xml",
    }),
  ).rejects.toThrow("No workspace selected yet.");

  expect(create).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith("No workspace selected yet.");
});

const forumConfig = {
  forumUrl: "https://forum.example.com",
  items: [],
  refresh: "deep",
};

test("handleCheckForum checks the given config with no credential and keeps the reason", async () => {
  checkConfig.mockResolvedValue({
    ready: false,
    reason: "selection_required",
    message: "Choose categories or topics.",
  });
  await mountHook(baseInput("ws-forum"));

  const result = await api().handleCheckForum({
    connectorType: "discourse",
    configJson: forumConfig,
  });

  expect(checkConfig).toHaveBeenCalledWith("ws-forum", {
    connectorType: "discourse",
    configJson: forumConfig,
  });
  expect("credential" in checkConfig.mock.calls[0]![1]).toBe(false);
  expect(result).toEqual({
    ready: false,
    reason: "selection_required",
    message: "Choose categories or topics.",
  });
});

test("handleCheckForum with no workspace toasts and does not call the API", async () => {
  await mountHook(baseInput("", { workspaceId: null }));

  const result = await api().handleCheckForum({
    connectorType: "discourse",
    configJson: forumConfig,
  });

  expect(checkConfig).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith("No workspace selected yet.");
  expect(result.ready).toBe(false);
});

test("handleAddForum creates the connector without a credential, opens its settings and does not sync", async () => {
  const created = fakeConnector({
    id: "forum-1",
    connectorType: "discourse",
    name: "Community",
    configJson: forumConfig,
  });
  create.mockResolvedValue({ connector: created });
  list.mockResolvedValue({ items: [created] });
  await mountHook(baseInput("ws-forum"));

  await act(async () => {
    await api().handleAddForum({
      connectorType: "discourse",
      name: "Community",
      configJson: forumConfig,
      periodicIndexingEnabled: false,
    });
  });
  await flush(25);

  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith("ws-forum", {
    connectorType: "discourse",
    name: "Community",
    configJson: forumConfig,
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: 360,
  });
  expect("credential" in create.mock.calls[0]![1]).toBe(false);
  expect("oauthAccountId" in create.mock.calls[0]![1]).toBe(false);
  // Nothing is selected yet, so there is nothing to sync: the person is sent
  // to the selection picker instead.
  expect(sync).not.toHaveBeenCalled();
  expect(api().connectorSettingsConnector?.id).toBe("forum-1");
  expect(api().connectorReadinessById["forum-1"]).toMatchObject({
    reason: "selection_required",
  });
  expect(toastSuccess).toHaveBeenCalledWith("Community connected.");
});

test("handleAddForum rethrows a 409 without toasting or opening settings", async () => {
  create.mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_ALREADY_EXISTS",
    }),
  );
  await mountHook(baseInput("ws-forum"));

  await expect(
    api().handleAddForum({
      connectorType: "discourse",
      name: "Community",
      configJson: forumConfig,
      periodicIndexingEnabled: false,
    }),
  ).rejects.toMatchObject({ code: "CONNECTOR_ALREADY_EXISTS" });

  expect(api().connectorSettingsConnector).toBeNull();
  expect(toastError).not.toHaveBeenCalled();
  expect(toastSuccess).not.toHaveBeenCalled();
});

test("handleAddForum with no workspace toasts and does not create", async () => {
  await mountHook(baseInput("", { workspaceId: null }));

  await expect(
    api().handleAddForum({
      connectorType: "discourse",
      name: "Community",
      configJson: forumConfig,
      periodicIndexingEnabled: false,
    }),
  ).rejects.toThrow("No workspace selected yet.");

  expect(create).not.toHaveBeenCalled();
});

function wordpressConnector(overrides: Partial<SourceConnector> = {}) {
  return fakeConnector({
    id: "wp-1",
    connectorType: "wordpress",
    name: "My blog",
    configJson: { siteUrl: "https://blog.example.com", items: [] },
    ...overrides,
  });
}

test("handleCheckSite checks a public site with no credential and an empty selection", async () => {
  checkConfig.mockResolvedValue({ ready: true, reason: "", message: "" });
  await mountHook(baseInput("ws-site"));

  const result = await api().handleCheckSite({
    access: "public",
    siteUrl: "https://blog.example.com",
    includeUnpublished: false,
  });

  expect(checkConfig).toHaveBeenCalledWith("ws-site", {
    connectorType: "wordpress",
    configJson: { siteUrl: "https://blog.example.com", items: [] },
  });
  expect("credential" in checkConfig.mock.calls[0]![1]).toBe(false);
  expect(result).toEqual({ ready: true, reason: "", message: "" });
});

test("handleCheckSite checks the login type with the credential and drafts flag", async () => {
  checkConfig.mockResolvedValue({ ready: true, reason: "", message: "" });
  await mountHook(baseInput("ws-site-login"));

  await api().handleCheckSite({
    access: "login",
    siteUrl: "https://blog.example.com",
    includeUnpublished: true,
    credential: { username: "alice", secret: "app pass" },
  });

  expect(checkConfig).toHaveBeenCalledWith("ws-site-login", {
    connectorType: "wordpress_login",
    configJson: {
      siteUrl: "https://blog.example.com",
      items: [],
      includeUnpublished: true,
    },
    credential: { username: "alice", secret: "app pass" },
  });
});

test("handleCheckSite with no workspace toasts and does not call the API", async () => {
  await mountHook(baseInput("", { workspaceId: null }));

  const result = await api().handleCheckSite({
    access: "public",
    siteUrl: "https://blog.example.com",
    includeUnpublished: false,
  });

  expect(checkConfig).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith("No workspace selected yet.");
  expect(result.ready).toBe(false);
});

test("handleAddSite creates a public wordpress connector with no credential and starts a sync", async () => {
  const created = wordpressConnector();
  create.mockResolvedValue({ connector: created });
  list.mockResolvedValue({ items: [created] });
  sync.mockResolvedValue({});
  await mountHook(baseInput("ws-site-add"));

  await act(async () => {
    await api().handleAddSite({
      access: "public",
      siteUrl: "https://blog.example.com",
      includeUnpublished: false,
      name: "My blog",
      periodicIndexingEnabled: false,
    });
  });
  await flush(25);

  expect(create).toHaveBeenCalledWith("ws-site-add", {
    connectorType: "wordpress",
    name: "My blog",
    configJson: { siteUrl: "https://blog.example.com", items: [] },
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: 360,
  });
  expect("credential" in create.mock.calls[0]![1]).toBe(false);
  // An empty selection is ready, so the connector syncs right away.
  expect(sync).toHaveBeenCalledWith("ws-site-add", "wp-1");
  expect(toastSuccess).toHaveBeenCalledWith("My blog connected.");
});

test("handleAddSite creates wordpress_login with the credential and drafts flag", async () => {
  const created = wordpressConnector({
    id: "wp-login-1",
    connectorType: "wordpress_login",
  });
  create.mockResolvedValue({ connector: created });
  list.mockResolvedValue({ items: [created] });
  sync.mockResolvedValue({});
  await mountHook(baseInput("ws-site-login-add"));

  await act(async () => {
    await api().handleAddSite({
      access: "login",
      siteUrl: "https://blog.example.com",
      includeUnpublished: true,
      credential: { username: "alice", secret: "app pass" },
      name: "My blog",
      periodicIndexingEnabled: true,
    });
  });
  await flush(25);

  expect(create).toHaveBeenCalledWith("ws-site-login-add", {
    connectorType: "wordpress_login",
    name: "My blog",
    configJson: {
      siteUrl: "https://blog.example.com",
      items: [],
      includeUnpublished: true,
    },
    credential: { username: "alice", secret: "app pass" },
    periodicIndexingEnabled: true,
    indexingFrequencyMinutes: 360,
  });
});

test("handleAddSite rethrows a 409 without toasting", async () => {
  create.mockRejectedValue(
    new HttpClientError({
      message: "exists",
      status: 409,
      statusText: "Conflict",
      code: "CONNECTOR_ALREADY_EXISTS",
    }),
  );
  await mountHook(baseInput("ws-site-dup"));

  await expect(
    api().handleAddSite({
      access: "public",
      siteUrl: "https://blog.example.com",
      includeUnpublished: false,
      name: "My blog",
      periodicIndexingEnabled: false,
    }),
  ).rejects.toMatchObject({ code: "CONNECTOR_ALREADY_EXISTS" });

  expect(toastSuccess).not.toHaveBeenCalled();
});

test("handleAddSite with no workspace toasts and does not create", async () => {
  await mountHook(baseInput("", { workspaceId: null }));

  await expect(
    api().handleAddSite({
      access: "public",
      siteUrl: "https://blog.example.com",
      includeUnpublished: false,
      name: "My blog",
      periodicIndexingEnabled: false,
    }),
  ).rejects.toThrow("No workspace selected yet.");

  expect(create).not.toHaveBeenCalled();
});
