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
  status: ConnectorCatalogStatus;
}) {
  const handlers = {
    onCancelConnector: vi.fn(),
    onConfigure: vi.fn(),
    onConnectConnector: vi.fn(),
    onCreateConnector: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnectConnector: vi.fn(),
  };
  const mounted = await mountWithIntl(
    createElement(ConnectorCatalogCard, { item, ...input, ...handlers }),
  );
  const buttons = Array.from(mounted.container.querySelectorAll("button"));
  const action = buttons[buttons.length - 1]!;
  return { action, handlers };
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
