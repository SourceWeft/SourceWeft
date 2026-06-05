import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { McpError } from "./errors";
import type {
  McpActionRunRecord,
  McpToolRunRecord,
  WorkspaceMcpInstallRecord,
  WorkspaceMcpToolRecord,
} from "./types";

const mocks = vi.hoisted(() => ({
  createLangChainMcpClient: vi.fn(),
  createMcpActionRun: vi.fn(),
  createMcpToolRun: vi.fn(),
  createOrUpdateMarketMcpInstall: vi.fn(),
  deleteWorkspaceMcpInstall: vi.fn(),
  decryptSecret: vi.fn(),
  encryptSecret: vi.fn(),
  findMcpActionRun: vi.fn(),
  findWorkspaceMcpCredential: vi.fn(),
  findWorkspaceMcpInstall: vi.fn(),
  findWorkspaceMcpInstallByMarketIdentifier: vi.fn(),
  listMcpActionRuns: vi.fn(),
  listMcpToolRuns: vi.fn(),
  listWorkspaceMcpInstalls: vi.fn(),
  requireMcpWorkspace: vi.fn(),
  setWorkspaceMcpToolsEnabled: vi.fn(),
  updateMcpActionRun: vi.fn(),
  updateMcpToolRun: vi.fn(),
  updateWorkspaceMcpInstall: vi.fn(),
  upsertWorkspaceMcpCredential: vi.fn(),
  upsertWorkspaceMcpTools: vi.fn(),
}));

vi.mock("../../shared/config", () => ({
  config: {
    market: { trustedPublicKeys: [] },
    modelGatewayEncryptionSecret: "test-encryption-secret",
  },
}));

vi.mock("../../shared/secrets", () => ({
  decryptSecret: mocks.decryptSecret,
  encryptSecret: mocks.encryptSecret,
}));

vi.mock("./langchain-client", () => ({
  createLangChainMcpClient: mocks.createLangChainMcpClient,
}));

vi.mock("./market-service", () => ({
  marketService: {
    getMcp: vi.fn(),
    getMcpManifest: vi.fn(),
    listMcp: vi.fn(),
  },
}));

vi.mock("./permissions", () => ({
  requireMcpWorkspace: mocks.requireMcpWorkspace,
}));

vi.mock("./repository", () => ({
  createMcpActionRun: mocks.createMcpActionRun,
  createMcpToolRun: mocks.createMcpToolRun,
  createOrUpdateMarketMcpInstall: mocks.createOrUpdateMarketMcpInstall,
  deleteWorkspaceMcpInstall: mocks.deleteWorkspaceMcpInstall,
  findMcpActionRun: mocks.findMcpActionRun,
  findWorkspaceMcpCredential: mocks.findWorkspaceMcpCredential,
  findWorkspaceMcpInstall: mocks.findWorkspaceMcpInstall,
  findWorkspaceMcpInstallByMarketIdentifier:
    mocks.findWorkspaceMcpInstallByMarketIdentifier,
  listMcpActionRuns: mocks.listMcpActionRuns,
  listMcpToolRuns: mocks.listMcpToolRuns,
  listWorkspaceMcpInstalls: mocks.listWorkspaceMcpInstalls,
  setWorkspaceMcpToolsEnabled: mocks.setWorkspaceMcpToolsEnabled,
  updateMcpActionRun: mocks.updateMcpActionRun,
  updateMcpToolRun: mocks.updateMcpToolRun,
  updateWorkspaceMcpInstall: mocks.updateWorkspaceMcpInstall,
  upsertWorkspaceMcpCredential: mocks.upsertWorkspaceMcpCredential,
  upsertWorkspaceMcpTools: mocks.upsertWorkspaceMcpTools,
}));

import { McpService, stripLangChainMcpToolPrefix } from "./service";

const NOW = "2026-01-01T00:00:00.000Z";

let toolsByInstallId = new Map<string, DynamicStructuredTool[]>();
let clientCloseMocks: Array<ReturnType<typeof vi.fn>> = [];

test("stripLangChainMcpToolPrefix handles server keys with underscores", () => {
  assert.equal(
    stripLangChainMcpToolPrefix({
      serverKey: "github_mcp_server",
      toolName: "mcp__github_mcp_server__create_issue",
    }),
    "create_issue",
  );
  assert.equal(
    stripLangChainMcpToolPrefix({
      serverKey: "github",
      toolName: "mcp__github_mcp_server__create_issue",
    }),
    "mcp__github_mcp_server__create_issue",
  );
});

function mcpTool(
  input: Partial<WorkspaceMcpToolRecord> = {},
): WorkspaceMcpToolRecord {
  return {
    id: "mcp_tool_read",
    teamId: "team_1",
    workspaceId: "workspace_1",
    installId: "mcp_install_1",
    serverToolName: "read_repo",
    normalizedToolName: "mcp__github__read_repo",
    title: "Read repo",
    description: "Read GitHub repository information",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: true,
    },
    outputSchema: null,
    annotations: {},
    risk: "read",
    enabled: true,
    lastDiscoveredHash: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function mcpInstall(
  input: Partial<WorkspaceMcpInstallRecord> = {},
): WorkspaceMcpInstallRecord {
  const id = input.id ?? "mcp_install_1";
  const tools = input.tools ?? [
    mcpTool({
      installId: id,
      normalizedToolName: "mcp__github__read_repo",
    }),
  ];
  return {
    id,
    teamId: "team_1",
    workspaceId: "workspace_1",
    source: "market",
    marketIdentifier: "github",
    marketVersion: "1.0.0",
    name: "GitHub",
    summary: "GitHub MCP",
    transport: "streamable_http",
    endpointUrl: "https://mcp.example.com/mcp",
    status: "active",
    official: true,
    verified: true,
    desktopOnly: false,
    webExecutable: true,
    authType: "none",
    credentialStatus: "not_required",
    enabled: true,
    manifestJson: {},
    signature: null,
    signingKeyId: null,
    lastTestedAt: null,
    lastError: null,
    createdBy: "user_1",
    createdAt: NOW,
    updatedAt: NOW,
    tools,
    ...input,
  };
}

function actionRun(
  input: Partial<McpActionRunRecord> = {},
): McpActionRunRecord {
  return {
    id: "mcp_action_1",
    teamId: "team_1",
    workspaceId: "workspace_1",
    installId: "mcp_install_1",
    toolId: "mcp_tool_read",
    serverToolName: "read_repo",
    normalizedToolName: "mcp__github__read_repo",
    risk: "read",
    status: "running",
    requestJson: {},
    requestPreview: "Read MCP call: GitHub.read_repo",
    resultJson: {},
    approvedBy: null,
    executedBy: null,
    idempotencyKey: "call_1",
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function toolRun(input: Partial<McpToolRunRecord> = {}): McpToolRunRecord {
  return {
    id: "mcp_tool_run_1",
    teamId: "team_1",
    workspaceId: "workspace_1",
    threadId: "thread_1",
    runId: "run_1",
    toolCallId: "call_1",
    installId: "mcp_install_1",
    toolId: "mcp_tool_read",
    actionRunId: "mcp_action_1",
    serverToolName: "read_repo",
    normalizedToolName: "mcp__github__read_repo",
    risk: "read",
    status: "running",
    redactedInput: {},
    redactedOutput: {},
    latencyMs: null,
    errorCode: null,
    errorMessage: null,
    createdBy: "user_1",
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

function originalTool(input: {
  name: string;
  output?: unknown;
  invoke?: ReturnType<typeof vi.fn>;
}) {
  const invoke = input.invoke ?? vi.fn(async () => input.output ?? "ok");
  return {
    name: input.name,
    description: `${input.name} description`,
    schema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: true,
    },
    invoke,
  } as unknown as DynamicStructuredTool;
}

function serviceInput(input: {
  installIds: string[];
  toolIds?: string[];
}) {
  return {
    workspaceId: "workspace_1",
    userId: "user_1",
    threadId: "thread_1",
    runId: "run_1",
    installIds: input.installIds,
    toolIds: input.toolIds,
  };
}

function resetMcpServiceMocks() {
  vi.clearAllMocks();
  toolsByInstallId = new Map();
  clientCloseMocks = [];
  mocks.requireMcpWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
    membership: { role: "editor" },
  });
  mocks.findWorkspaceMcpCredential.mockResolvedValue(null);
  mocks.createLangChainMcpClient.mockImplementation(
    ({ install }: { install: WorkspaceMcpInstallRecord }) => {
      const close = vi.fn(async () => undefined);
      clientCloseMocks.push(close);
      return {
        close,
        getTools: vi.fn(async () => toolsByInstallId.get(install.id) ?? []),
      };
    },
  );
  mocks.createMcpActionRun.mockImplementation(async (input) =>
    actionRun({
      id: "mcp_action_1",
      installId: input.installId,
      toolId: input.toolId,
      serverToolName: input.serverToolName,
      normalizedToolName: input.normalizedToolName,
      risk: input.risk,
      status: input.status,
      requestJson: input.requestJson,
      requestPreview: input.requestPreview,
      idempotencyKey: input.idempotencyKey,
    }),
  );
  mocks.createMcpToolRun.mockImplementation(async (input) =>
    toolRun({
      installId: input.installId,
      toolId: input.toolId,
      actionRunId: input.actionRunId,
      serverToolName: input.serverToolName,
      normalizedToolName: input.normalizedToolName,
      risk: input.risk,
      status: input.status,
      redactedInput: input.redactedInput,
      createdBy: input.createdBy,
      threadId: input.threadId,
      runId: input.runId,
      toolCallId: input.toolCallId,
    }),
  );
  mocks.updateMcpActionRun.mockImplementation(async (input) =>
    actionRun({ id: input.actionRunId, status: input.status ?? "running" }),
  );
  mocks.updateMcpToolRun.mockImplementation(async (input) =>
    toolRun({ id: input.toolRunId, status: input.status }),
  );
}

test("buildLangChainToolsForTurn only loads active web-executable installs", async () => {
  resetMcpServiceMocks();
  const active = mcpInstall({ id: "active" });
  const disabled = mcpInstall({ id: "disabled", enabled: false });
  const desktopOnly = mcpInstall({ id: "desktop", desktopOnly: true });
  const stdio = mcpInstall({ id: "stdio", transport: "stdio" });
  const webDisabled = mcpInstall({ id: "web_disabled", webExecutable: false });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([
    active,
    disabled,
    desktopOnly,
    stdio,
    webDisabled,
  ]);
  toolsByInstallId.set(active.id, [
    originalTool({ name: "mcp__github__read_repo" }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({
      installIds: [
        active.id,
        disabled.id,
        desktopOnly.id,
        stdio.id,
        webDisabled.id,
      ],
    }),
  );

  assert.deepEqual(
    mocks.createLangChainMcpClient.mock.calls.map(
      ([input]) => input.install.id,
    ),
    ["active"],
  );
  assert.equal(runtime.tools.length, 1);
  await runtime.close();
  assert.equal(clientCloseMocks[0]?.mock.calls.length, 1);
});

test("deleteInstall removes a workspace MCP install with manage permission", async () => {
  resetMcpServiceMocks();
  mocks.deleteWorkspaceMcpInstall.mockResolvedValue(true);

  const result = await new McpService().deleteInstall({
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: "mcp_install_1",
  });

  assert.deepEqual(mocks.requireMcpWorkspace.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    permission: "mcp.manage",
  });
  assert.deepEqual(mocks.deleteWorkspaceMcpInstall.mock.calls[0]?.[0], {
    teamId: "team_1",
    workspaceId: "workspace_1",
    installId: "mcp_install_1",
  });
  assert.deepEqual(result, {
    deleted: true,
    installId: "mcp_install_1",
  });
});

test("deleteInstall returns a not-found MCP error for missing installs", async () => {
  resetMcpServiceMocks();
  mocks.deleteWorkspaceMcpInstall.mockResolvedValue(false);

  await assert.rejects(
    () =>
      new McpService().deleteInstall({
        workspaceId: "workspace_1",
        userId: "user_1",
        installId: "missing_install",
      }),
    (error: unknown) =>
      error instanceof McpError && error.code === "MCP_INSTALL_NOT_FOUND",
  );
});

test("read MCP tools execute immediately and persist redacted audit records", async () => {
  resetMcpServiceMocks();
  const readTool = mcpTool({
    id: "tool_read",
    serverToolName: "read_repo",
    normalizedToolName: "mcp__github__read_repo",
    risk: "read",
  });
  const install = mcpInstall({ tools: [readTool] });
  const invoke = vi.fn(async () => ({
    accessToken: "remote-secret",
    value: "repository info",
  }));
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__read_repo", invoke }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );
  assert.deepEqual(runtime.interruptOn, {});

  const output = await runtime.tools[0]?.invoke(
    { apiKey: "input-secret", query: "sourceweft" },
    { configurable: { tool_call_id: "call_1" } },
  );

  assert.deepEqual(output, {
    accessToken: "remote-secret",
    value: "repository info",
  });
  assert.equal(invoke.mock.calls.length, 1);
  assert.deepEqual(mocks.createMcpActionRun.mock.calls[0]?.[0], {
    teamId: "team_1",
    workspaceId: "workspace_1",
    installId: install.id,
    toolId: "tool_read",
    serverToolName: "read_repo",
    normalizedToolName: "mcp__github__read_repo",
    risk: "read",
    status: "running",
    requestJson: { apiKey: "[REDACTED]", query: "sourceweft" },
    requestPreview: "Read MCP call: GitHub.read_repo with apiKey, query",
    idempotencyKey: "call_1",
  });
  assert.deepEqual(mocks.createMcpToolRun.mock.calls[0]?.[0], {
    teamId: "team_1",
    workspaceId: "workspace_1",
    threadId: "thread_1",
    runId: "run_1",
    toolCallId: "call_1",
    installId: install.id,
    toolId: "tool_read",
    actionRunId: "mcp_action_1",
    serverToolName: "read_repo",
    normalizedToolName: "mcp__github__read_repo",
    risk: "read",
    status: "running",
    redactedInput: { apiKey: "[REDACTED]", query: "sourceweft" },
    createdBy: "user_1",
  });
  const toolRunUpdate = mocks.updateMcpToolRun.mock.calls.at(-1)?.[0];
  assert.equal(typeof toolRunUpdate?.latencyMs, "number");
  assert.deepEqual(toolRunUpdate, {
    teamId: "team_1",
    workspaceId: "workspace_1",
    toolRunId: "mcp_tool_run_1",
    status: "succeeded",
    redactedOutput: {
      accessToken: "[REDACTED]",
      value: "repository info",
    },
    latencyMs: toolRunUpdate?.latencyMs,
  });
  assert.deepEqual(mocks.updateMcpActionRun.mock.calls.at(-1)?.[0], {
    teamId: "team_1",
    workspaceId: "workspace_1",
    actionRunId: "mcp_action_1",
    status: "succeeded",
    resultJson: {
      accessToken: "[REDACTED]",
      value: "repository info",
    },
    executedBy: "user_1",
  });
});

test("high-risk MCP tools are exposed with interrupt config and blocked before approval", async () => {
  resetMcpServiceMocks();
  const writeTool = mcpTool({
    id: "tool_write",
    serverToolName: "create_issue",
    normalizedToolName: "mcp__github__create_issue",
    risk: "write",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  });
  const install = mcpInstall({ tools: [writeTool] });
  const invoke = vi.fn(async () => "created");
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__create_issue", invoke }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );

  assert.deepEqual(runtime.interruptOn.mcp__github__create_issue, {
    allowedDecisions: ["approve", "edit", "reject"],
    description:
      "GitHub MCP tool create_issue may perform external write actions. Review before execution.",
    argsSchema: writeTool.inputSchema,
  });
  const wrappedTool = runtime.tools[0];
  assert.ok(wrappedTool);
  await assert.rejects(
    () =>
      wrappedTool.invoke(
        { title: "Ship MCP" },
        { configurable: { tool_call_id: "call_write" } },
      ),
    (error: unknown) =>
      error instanceof McpError && error.code === "MCP_APPROVAL_REQUIRED",
  );
  assert.equal(invoke.mock.calls.length, 0);
  assert.equal(mocks.createMcpToolRun.mock.calls.length, 0);
  assert.equal(mocks.createMcpActionRun.mock.calls[0]?.[0].status, "proposed");
});

test("approved high-risk MCP action resumes execution by idempotency key", async () => {
  resetMcpServiceMocks();
  const writeTool = mcpTool({
    id: "tool_write",
    serverToolName: "create_issue",
    normalizedToolName: "mcp__github__create_issue",
    risk: "write",
  });
  const install = mcpInstall({ tools: [writeTool] });
  const invoke = vi.fn(async () => ({ url: "https://example.com/issue/1" }));
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  mocks.createMcpActionRun.mockImplementation(async (input) =>
    actionRun({
      id: "mcp_action_approved",
      installId: input.installId,
      toolId: input.toolId,
      serverToolName: input.serverToolName,
      normalizedToolName: input.normalizedToolName,
      risk: input.risk,
      status: "approved",
      requestJson: input.requestJson,
      requestPreview: input.requestPreview,
      idempotencyKey: input.idempotencyKey,
    }),
  );
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__create_issue", invoke }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );
  const output = await runtime.tools[0]?.invoke(
    { title: "Ship MCP" },
    { configurable: { tool_call_id: "call_write" } },
  );

  assert.deepEqual(output, { url: "https://example.com/issue/1" });
  assert.equal(invoke.mock.calls.length, 1);
  assert.equal(mocks.createMcpToolRun.mock.calls[0]?.[0].actionRunId, "mcp_action_approved");
  assert.equal(mocks.updateMcpActionRun.mock.calls[0]?.[0].status, "running");
  assert.equal(mocks.updateMcpActionRun.mock.calls.at(-1)?.[0].status, "succeeded");
});

test("createApprovalForInterruptedTool returns redacted MCP confirmation payload", async () => {
  resetMcpServiceMocks();
  const writeTool = mcpTool({
    id: "tool_write",
    serverToolName: "create_issue",
    normalizedToolName: "mcp__github__create_issue",
    title: "Create issue",
    description: "Create a GitHub issue",
    risk: "write",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  });
  const install = mcpInstall({ tools: [writeTool] });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  mocks.createMcpActionRun.mockImplementation(async (input) =>
    actionRun({
      id: "mcp_action_confirmation",
      installId: input.installId,
      toolId: input.toolId,
      serverToolName: input.serverToolName,
      normalizedToolName: input.normalizedToolName,
      risk: input.risk,
      status: "proposed",
      requestJson: input.requestJson,
      requestPreview: input.requestPreview,
      idempotencyKey: input.idempotencyKey,
    }),
  );

  const confirmation = await new McpService().createApprovalForInterruptedTool({
    workspaceId: "workspace_1",
    userId: "user_1",
    toolName: "mcp__github__create_issue",
    args: { title: "Ship MCP", apiKey: "secret" },
    toolCallId: "call_write",
  });

  assert.deepEqual(mocks.createMcpActionRun.mock.calls[0]?.[0].requestJson, {
    title: "Ship MCP",
    apiKey: "[REDACTED]",
  });
  assert.deepEqual(confirmation, {
    type: "tool_confirmation_request",
    schemaVersion: 1,
    id: "mcp_action_confirmation",
    domain: "mcp",
    subject: {
      label: "GitHub",
      provider: "mcp",
      externalUri: "https://mcp.example.com/mcp",
    },
    action: {
      type: "create_issue",
      toolName: "mcp__github__create_issue",
      label: "Create issue",
      description: "Create a GitHub issue",
      riskLevel: "high",
      status: "proposed",
      requiresApproval: true,
    },
    preview: {
      title: "Write MCP call: GitHub.create_issue with title, apiKey",
      summary: "Create a GitHub issue",
      requestJson: {
        title: "Ship MCP",
        apiKey: "[REDACTED]",
      },
      target: {
        type: "mcp_server",
        label: "GitHub",
        id: "mcp_install_1",
        externalUri: "https://mcp.example.com/mcp",
      },
    },
    editableArgs: {
      value: {
        title: "Ship MCP",
        apiKey: "[REDACTED]",
      },
      schema: writeTool.inputSchema,
    },
    decisionOptions: [
      {
        decision: "reject",
        label: "Reject",
        description: "Do not run this MCP tool call.",
      },
      {
        decision: "approve",
        label: "Approve",
        description: "Run this MCP tool call once.",
      },
    ],
    execution: {
      providerStatus: "not_executed",
      executor: {
        kind: "mcp_action_run",
        actionRunId: "mcp_action_confirmation",
      },
      sourceweft: { toolCallId: "call_write" },
    },
    status: "proposed",
    userMessage:
      "This MCP tool call is waiting for confirmation in SourceWeft. The remote MCP server has not been called yet.",
  });
});

test("respondToApproval rejects MCP confirmations without executing", async () => {
  resetMcpServiceMocks();
  const writeTool = mcpTool({
    id: "tool_write",
    serverToolName: "create_issue",
    normalizedToolName: "mcp__github__create_issue",
    title: "Create issue",
    risk: "write",
  });
  const install = mcpInstall({ tools: [writeTool] });
  mocks.findMcpActionRun.mockResolvedValue(
    actionRun({
      id: "mcp_action_reject",
      installId: install.id,
      toolId: writeTool.id,
      serverToolName: writeTool.serverToolName,
      normalizedToolName: writeTool.normalizedToolName,
      risk: "write",
      status: "proposed",
      requestJson: { title: "Nope" },
      requestPreview: "Write MCP call: GitHub.create_issue with title",
    }),
  );
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  mocks.updateMcpActionRun.mockImplementation(async (input) =>
    actionRun({
      id: input.actionRunId,
      installId: install.id,
      toolId: writeTool.id,
      serverToolName: writeTool.serverToolName,
      normalizedToolName: writeTool.normalizedToolName,
      risk: "write",
      status: input.status,
      requestJson: { title: "Nope" },
      requestPreview: "Write MCP call: GitHub.create_issue with title",
      approvedBy: input.approvedBy,
      errorMessage: input.errorMessage,
    }),
  );

  const result = await new McpService().respondToApproval({
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "mcp_action_reject",
    decision: "reject",
    note: "Not this time",
  });

  assert.deepEqual(mocks.updateMcpActionRun.mock.calls[0]?.[0], {
    teamId: "team_1",
    workspaceId: "workspace_1",
    actionRunId: "mcp_action_reject",
    status: "rejected",
    approvedBy: "user_1",
    errorMessage: "Not this time",
  });
  assert.deepEqual(result.resume, {
    decisions: [
      {
        type: "reject",
        message: "Not this time",
      },
    ],
  });
  assert.equal(result.confirmation.status, "rejected");
  assert.equal(result.confirmation.execution.providerStatus, "not_executed");
});

test("respondToApproval rejects stale MCP confirmation actions", async () => {
  resetMcpServiceMocks();
  const writeTool = mcpTool({
    id: "tool_write",
    serverToolName: "create_issue",
    normalizedToolName: "mcp__github__create_issue",
    title: "Create issue",
    risk: "write",
  });
  const install = mcpInstall({ tools: [writeTool] });
  mocks.findMcpActionRun.mockResolvedValue(
    actionRun({
      id: "mcp_action_done",
      installId: install.id,
      toolId: writeTool.id,
      serverToolName: writeTool.serverToolName,
      normalizedToolName: writeTool.normalizedToolName,
      risk: "write",
      status: "succeeded",
    }),
  );

  await assert.rejects(
    new McpService().respondToApproval({
      workspaceId: "workspace_1",
      userId: "user_1",
      confirmationId: "mcp_action_done",
      decision: "approve",
    }),
    (error: unknown) => {
      assert.equal(error instanceof McpError, true);
      assert.equal(
        (error as McpError).code,
        "MCP_CONFIRMATION_INVALID_STATE",
      );
      return true;
    },
  );

  assert.equal(mocks.findWorkspaceMcpInstall.mock.calls.length, 0);
  assert.equal(mocks.updateMcpActionRun.mock.calls.length, 0);
});

test("respondToApproval approves MCP confirmations with edited args", async () => {
  resetMcpServiceMocks();
  const writeTool = mcpTool({
    id: "tool_write",
    serverToolName: "create_issue",
    normalizedToolName: "mcp__github__create_issue",
    title: "Create issue",
    risk: "write",
  });
  const install = mcpInstall({ tools: [writeTool] });
  mocks.findMcpActionRun.mockResolvedValue(
    actionRun({
      id: "mcp_action_approve",
      installId: install.id,
      toolId: writeTool.id,
      serverToolName: writeTool.serverToolName,
      normalizedToolName: writeTool.normalizedToolName,
      risk: "write",
      status: "proposed",
      requestJson: { title: "Original" },
      requestPreview: "Write MCP call: GitHub.create_issue with title",
    }),
  );
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  mocks.updateMcpActionRun.mockImplementation(async (input) =>
    actionRun({
      id: input.actionRunId,
      installId: install.id,
      toolId: writeTool.id,
      serverToolName: writeTool.serverToolName,
      normalizedToolName: writeTool.normalizedToolName,
      risk: "write",
      status: input.status,
      requestJson: input.requestJson,
      requestPreview: input.requestPreview,
      approvedBy: input.approvedBy,
    }),
  );

  const result = await new McpService().respondToApproval({
    workspaceId: "workspace_1",
    userId: "user_1",
    confirmationId: "mcp_action_approve",
    decision: "approve",
    editedArgs: { title: "Edited" },
  });

  assert.deepEqual(mocks.updateMcpActionRun.mock.calls[0]?.[0], {
    teamId: "team_1",
    workspaceId: "workspace_1",
    actionRunId: "mcp_action_approve",
    status: "approved",
    requestJson: { title: "Edited" },
    requestPreview: "Write MCP call: GitHub.create_issue with title",
    approvedBy: "user_1",
  });
  assert.deepEqual(result.resume, {
    decisions: [{ type: "approve" }],
  });
  assert.equal(result.confirmation.status, "approved");
  assert.deepEqual(result.confirmation.preview.requestJson, {
    title: "Edited",
  });
});
