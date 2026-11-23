const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../shared/logger", () => ({
  logger: {
    debug: loggerMocks.debug,
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
  },
}));
// Only `getRuntimeToken` is stubbed; every other export (notably
// `connectorRegistry`, the same singleton the tests register adapters on) is
// the real module, so direct tool invocation can reach the adapter without a
// database-backed OAuth account.
vi.mock(".", async (importOriginal) => {
  const original = await importOriginal<typeof import(".")>();
  return {
    ...original,
    connectorOAuthService: {
      getRuntimeToken: vi.fn().mockResolvedValue({ accessToken: "token" }),
      markBrokeredAccountReauthRequired: vi.fn().mockResolvedValue(undefined),
    },
  };
});
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  approveConnectorActionForTrustRule,
  buildConnectorActionToolset,
  createConnectorActionInterruptConfigs,
  createConnectorActionTools,
  resolveConnectorActionTrustScope,
  type ConnectorActionToolContext,
  CONNECTOR_ACTION_APPROVED_NOTE,
  connectorActionToolOutput,
} from "./agent-tools";
import { ConnectorError } from "./errors";
import { connectorRegistry } from "./registry";
import {
  findOAuthAccountRecord,
  listSourceConnectorRecords,
} from "./repository";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

vi.mock("./repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("./repository")>();
  return {
    ...original,
    findOAuthAccountRecord: vi.fn().mockResolvedValue(null),
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
  assert.equal(
    await resolveConnectorActionTrustScope(context, {
      toolName: "send_gmail_message",
      args: {
        to: ["recipient@example.com"],
        subject: "Hello",
        body: "Private body",
      },
    }),
    null,
  );
  assert.equal(
    await approveConnectorActionForTrustRule(context, {
      toolName: "send_gmail_message",
      toolCallId: "call-1",
      args: {
        to: ["recipient@example.com"],
        subject: "Hello",
        body: "Private body",
      },
    }),
    null,
  );
});

test("Gmail tools name the connected mailbox so the agent knows the user's address", async () => {
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
  const gmailConnector = (id: string, oauthAccountId: string) =>
    ({
      id,
      connectorType: "gmail",
      name: "Gmail",
      status: "active",
      oauthAccountId,
      configJson: { liveSearchEnabled: true },
    }) as never;
  const emails: Record<string, string> = {
    "account-1": "owner@example.com",
    "account-2": "second@example.com",
  };
  vi.mocked(findOAuthAccountRecord).mockImplementation(
    async (input) =>
      ({ providerAccountEmail: emails[input.accountId] ?? null }) as never,
  );

  vi.mocked(listSourceConnectorRecords).mockResolvedValue([
    gmailConnector("gmail-1", "account-1"),
  ]);
  const single = await createConnectorActionTools(context);
  for (const name of ["search_gmail_messages", "send_gmail_message"]) {
    assert.match(
      single.find((entry) => entry.name === name)?.description ?? "",
      /Connected mailbox: owner@example\.com; this is the user's own address/,
    );
  }

  vi.mocked(listSourceConnectorRecords).mockResolvedValue([
    gmailConnector("gmail-1", "account-1"),
    gmailConnector("gmail-2", "account-2"),
  ]);
  const multiple = await createConnectorActionTools(context);
  assert.match(
    multiple.find((entry) => entry.name === "send_gmail_message")
      ?.description ?? "",
    /Connected mailboxes: owner@example\.com \(connectorId gmail-1\), second@example\.com \(connectorId gmail-2\)/,
  );

  // Other connector types are not looked up or annotated.
  vi.mocked(findOAuthAccountRecord).mockClear();
  vi.mocked(listSourceConnectorRecords).mockResolvedValue([
    {
      id: "connector-1",
      connectorType: manifest.type,
      name: "Test",
      status: "active",
      oauthAccountId: "account-1",
      configJson: {},
    } as never,
  ]);
  const others = await createConnectorActionTools(context);
  assert.equal(vi.mocked(findOAuthAccountRecord).mock.calls.length, 0);
  assert.equal(
    others.some((entry) => /Connected mailbox/.test(entry.description)),
    false,
  );
  vi.mocked(findOAuthAccountRecord).mockResolvedValue(null);
});

test("an approved connector action's result says the user approved it", () => {
  const action = {
    id: "action-1",
    teamId: "team-1",
    workspaceId: "workspace-1",
    connectorId: "connector-1",
    connectorType: "gmail",
    actionType: "gmail.message.send",
    agentToolName: "send_gmail_message",
    riskLevel: "high" as const,
    status: "succeeded" as const,
    requestJson: {},
    requestPreview: "",
    resultJson: { sent: true, messageId: "m-1" },
    externalId: "m-1",
    idempotencyKey: "key",
    approvedBy: "user-1",
    executedBy: "user-1",
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };

  // A delegated sub-agent resumes in a fresh run that never saw the approval
  // prompt; the result is its only sign the action was approved.
  assert.deepEqual(connectorActionToolOutput({ action }), {
    sent: true,
    messageId: "m-1",
    actionType: "gmail.message.send",
    toolName: "send_gmail_message",
    approval: CONNECTOR_ACTION_APPROVED_NOTE,
  });
  assert.equal(
    "approval" in
      connectorActionToolOutput({
        action: { ...action, approvedBy: null },
      }),
    false,
  );
});

const githubReadManifest: ConnectorManifest = {
  ...manifest,
  type: "github",
  displayName: "GitHub",
  actions: [
    {
      type: "github.issue.search",
      displayName: "Search GitHub issues",
      agentToolName: "search_github",
      description: "Search GitHub issues.",
      visibility: "agent",
      capabilities: ["connector_read"],
      riskLevel: "low",
      requiresApproval: false,
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

const githubConnector = {
  id: "github-connector",
  connectorType: "github",
  name: "GitHub",
  status: "active",
  oauthAccountId: "github-account",
} as never;

test("does not log the result of a read action for any connector type", async () => {
  loggerMocks.debug.mockClear();
  connectorRegistry.register({
    ...adapter,
    getManifest: () => githubReadManifest,
    executeAction: async () => ({
      result: { items: [{ title: "secret title" }] },
      rawResponseJson: { body: "secret body" },
    }),
  });
  vi.mocked(listSourceConnectorRecords).mockResolvedValue([githubConnector]);

  const tools = await createConnectorActionTools(context);
  const readTool = tools.find(
    (item) => item.name === "search_github",
  ) as unknown as { invoke(input: Record<string, unknown>): Promise<unknown> };
  assert.ok(readTool);
  await readTool.invoke({});

  const logged = JSON.stringify(loggerMocks.debug.mock.calls);
  assert.equal(logged.includes("secret title"), false);
  assert.equal(logged.includes("secret body"), false);
  assert.equal(
    logged.includes("Connector action direct adapter execution succeeded"),
    true,
  );
});

const toolsOnlyManifest: ConnectorManifest = {
  ...manifest,
  type: "tools-only-test",
  displayName: "Tools Only Test",
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 60,
    resources: [],
  },
  selection: {
    actions: { browse: "browse", describe: "describe" },
    kinds: ["item"],
    maxItems: 100,
  },
  actions: [
    {
      type: "tools-only-test.item.read",
      displayName: "Read tools-only item",
      agentToolName: "read_tools_only_item",
      description: "Read a tools-only item.",
      visibility: "agent",
      capabilities: ["connector_read"],
      riskLevel: "low",
      requiresApproval: false,
      inputSchema: { type: "object", properties: {} },
    },
  ],
};

test("a paused tools-only connector binds no tools", async () => {
  connectorRegistry.register({
    ...adapter,
    getManifest: () => toolsOnlyManifest,
  });

  for (const status of ["paused", "disabled", "error"] as const) {
    vi.mocked(listSourceConnectorRecords).mockResolvedValue([
      {
        id: "tools-only-connector",
        connectorType: toolsOnlyManifest.type,
        name: "Tools Only",
        status,
        oauthAccountId: "tools-only-account",
      } as never,
    ]);
    const tools = await createConnectorActionTools(context);
    assert.equal(
      tools.some((entry) => entry.name === "read_tools_only_item"),
      false,
      `expected no tool bound for status "${status}"`,
    );
  }

  vi.mocked(listSourceConnectorRecords).mockResolvedValue([
    {
      id: "tools-only-connector",
      connectorType: toolsOnlyManifest.type,
      name: "Tools Only",
      status: "active",
      oauthAccountId: "tools-only-account",
    } as never,
  ]);
  const activeTools = await createConnectorActionTools(context);
  assert.equal(
    activeTools.some((entry) => entry.name === "read_tools_only_item"),
    true,
  );
});

function findDebugCall(message: string) {
  const call = loggerMocks.debug.mock.calls.find(
    (entry) => entry[0] === message,
  );
  return call as [string, Record<string, unknown>] | undefined;
}

test("does not log the provider response of a failed read action", async () => {
  loggerMocks.debug.mockClear();
  loggerMocks.info.mockClear();
  loggerMocks.warn.mockClear();
  loggerMocks.error.mockClear();
  connectorRegistry.register({
    ...adapter,
    getManifest: () => githubReadManifest,
    executeAction: async () => {
      throw new ConnectorError(502, "GITHUB_UNAVAILABLE", "secret provider text", {
        rawResponseJson: { body: "secret body" },
      });
    },
  });
  vi.mocked(listSourceConnectorRecords).mockResolvedValue([githubConnector]);

  const tools = await createConnectorActionTools(context);
  const readTool = tools.find(
    (item) => item.name === "search_github",
  ) as unknown as { invoke(input: Record<string, unknown>): Promise<unknown> };
  assert.ok(readTool);
  await readTool.invoke({});

  // The provider text must appear at NO logger level — the error-level log in
  // `connectorToolResult` used to leak it through `message`/`stack`.
  const everyLevel = JSON.stringify([
    loggerMocks.debug.mock.calls,
    loggerMocks.info.mock.calls,
    loggerMocks.warn.mock.calls,
    loggerMocks.error.mock.calls,
  ]);
  assert.equal(everyLevel.includes("secret body"), false);
  assert.equal(everyLevel.includes("secret provider text"), false);
  assert.equal(
    JSON.stringify(loggerMocks.debug.mock.calls).includes(
      "Connector action direct adapter execution failed",
    ),
    true,
  );
  const failureCall = findDebugCall(
    "Connector action direct adapter execution failed",
  );
  assert.ok(failureCall);
  const [, failureMeta] = failureCall!;
  assert.equal(failureMeta.errorCode, "GITHUB_UNAVAILABLE");
  assert.equal(failureMeta.statusCode, 502);
  assert.equal("errorMessage" in failureMeta, false);

  // The error-level line still records the shape of the failure, by code/name.
  const errorCall = loggerMocks.error.mock.calls.find(
    (entry) => entry[0] === "Connector agent tool failed",
  );
  assert.ok(errorCall);
  const errorMeta = errorCall![1] as Record<string, unknown>;
  assert.equal(errorMeta.code, "GITHUB_UNAVAILABLE");
  assert.equal(errorMeta.errorName, "ConnectorError");
  assert.equal("error" in errorMeta, false);
  assert.equal("stack" in errorMeta, false);
});

test("still logs the error message of a failed non-read action on a non-Gmail connector", async () => {
  loggerMocks.debug.mockClear();
  loggerMocks.error.mockClear();
  const githubWriteFailManifest: ConnectorManifest = {
    ...manifest,
    type: "github",
    displayName: "GitHub",
    actions: [
      {
        type: "github.issue.create",
        displayName: "Create GitHub issue",
        agentToolName: "create_github_issue",
        description: "Create a GitHub issue.",
        visibility: "agent",
        capabilities: ["connector_write"],
        riskLevel: "medium",
        requiresApproval: false,
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
  connectorRegistry.register({
    ...adapter,
    getManifest: () => githubWriteFailManifest,
    executeAction: async () => {
      throw new ConnectorError(
        500,
        "GITHUB_WRITE_FAILED",
        "write failed: quota",
      );
    },
  });
  vi.mocked(listSourceConnectorRecords).mockResolvedValue([githubConnector]);

  const tools = await createConnectorActionTools(context);
  const writeTool = tools.find(
    (item) => item.name === "create_github_issue",
  ) as unknown as { invoke(input: Record<string, unknown>): Promise<unknown> };
  assert.ok(writeTool);
  await writeTool.invoke({});

  const failureCall = findDebugCall(
    "Connector action direct adapter execution failed",
  );
  assert.ok(failureCall);
  const [, failureMeta] = failureCall!;
  assert.equal(failureMeta.errorMessage, "write failed: quota");
  assert.equal(failureMeta.errorCode, "GITHUB_WRITE_FAILED");
  assert.equal(failureMeta.statusCode, 500);

  // A non-read action is not subject to the omit rule, so the error-level log
  // still carries the error message.
  const errorCall = loggerMocks.error.mock.calls.find(
    (entry) => entry[0] === "Connector agent tool failed",
  );
  assert.ok(errorCall);
  assert.equal(
    (errorCall![1] as Record<string, unknown>).error,
    "write failed: quota",
  );
});

test("still logs the result of a non-read action on a non-Gmail connector", async () => {
  loggerMocks.debug.mockClear();
  const githubWriteManifest: ConnectorManifest = {
    ...manifest,
    type: "github",
    displayName: "GitHub",
    actions: [
      {
        type: "github.issue.create",
        displayName: "Create GitHub issue",
        agentToolName: "create_github_issue",
        description: "Create a GitHub issue.",
        visibility: "agent",
        capabilities: ["connector_write"],
        riskLevel: "medium",
        requiresApproval: false,
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
  connectorRegistry.register({
    ...adapter,
    getManifest: () => githubWriteManifest,
    executeAction: async () => ({
      result: { id: "created-1" },
      rawResponseJson: { ok: true },
    }),
  });
  vi.mocked(listSourceConnectorRecords).mockResolvedValue([githubConnector]);

  const tools = await createConnectorActionTools(context);
  const writeTool = tools.find(
    (item) => item.name === "create_github_issue",
  ) as unknown as { invoke(input: Record<string, unknown>): Promise<unknown> };
  assert.ok(writeTool);
  await writeTool.invoke({});

  const logged = JSON.stringify(loggerMocks.debug.mock.calls);
  assert.equal(logged.includes("created-1"), true);
});
