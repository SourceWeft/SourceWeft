// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  click,
  flush,
  mountWithIntl,
  typeInto,
  unmountAll,
} from "@/test/react";
import { ManageConnectorsDialog } from "./manage-dialog";
import type { ConnectorManifestInfo } from "./types";

vi.mock("@/lib/billing-edition/capabilities", () => ({
  useBillingAvailable: () => false,
}));

// The forum dialog's Radix Checkbox measures itself with a ResizeObserver,
// which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;

afterEach(unmountAll);

function baseProps(
  overrides: {
    availableConnectorTypes?: string[];
    connectorManifestInfoByType?: Record<string, ConnectorManifestInfo>;
  } = {},
) {
  const handlers = {
    onAddLoginFlow: vi.fn(),
    onCancelConnector: vi.fn(),
    onCheckCredential: vi.fn(),
    onCheckFeed: vi.fn(),
    onCheckForum: vi.fn(),
    onCheckSite: vi.fn(),
    onConnectConnector: vi.fn(),
    onCopyWebhook: vi.fn(),
    onCreateConnector: vi.fn(),
    onDisconnectConnector: vi.fn(),
    onOpenChange: vi.fn(),
    onOpenSettings: vi.fn(),
    onSubmitCredential: vi.fn(),
    onSubmitFeed: vi.fn(),
    onSubmitForum: vi.fn(),
    onSubmitSite: vi.fn(),
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
  const article = articles.find(
    (node) => node.querySelector("h4")?.textContent?.trim() === "Gmail",
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

  expect(document.body.textContent?.includes("Choose how to use Gmail")).toBe(
    true,
  );
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
  expect(document.body.textContent?.includes("Choose how to use Gmail")).toBe(
    false,
  );
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
  expect(document.body.textContent?.includes("Choose how to use Gmail")).toBe(
    false,
  );
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

test("reconnecting a Composio-brokered Gmail shows the broker notice, like a first connect", async () => {
  const { props, handlers } = baseProps({
    connectorManifestInfoByType: {
      gmail: { supportsIndexing: false, broker: "composio" },
    },
  });
  // A Gmail connector that needs attention, so its card offers Reconnect.
  props.connectors = [
    {
      id: "gmail-1",
      name: "Gmail",
      status: "error",
      meta: "",
      raw: {
        id: "gmail-1",
        connectorType: "gmail",
        status: "error",
        configJson: {},
        oauthAccountId: "acc-1",
        lastError: "Needs attention",
      },
    },
  ] as never;
  await mountWithIntl(createElement(ManageConnectorsDialog, props));

  await click(buttonWithText(gmailCard(), "Reconnect"));

  expect(
    document.body.textContent?.includes("Connect Gmail through Composio"),
  ).toBe(true);
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();

  await click(buttonWithText(document.body, "Continue to Google"));

  expect(handlers.onConnectConnector).toHaveBeenCalledWith(
    expect.objectContaining({ id: "gmail" }),
    "tools",
  );
});

test("the RSS card opens the add-feed dialog and the dialog's callbacks reach the hook", async () => {
  const { props, handlers } = baseProps({ availableConnectorTypes: ["rss"] });
  handlers.onCheckFeed.mockResolvedValue({
    ready: true,
    reason: "",
    message: "",
    title: "Example Blog",
    itemCount: 3,
  });
  handlers.onSubmitFeed.mockResolvedValue(undefined);
  await mountWithIntl(createElement(ManageConnectorsDialog, props));
  const rssCard = Array.from(document.querySelectorAll("article")).find(
    (node) => node.querySelector("h4")?.textContent?.trim() === "RSS / Atom",
  )!;

  expect(document.querySelector('input[name="feedUrl"]')).toBeNull();
  await click(buttonWithText(rssCard, "Add feed"));

  const urlField = document.querySelector<HTMLInputElement>(
    'input[name="feedUrl"]',
  )!;
  expect(urlField).not.toBeNull();
  typeInto(urlField, "https://example.com/feed.xml");
  await flush(3);
  await click(buttonWithText(document.body, "Check feed"));
  await flush(5);
  expect(handlers.onCheckFeed).toHaveBeenCalledWith(
    "https://example.com/feed.xml",
  );

  const dialog = document.querySelector('[role="dialog"][data-state="open"]');
  const addButtons = Array.from(document.querySelectorAll("button")).filter(
    (node) =>
      node.textContent?.trim() === "Add feed" && !rssCard.contains(node),
  );
  expect(dialog).not.toBeNull();
  await click(addButtons[addButtons.length - 1]!);
  await flush(5);

  expect(handlers.onSubmitFeed).toHaveBeenCalledWith({
    name: "Example Blog",
    feedUrl: "https://example.com/feed.xml",
  });
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(document.querySelector('input[name="feedUrl"]')).toBeNull();
});

test("one WordPress card opens the site dialog and the public path reaches the hook", async () => {
  const { props, handlers } = baseProps({
    availableConnectorTypes: ["wordpress", "wordpress_login"],
  });
  handlers.onCheckSite.mockResolvedValue({
    ready: true,
    reason: "",
    message: "",
  });
  handlers.onSubmitSite.mockResolvedValue(undefined);
  await mountWithIntl(createElement(ManageConnectorsDialog, props));
  const cards = Array.from(document.querySelectorAll("article")).filter(
    (node) => node.querySelector("h4")?.textContent?.trim() === "WordPress",
  );
  // The login type never adds a second card.
  expect(cards).toHaveLength(1);

  expect(document.querySelector('input[name="wordpressSiteUrl"]')).toBeNull();
  await click(buttonWithText(cards[0]!, "Connect"));

  const urlField = document.querySelector<HTMLInputElement>(
    'input[name="wordpressSiteUrl"]',
  )!;
  expect(urlField).not.toBeNull();
  typeInto(urlField, "https://blog.example.com");
  await flush(3);
  await click(buttonWithText(document.body, "Check site"));
  await flush(5);
  expect(handlers.onCheckSite).toHaveBeenCalledWith({
    access: "public",
    siteUrl: "https://blog.example.com",
    includeUnpublished: false,
  });

  await click(buttonWithText(document.body, "Add site"));
  await flush(5);

  expect(handlers.onSubmitSite).toHaveBeenCalledWith({
    access: "public",
    siteUrl: "https://blog.example.com",
    includeUnpublished: false,
    name: "WordPress",
    periodicIndexingEnabled: false,
  });
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(document.querySelector('input[name="wordpressSiteUrl"]')).toBeNull();
});

test("the Discourse card opens the forum dialog and its callbacks reach the hook", async () => {
  const { props, handlers } = baseProps({
    availableConnectorTypes: ["discourse"],
  });
  handlers.onCheckForum.mockResolvedValue({
    ready: false,
    reason: "selection_required",
    message: "",
  });
  handlers.onSubmitForum.mockResolvedValue(undefined);
  await mountWithIntl(createElement(ManageConnectorsDialog, props));
  const card = Array.from(document.querySelectorAll("article")).find(
    (node) => node.querySelector("h4")?.textContent?.trim() === "Discourse",
  )!;

  expect(document.querySelector('input[name="forumUrl"]')).toBeNull();
  await click(buttonWithText(card, "Connect"));

  const urlField = document.querySelector<HTMLInputElement>(
    'input[name="forumUrl"]',
  )!;
  expect(urlField).not.toBeNull();
  typeInto(urlField, "https://forum.example.com");
  await flush(3);
  await click(buttonWithText(document.body, "Check forum"));
  await flush(5);
  expect(handlers.onCheckForum).toHaveBeenCalledWith({
    connectorType: "discourse",
    configJson: {
      forumUrl: "https://forum.example.com",
      items: [],
      refresh: "light",
    },
  });

  await click(buttonWithText(document.body, "Add forum"));
  await flush(5);

  expect(handlers.onSubmitForum).toHaveBeenCalledWith({
    connectorType: "discourse",
    name: "Discourse",
    configJson: {
      forumUrl: "https://forum.example.com",
      items: [],
      refresh: "light",
    },
    periodicIndexingEnabled: false,
  });
  expect(handlers.onConnectConnector).not.toHaveBeenCalled();
  expect(document.querySelector('input[name="forumUrl"]')).toBeNull();
});
