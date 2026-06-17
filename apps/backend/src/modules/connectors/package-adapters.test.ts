import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createPackageConnectorAdapters,
  createPackageAgentToolDefs,
} from "./package-adapters";
import type { ConnectorAdapter } from "@sourceweft/contracts";
import type { AgentToolDefinitionShape } from "@sourceweft/contracts/agent-tools";

const fakeAdapter: ConnectorAdapter = {
  capabilityId: "test-adapter",
  getManifest: () => ({
    type: "test",
    displayName: "Test",
    auth: {
      kind: "oauth2",
      authorizationUrl: "https://example.com/oauth/authorize",
      tokenUrl: "https://example.com/oauth/token",
      scopes: ["read"],
    },
    sync: {
      supportsIncremental: false,
      defaultFrequencyMinutes: 60,
      resources: [],
    },
    actions: [],
    configSchema: { type: "object" },
  }),
  exchangeOAuthCode: async () => ({ accessToken: "token" }),
  refreshOAuthToken: async () => ({ accessToken: "token" }),
  async *discover() {},
  extract: async ({ item }) => ({ item, contentText: "" }),
  executeAction: async () => ({ result: {} }),
};

const fakeToolDef: AgentToolDefinitionShape = {
  id: "test-tool",
  name: "test_tool",
  domain: "connector",
  capabilities: ["connector"],
  activation: {
    default: "off",
    userControl: "enable-disable",
    skill: { declarable: true, activates: true },
  },
};

test("createPackageConnectorAdapters with no args returns Notion adapter", () => {
  const adapters = createPackageConnectorAdapters();

  assert.equal(adapters.length, 1);
  assert.ok(adapters[0]);
  assert.equal(typeof adapters[0].getManifest, "function");
});

test("createPackageConnectorAdapters passes through custom adapter array", () => {
  const custom: ConnectorAdapter[] = [fakeAdapter];
  const adapters = createPackageConnectorAdapters(custom);

  assert.equal(adapters.length, 1);
  assert.strictEqual(adapters[0], fakeAdapter);
});

test("createPackageAgentToolDefs with no args returns Notion tool defs", () => {
  const toolDefs = createPackageAgentToolDefs();

  assert.ok(Array.isArray(toolDefs));
  assert.ok(toolDefs.length > 0);
  assert.ok(toolDefs.every((td) => typeof td.id === "string"));
});

test("createPackageAgentToolDefs passes through custom tool defs array", () => {
  const custom: AgentToolDefinitionShape[] = [fakeToolDef];
  const toolDefs = createPackageAgentToolDefs(custom);

  assert.equal(toolDefs.length, 1);
  assert.strictEqual(toolDefs[0], fakeToolDef);
  assert.equal(toolDefs[0].id, "test-tool");
});
