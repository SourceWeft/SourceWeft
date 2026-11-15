// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { click, mountWithIntl, unmountAll } from "@/test/react";
import { ManageConnectorsDialog } from "./manage-dialog";
import type { ConnectorManifestInfo } from "./types";

vi.mock("@/lib/billing-edition/capabilities", () => ({
  useBillingAvailable: () => false,
}));

afterEach(unmountAll);

function baseProps(
  overrides: {
    availableConnectorTypes?: string[];
    connectorManifestInfoByType?: Record<string, ConnectorManifestInfo>;
  } = {},
) {
  const handlers = {
    onCancelConnector: vi.fn(),
    onConnectConnector: vi.fn(),
    onCopyWebhook: vi.fn(),
    onCreateConnector: vi.fn(),
    onDisconnectConnector: vi.fn(),
    onOpenChange: vi.fn(),
    onOpenSettings: vi.fn(),
    onSyncConnector: vi.fn(),
    onToggleConnectorStatus: vi.fn(),
  };
  return {
    props: {
      accounts: [],
      availableConnectorTypes: overrides.availableConnectorTypes ?? ["gmail"],
      connectorBusyById: {},
      connectorManifestInfoByType: overrides.connectorManifestInfoByType ?? {},
      connectorReadinessById: {},
      connectors: [],
      connectorWaitingByType: {},
      initialTab: "all" as const,
      isLoading: false,
      loadingError: null,
      open: true,
      webhookConfigsById: {},
      webhookEventsByConnectorId: {},
      ...handlers,
    },
    handlers,
  };
}

/** The Gmail catalog card's article, found by its heading text (Radix portals
 * dialog content onto `document.body`, so search there, not a local
 * container). */
function gmailCard() {
  const articles = Array.from(document.querySelectorAll("article"));
  const article = articles.find((node) =>
    node.querySelector("h4")?.textContent?.trim() === "Gmail",
  );
  if (!article) throw new Error("Gmail catalog card not found");
  return article;
}

function buttonWithText(scope: ParentNode, label: string) {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (node) => node.textContent?.trim() === label,
  );
  if (!match) throw new Error(`button "${label}" not found`);
  return match;
}

test("today's indexable Gmail manifest still opens the mode-choice dialog", async () => {
  const { props, handlers } = baseProps({
    connectorManifestInfoByType: {
      gmail: { supportsIndexing: true, broker: null },
    },
  });
  await mountWithIntl(createElement(ManageConnectorsDialog, props));

  await click(buttonWithText(gmailCard(), "Connect"));

  expect(
    document.body.textContent?.includes("Choose how to use Gmail"),
  ).toBe(true);
  expect(
    document.body.textContent?.includes("Connect Gmail through Composio"),
  ).toBe(false);
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
});

test("a tools-only, Composio-brokered Gmail manifest shows the broker notice instead", async () => {
  const { props, handlers } = baseProps({
    connectorManifestInfoByType: {
      gmail: { supportsIndexing: false, broker: "composio" },
    },
  });
  await mountWithIntl(createElement(ManageConnectorsDialog, props));

  await click(buttonWithText(gmailCard(), "Connect"));

  expect(
    document.body.textContent?.includes("Connect Gmail through Composio"),
  ).toBe(true);
  expect(
    document.body.textContent?.includes("Choose how to use Gmail"),
  ).toBe(false);
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();

  await click(buttonWithText(document.body, "Continue to Google"));

  expect(handlers.onConnectConnector).toHaveBeenCalledTimes(1);
  expect(handlers.onConnectConnector).toHaveBeenCalledWith(
    expect.objectContaining({ id: "gmail" }),
    "tools",
  );
});

test("the broker notice's Cancel button closes it without connecting", async () => {
  const { props, handlers } = baseProps({
    connectorManifestInfoByType: {
      gmail: { supportsIndexing: false, broker: "composio" },
    },
  });
  await mountWithIntl(createElement(ManageConnectorsDialog, props));

  await click(buttonWithText(gmailCard(), "Connect"));
  await click(buttonWithText(document.body, "Cancel"));

  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(
    document.body.textContent?.includes("Connect Gmail through Composio"),
  ).toBe(false);
});

test("a tools-only Gmail manifest with no broker connects directly, with no dialog", async () => {
  const { props, handlers } = baseProps({
    connectorManifestInfoByType: {
      gmail: { supportsIndexing: false, broker: null },
    },
  });
  await mountWithIntl(createElement(ManageConnectorsDialog, props));

  await click(buttonWithText(gmailCard(), "Connect"));

  expect(handlers.onConnectConnector).toHaveBeenCalledTimes(1);
  expect(handlers.onConnectConnector).toHaveBeenCalledWith(
    expect.objectContaining({ id: "gmail" }),
    "tools",
  );
  expect(
    document.body.textContent?.includes("Connect Gmail through Composio"),
  ).toBe(false);
  expect(
    document.body.textContent?.includes("Choose how to use Gmail"),
  ).toBe(false);
});

test("a tools-only Gmail manifest drops the 'Optional indexing' chip, keeping the others", async () => {
  const { props } = baseProps({
    connectorManifestInfoByType: {
      gmail: { supportsIndexing: false, broker: "composio" },
    },
  });
  await mountWithIntl(createElement(ManageConnectorsDialog, props));

  const card = gmailCard();
  expect(card.textContent?.includes("Optional indexing")).toBe(false);
  expect(card.textContent?.includes("Search")).toBe(true);
});

test("today's Gmail manifest keeps the 'Optional indexing' chip", async () => {
  const { props } = baseProps({
    connectorManifestInfoByType: {
      gmail: { supportsIndexing: true, broker: null },
    },
  });
  await mountWithIntl(createElement(ManageConnectorsDialog, props));

  expect(gmailCard().textContent?.includes("Optional indexing")).toBe(true);
});
