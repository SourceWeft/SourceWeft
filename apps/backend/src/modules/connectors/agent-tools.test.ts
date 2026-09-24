import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  buildConnectorActionToolset,
  createConnectorActionInterruptConfigs,
  createConnectorActionTools,
  type ConnectorActionToolContext,
} from "./agent-tools";
import { connectorRegistry } from "./registry";
import { listSourceConnectorRecords } from "./repository";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

vi.mock("./repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("./repository")>();
  return {
    ...original,
    listSourceConnectorRecords: vi.fn(),
  };
});

const manifest: ConnectorManifest = {
  type: "agent-toolset-test",
  displayName: "Agent Toolset Test",
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
      type: "agent-toolset-test.item.create",
      displayName: "Create test item",
      agentToolName: "agent_toolset_test_create",
      description: "Create a test item.",
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
    {
      type: "agent-toolset-test.item.read",
      displayName: "Read test item",
      agentToolName: "agent_toolset_test_read",
      description: "Read a test item.",
      visibility: "agent",
      capabilities: ["connector_read"],
      riskLevel: "low",
      requiresApproval: false,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
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

const context: ConnectorActionToolContext = {
  actionApprovalScope: "scope-1",
  teamId: "team-1",
  workspaceId: "workspace-1",
  userId: "user-1",
};

test("buildConnectorActionToolset keeps tools and interrupt config together", async () => {
  connectorRegistry.register(adapter);
  vi.mocked(listSourceConnectorRecords).mockResolvedValue([
    {
      id: "connector-1",
      connectorType: manifest.type,
      name: "Connector One",
      status: "active",
      oauthAccountId: "account-1",
    } as never,
  ]);

  const toolset = await buildConnectorActionToolset(context);
  const directTools = await createConnectorActionTools(context);
  const directInterruptOn = createConnectorActionInterruptConfigs();

  assert.strictEqual(toolset.context, context);
  assert.deepEqual(
    toolset.tools
      .map((item) => item.name)
      .filter((name) => name.startsWith("agent_toolset_test_")),
    directTools
      .map((item) => item.name)
      .filter((name) => name.startsWith("agent_toolset_test_")),
  );
  assert.ok(
    toolset.tools.some((tool) => tool.name === "agent_toolset_test_create"),
  );
  assert.deepEqual(
    toolset.interruptOn.agent_toolset_test_create,
    directInterruptOn.agent_toolset_test_create,
  );
});

test("buildConnectorActionToolset applies connector exclusion consistently", async () => {
  connectorRegistry.register(adapter);
  vi.mocked(listSourceConnectorRecords).mockResolvedValue([
    {
      id: "connector-1",
      connectorType: manifest.type,
      name: "Connector One",
      status: "active",
      oauthAccountId: "account-1",
    } as never,
  ]);

  const toolset = await buildConnectorActionToolset(context, {
    excludeConnectorTypes: [manifest.type],
  });

  assert.equal(
    toolset.tools.some((tool) => tool.name.startsWith("agent_toolset_test_")),
    false,
  );
  assert.equal(toolset.interruptOn.agent_toolset_test_create, undefined);
});

test("disabled Gmail live search removes read tools but keeps per-message send approval", async () => {
  const gmailManifest: ConnectorManifest = {
    ...manifest,
    type: "gmail",
    displayName: "Gmail",
    actions: [
      {
        ...manifest.actions[1]!,
        type: "gmail.message.search",
        agentToolName: "search_gmail_messages",
      },
      {
        ...manifest.actions[0]!,
        type: "gmail.message.send",
        agentToolName: "send_gmail_message",
        riskLevel: "high",
        allowStandingApproval: false,
        requestPrivacy: "encrypted",
      },
    ],
  };
  connectorRegistry.register({ ...adapter, getManifest: () => gmailManifest });
  vi.mocked(listSourceConnectorRecords).mockResolvedValue([
    {
      id: "gmail-connector",
      connectorType: "gmail",
      name: "Gmail",
      status: "active",
      oauthAccountId: "gmail-account",
      configJson: { liveSearchEnabled: false, indexingEnabled: true },
    } as never,
  ]);
  const tools = await createConnectorActionTools(context);
  assert.equal(
    tools.some((entry) => entry.name === "search_gmail_messages"),
    false,
  );
  assert.equal(
    tools.some((entry) => entry.name === "send_gmail_message"),
    true,
  );
  assert.deepEqual(
    createConnectorActionInterruptConfigs().send_gmail_message
      ?.allowedDecisions,
    ["approve", "edit", "reject"],
  );
});
