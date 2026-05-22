import assert from "node:assert/strict";
import { test } from "vitest";
import { ConnectorError } from "./errors";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

const manifest: ConnectorManifest = {
  type: "fake",
  displayName: "Fake",
  auth: {
    kind: "oauth2",
    authorizationUrl: "https://provider.example/oauth/authorize",
    tokenUrl: "https://provider.example/oauth/token",
    scopes: ["read"],
  },
  sync: {
    supportsIncremental: true,
    defaultFrequencyMinutes: 60,
    resources: [],
  },
  actions: [
    {
      type: "fake.item.create",
      displayName: "Create fake item",
      agentToolName: "fake_item_create",
      description: "Create a fake item.",
      visibility: "agent",
      capabilities: ["connector_write", "connector_create"],
      riskLevel: "medium",
      requiresApproval: true,
      inputSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
        },
      },
    },
  ],
  configSchema: { type: "object" },
};

const adapter: ConnectorAdapter = {
  getManifest: () => manifest,
  exchangeOAuthCode: async () => ({ accessToken: "token" }),
  refreshOAuthToken: async () => ({ accessToken: "token" }),
  async *discover() {},
  extract: async ({ item }) => ({ item, contentText: "" }),
  executeAction: async () => ({ result: {} }),
};

test("ConnectorRegistry registers adapters and lists manifests", () => {
  const registry = new ConnectorRegistry([adapter]);

  assert.equal(registry.getAdapter("fake"), adapter);
  assert.deepEqual(registry.listManifests(), [manifest]);
});

test("ConnectorRegistry preserves agent-facing action metadata", () => {
  const registry = new ConnectorRegistry([adapter]);
  const [action] = registry.getManifest("fake").actions;

  assert.equal(action?.agentToolName, "fake_item_create");
  assert.equal(action?.visibility, "agent");
  assert.deepEqual(action?.capabilities, [
    "connector_write",
    "connector_create",
  ]);
});

test("ConnectorRegistry rejects missing adapters with connector error", () => {
  const registry = new ConnectorRegistry();

  assert.throws(
    () => registry.getAdapter("missing"),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_ADAPTER_NOT_FOUND",
  );
});
