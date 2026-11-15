// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

import type { SourceConnector } from "@sourceweft/sdk";
import { button, flush, mountWithIntl, unmountAll } from "@/test/react";
import { ConnectorSettingsDialog } from "./settings-dialog";
import type { ConnectorItem, ConnectorManifestInfo } from "./types";

vi.mock("@/lib/billing-edition/capabilities", () => ({
  useBillingAvailable: () => false,
}));

const { listGmailLabels } = vi.hoisted(() => ({
  listGmailLabels: vi.fn(),
}));

vi.mock("../../../../../../lib/sdk", () => ({
  connectorsClient: { listGmailLabels },
}));

afterEach(unmountAll);

function gmailConnector(configJson: Record<string, unknown>): ConnectorItem {
  return {
    id: "gmail-1",
    name: "Gmail",
    status: "active",
    meta: "",
    raw: {
      id: "gmail-1",
      teamId: "t1",
      workspaceId: "ws",
      connectorType: "gmail",
      name: "Gmail",
      configJson,
      oauthAccountId: "acc-1",
      status: "active",
      periodicIndexingEnabled: false,
      indexingFrequencyMinutes: null,
      lastIndexedAt: null,
      nextScheduledAt: null,
      lastError: null,
      createdBy: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    } as SourceConnector,
  };
}

function baseProps(
  connector: ConnectorItem,
  connectorManifestInfoByType: Record<string, ConnectorManifestInfo>,
) {
  const handlers = {
    onCopyWebhook: vi.fn(),
    onDisconnect: vi.fn(),
    onOpenChange: vi.fn(),
    onReconnect: vi.fn(),
    onSaveSettings: vi.fn().mockResolvedValue(true),
    onSyncConnector: vi.fn(),
    onToggleStatus: vi.fn(),
  };
  return {
    props: {
      activity: [],
      activityError: null,
      connector,
      connectorBusyById: {},
      connectorManifestInfoByType,
      connectorReadinessById: {},
      isLoadingActivity: false,
      open: true,
      webhookConfig: null,
      ...handlers,
    },
    handlers,
  };
}

function configurationTabText() {
  return document.body.textContent ?? "";
}

// Radix tabs activate on a primary-button mousedown, not on click.
async function selectTab(label: string) {
  await act(async () => {
    button(label).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
  });
}

function liveSearchCheckbox() {
  const checkbox = document.querySelector<HTMLElement>(
    'button[role="checkbox"]',
  );
  if (!checkbox) throw new Error("live-search checkbox not found");
  return checkbox;
}

async function clickCheckbox(node: HTMLElement) {
  await act(async () => node.click());
}

test("a tools-only, brokered Gmail shows only the live-search switch and never fetches labels", async () => {
  listGmailLabels.mockResolvedValue({ labels: [] });
  const connector = gmailConnector({ liveSearchEnabled: true });
  const { props } = baseProps(connector, {
    gmail: { supportsIndexing: false, broker: "composio" },
  });

  await mountWithIntl(createElement(ConnectorSettingsDialog, props));
  await flush(5);
  await selectTab("Configuration");

  expect(listGmailLabels).not.toHaveBeenCalled();
  expect(configurationTabText()).toContain("Live Gmail search");
  expect(configurationTabText()).not.toContain(
    "Index selected mail in this workspace",
  );
  expect(configurationTabText()).not.toContain("Maximum messages");
});

test("today's indexable Gmail still shows full indexing controls and fetches labels", async () => {
  listGmailLabels.mockResolvedValue({
    labels: [{ id: "l1", name: "Label 1", type: "user" }],
  });
  const connector = gmailConnector({
    liveSearchEnabled: true,
    indexingEnabled: false,
    labelIds: [],
    maxMessages: 500,
  });
  const { props } = baseProps(connector, {
    gmail: { supportsIndexing: true, broker: null },
  });

  await mountWithIntl(createElement(ConnectorSettingsDialog, props));
  await flush(5);
  await selectTab("Configuration");

  expect(listGmailLabels).toHaveBeenCalledWith("ws", "gmail-1");
  expect(configurationTabText()).toContain(
    "Index selected mail in this workspace",
  );
});

test("a Gmail manifest absent from the map behaves like today's (indexable) shape", async () => {
  listGmailLabels.mockResolvedValue({ labels: [] });
  const connector = gmailConnector({
    liveSearchEnabled: true,
    indexingEnabled: false,
    labelIds: [],
    maxMessages: 500,
  });
  // No "gmail" entry at all, e.g. the manifest has not loaded yet.
  const { props } = baseProps(connector, {});

  await mountWithIntl(createElement(ConnectorSettingsDialog, props));
  await flush(5);
  await selectTab("Configuration");

  expect(listGmailLabels).toHaveBeenCalledWith("ws", "gmail-1");
  expect(configurationTabText()).toContain(
    "Index selected mail in this workspace",
  );
});

test("saving a tools-only Gmail sends only liveSearchEnabled, never the indexing fields", async () => {
  listGmailLabels.mockResolvedValue({ labels: [] });
  const connector = gmailConnector({ liveSearchEnabled: true });
  const { props, handlers } = baseProps(connector, {
    gmail: { supportsIndexing: false, broker: "composio" },
  });

  await mountWithIntl(createElement(ConnectorSettingsDialog, props));
  await flush(5);
  await selectTab("Configuration");
  await clickCheckbox(liveSearchCheckbox());
  await act(async () => button("Save settings").click());

  expect(handlers.onSaveSettings).toHaveBeenCalledTimes(1);
  const [, input] = handlers.onSaveSettings.mock.calls[0]!;
  expect(input.configJson).toEqual({ liveSearchEnabled: false });
});

test("saving today's indexable Gmail still sends the full config shape", async () => {
  listGmailLabels.mockResolvedValue({
    labels: [{ id: "l1", name: "Label 1", type: "user" }],
  });
  const connector = gmailConnector({
    liveSearchEnabled: true,
    indexingEnabled: false,
    labelIds: [],
    maxMessages: 500,
  });
  const { props, handlers } = baseProps(connector, {
    gmail: { supportsIndexing: true, broker: null },
  });

  await mountWithIntl(createElement(ConnectorSettingsDialog, props));
  await flush(5);
  await selectTab("Configuration");
  await clickCheckbox(liveSearchCheckbox());
  await act(async () => button("Save settings").click());

  expect(handlers.onSaveSettings).toHaveBeenCalledTimes(1);
  const [, input] = handlers.onSaveSettings.mock.calls[0]!;
  expect(input.configJson).toEqual({
    liveSearchEnabled: false,
    indexingEnabled: false,
    labelIds: [],
    maxMessages: 500,
  });
});

test("a tools-only Gmail is never advertised as indexable in the settings dialog", async () => {
  listGmailLabels.mockResolvedValue({ labels: [] });
  const connector = gmailConnector({ liveSearchEnabled: true });
  const { props } = baseProps(connector, {
    gmail: { supportsIndexing: false, broker: "composio" },
  });

  await mountWithIntl(createElement(ConnectorSettingsDialog, props));
  await flush(5);

  // The header type badge is always visible.
  expect(document.body.textContent ?? "").toContain("Search API");

  await selectTab("Configuration");
  const text = document.body.textContent ?? "";
  expect(text).toContain("Non-indexable search"); // capabilities row
  expect(text).not.toContain("Indexable source");
  expect(text).not.toContain("Periodic sync");
});

test("today's indexable Gmail is advertised as indexable in the settings dialog", async () => {
  listGmailLabels.mockResolvedValue({ labels: [] });
  const connector = gmailConnector({ liveSearchEnabled: true });
  const { props } = baseProps(connector, {
    gmail: { supportsIndexing: true, broker: null },
  });

  await mountWithIntl(createElement(ConnectorSettingsDialog, props));
  await flush(5);

  expect(document.body.textContent ?? "").toContain("Indexable");

  await selectTab("Configuration");
  const text = document.body.textContent ?? "";
  expect(text).toContain("Indexable source");
  expect(text).toContain("Periodic sync");
});
