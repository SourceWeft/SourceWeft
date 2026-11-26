// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import type { SourceConnector } from "@sourceweft/sdk";
import { mountWithIntl, unmountAll } from "@/test/react";
import { connectorCatalog } from "./catalog";
import { ConnectorCatalogCard } from "./components";
import type { ConnectorCatalogStatus, ConnectorItem } from "./types";

vi.mock("@/lib/billing-edition/capabilities", () => ({
  useBillingAvailable: () => false,
}));

afterEach(unmountAll);

const item = connectorCatalog.find((entry) => entry.id === "google_drive")!;
const connector: ConnectorItem = {
  id: "c1",
  name: "Person",
  status: "active",
  meta: "",
  raw: {
    id: "c1",
    connectorType: "google_drive",
    status: "active",
    configJson: {},
    oauthAccountId: "acc-1",
  } as SourceConnector,
};

async function card(input: {
  connector: ConnectorItem | null;
  item?: typeof item;
  status: ConnectorCatalogStatus;
  supportsIndexing?: boolean;
}) {
  const handlers = {
    onAddApiKey: vi.fn(),
    onAddCredential: vi.fn(),
    onAddLoginFlow: vi.fn(),
    onAddFeed: vi.fn(),
    onCancelConnector: vi.fn(),
    onConfigure: vi.fn(),
    onConnectConnector: vi.fn(),
    onCreateConnector: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnectConnector: vi.fn(),
  };
  const mounted = await mountWithIntl(
    createElement(ConnectorCatalogCard, {
      item,
      ...input,
      ...handlers,
    }),
  );
  const buttons = Array.from(mounted.container.querySelectorAll("button"));
  const action = buttons[buttons.length - 1]!;
  return { action, handlers, container: mounted.container };
}

test("a connector that needs attention offers Reconnect", async () => {
  const { action, handlers } = await card({
    connector,
    status: { kind: "error", label: "Error", detail: "Needs attention" },
  });

  expect(action.textContent).toBe("Reconnect");
  expect(action.disabled).toBe(false);
  await act(async () => action.click());

  expect(handlers.onReconnectConnector).toHaveBeenCalledWith(item);
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(handlers.onCreateConnector).not.toHaveBeenCalled();
});

test("a healthy connector shows Connected and takes no action", async () => {
  const { action, handlers } = await card({
    connector,
    status: { kind: "active", label: "Active", detail: "Last sync" },
  });

  expect(action.textContent).toBe("Connected");
  expect(action.disabled).toBe(true);
  expect(handlers.onReconnectConnector).not.toHaveBeenCalled();
});

test("a provider without a connector still offers Connect", async () => {
  const { action, handlers } = await card({
    connector: null,
    status: { kind: "available", label: "Available", detail: "Ready" },
  });

  expect(action.textContent).toBe("Connect");
  await act(async () => action.click());

  expect(handlers.onConnectConnector).toHaveBeenCalledWith(item);
  expect(handlers.onReconnectConnector).not.toHaveBeenCalled();
});

test("a tools-only connector's card drops 'Optional indexing' but keeps the rest", async () => {
  const gmail = connectorCatalog.find((entry) => entry.id === "gmail")!;
  const { container } = await card({
    connector: null,
    item: gmail,
    status: { kind: "available", label: "Available", detail: "Ready" },
    supportsIndexing: false,
  });

  expect(container.textContent).not.toContain("Optional indexing");
  expect(container.textContent).toContain("Search");
});

test("today's indexable Gmail card keeps 'Optional indexing'", async () => {
  const gmail = connectorCatalog.find((entry) => entry.id === "gmail")!;
  const { container } = await card({
    connector: null,
    item: gmail,
    status: { kind: "available", label: "Available", detail: "Ready" },
  });

  expect(container.textContent).toContain("Optional indexing");
});

test("a tools-only Gmail card shows the Search API type badge, not Indexable", async () => {
  const gmail = connectorCatalog.find((entry) => entry.id === "gmail")!;
  const { container } = await card({
    connector: null,
    item: gmail,
    status: { kind: "available", label: "Available", detail: "Ready" },
    supportsIndexing: false,
  });

  expect(container.textContent).toContain("Search API");
  expect(container.textContent).not.toContain("Indexable");
});

test("today's indexable Gmail card shows the Indexable type badge", async () => {
  const gmail = connectorCatalog.find((entry) => entry.id === "gmail")!;
  const { container } = await card({
    connector: null,
    item: gmail,
    status: { kind: "available", label: "Available", detail: "Ready" },
    supportsIndexing: true,
  });

  expect(container.textContent).toContain("Indexable");
});

test("a tools-only Gmail card description does not mention indexing", async () => {
  const gmail = connectorCatalog.find((entry) => entry.id === "gmail")!;
  const { container } = await card({
    connector: null,
    item: gmail,
    status: { kind: "available", label: "Available", detail: "Ready" },
    supportsIndexing: false,
  });

  expect(container.textContent).not.toContain("optionally index");
  expect(container.textContent).toContain("send messages you approve");
});

test("an add-only RSS card offers Add feed and never starts OAuth", async () => {
  const rss = connectorCatalog.find((entry) => entry.id === "rss")!;
  const onAddFeed = vi.fn();
  const handlers = {
    onAddApiKey: vi.fn(),
    onAddCredential: vi.fn(),
    onAddLoginFlow: vi.fn(),
    onCancelConnector: vi.fn(),
    onConfigure: vi.fn(),
    onConnectConnector: vi.fn(),
    onCreateConnector: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnectConnector: vi.fn(),
  };
  const mounted = await mountWithIntl(
    createElement(ConnectorCatalogCard, {
      item: rss,
      connector: null,
      status: { kind: "available", label: "Available", detail: "Ready" },
      onAddFeed,
      ...handlers,
    }),
  );
  const buttons = Array.from(mounted.container.querySelectorAll("button"));
  const action = buttons[buttons.length - 1]!;

  expect(action.textContent).toBe("Add feed");
  expect(action.disabled).toBe(false);
  await act(async () => action.click());

  expect(onAddFeed).toHaveBeenCalledWith(rss);
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(handlers.onCreateConnector).not.toHaveBeenCalled();
  expect(handlers.onReconnectConnector).not.toHaveBeenCalled();
});

test("an add-only WebDAV card offers Connect and calls onAddCredential, never OAuth", async () => {
  const webdav = connectorCatalog.find((entry) => entry.id === "webdav")!;
  const onAddCredential = vi.fn();
  const handlers = {
    onAddApiKey: vi.fn(),
    onAddFeed: vi.fn(),
    onAddLoginFlow: vi.fn(),
    onCancelConnector: vi.fn(),
    onConfigure: vi.fn(),
    onConnectConnector: vi.fn(),
    onCreateConnector: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnectConnector: vi.fn(),
  };
  const mounted = await mountWithIntl(
    createElement(ConnectorCatalogCard, {
      item: webdav,
      connector: null,
      status: { kind: "available", label: "Available", detail: "Ready" },
      onAddCredential,
      ...handlers,
    }),
  );
  const buttons = Array.from(mounted.container.querySelectorAll("button"));
  const action = buttons[buttons.length - 1]!;

  expect(action.textContent).toBe("Connect");
  await act(async () => action.click());

  expect(onAddCredential).toHaveBeenCalledWith(webdav);
  expect(handlers.onAddFeed).not.toHaveBeenCalled();
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(handlers.onCreateConnector).not.toHaveBeenCalled();
  expect(handlers.onReconnectConnector).not.toHaveBeenCalled();
});

test("an add-only Nextcloud card offers Connect and calls onAddLoginFlow, never OAuth", async () => {
  const nextcloud = connectorCatalog.find((entry) => entry.id === "nextcloud")!;
  const onAddLoginFlow = vi.fn();
  const handlers = {
    onAddApiKey: vi.fn(),
    onAddCredential: vi.fn(),
    onAddFeed: vi.fn(),
    onCancelConnector: vi.fn(),
    onConfigure: vi.fn(),
    onConnectConnector: vi.fn(),
    onCreateConnector: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnectConnector: vi.fn(),
  };
  const mounted = await mountWithIntl(
    createElement(ConnectorCatalogCard, {
      item: nextcloud,
      connector: null,
      status: { kind: "available", label: "Available", detail: "Ready" },
      onAddLoginFlow,
      ...handlers,
    }),
  );
  const buttons = Array.from(mounted.container.querySelectorAll("button"));
  const action = buttons[buttons.length - 1]!;

  expect(action.textContent).toBe("Connect");
  await act(async () => action.click());

  expect(onAddLoginFlow).toHaveBeenCalledWith(nextcloud);
  expect(handlers.onAddCredential).not.toHaveBeenCalled();
  expect(handlers.onAddFeed).not.toHaveBeenCalled();
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(handlers.onCreateConnector).not.toHaveBeenCalled();
  expect(handlers.onReconnectConnector).not.toHaveBeenCalled();
});

test("an add-only Zotero card offers Connect and calls onAddApiKey, never OAuth", async () => {
  const zotero = connectorCatalog.find((entry) => entry.id === "zotero")!;
  const onAddApiKey = vi.fn();
  const handlers = {
    onAddCredential: vi.fn(),
    onAddFeed: vi.fn(),
    onAddLoginFlow: vi.fn(),
    onCancelConnector: vi.fn(),
    onConfigure: vi.fn(),
    onConnectConnector: vi.fn(),
    onCreateConnector: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnectConnector: vi.fn(),
  };
  const mounted = await mountWithIntl(
    createElement(ConnectorCatalogCard, {
      item: zotero,
      connector: null,
      status: { kind: "available", label: "Available", detail: "Ready" },
      onAddApiKey,
      ...handlers,
    }),
  );
  const buttons = Array.from(mounted.container.querySelectorAll("button"));
  const action = buttons[buttons.length - 1]!;

  expect(action.textContent).toBe("Connect");
  await act(async () => action.click());

  expect(onAddApiKey).toHaveBeenCalledWith(zotero);
  expect(handlers.onAddCredential).not.toHaveBeenCalled();
  expect(handlers.onAddFeed).not.toHaveBeenCalled();
  expect(handlers.onAddLoginFlow).not.toHaveBeenCalled();
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(handlers.onCreateConnector).not.toHaveBeenCalled();
  expect(handlers.onReconnectConnector).not.toHaveBeenCalled();
});
