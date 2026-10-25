import { langChainMcpToolName } from "./langchain-client";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  deleteMcpOAuthSession: vi.fn(),
  encryptSecret: vi.fn(),
  findMcpActionRun: vi.fn(),
  findWorkspaceMcpCredential: vi.fn(),
  findWorkspaceMcpInstall: vi.fn(),
  findWorkspaceMcpInstallByMarketIdentifier: vi.fn(),
  getMcpManifest: vi.fn(),
  listMcpActionRuns: vi.fn(),
  listMcpToolRuns: vi.fn(),
  listWorkspaceMcpInstalls: vi.fn(),
  logInfo: vi.fn(),
  recordMemberObservedTools: vi.fn(),
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
    endpointAddressChecksEnabled: true,
    market: { enabled: true },
    modelGatewayEncryptionSecret: "test-encryption-secret",
    mcpAllowedInternalOrigins: ["https://mcp.internal"],
    mcpOAuth: {
      redirectUrl: "https://test.local/v1/mcp/oauth/callback",
      clientName: "SourceWeft",
      clients: {},
    },
  },
}));

vi.mock("../market/tool-revisions/member-observed", () => ({
  recordMemberObservedTools: mocks.recordMemberObservedTools,
}));

vi.mock("./oauth-repository", () => ({
  getMcpOAuthStatus: vi.fn(async () => ({ connected: false, issuer: null })),
  createDbMcpOAuthStore: vi.fn(() => ({})),
  deleteMcpOAuthSession: mocks.deleteMcpOAuthSession,
  listUserConnectedOAuthInstallIds: vi.fn(async () => new Set<string>()),
}));

// Real decryption (via the mocked master-secret decryptSecret); encryption is
// stubbed so credential saves don't need a team data-key row.
vi.mock("../../shared/team-secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/team-secrets")>()),
  encryptTeamSecret: vi.fn(async (plainText: string) => `enc:${plainText}`),
}));

vi.mock("../../shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../shared/secrets", () => ({
  decryptSecret: mocks.decryptSecret,
  encryptSecret: mocks.encryptSecret,
}));

// Keep the real security helpers, but stub the endpoint SSRF check so tests
// don't perform live DNS resolution against fixture hostnames.
vi.mock("./security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./security")>();
  return {
    ...actual,
    assertSafeMcpEndpoint: vi.fn(async (value: string) => value),
  };
});

vi.mock("./langchain-client", () => ({
  createLangChainMcpClient: mocks.createLangChainMcpClient,
  langChainMcpServerKey: (install: {
    marketIdentifier: string | null;
    id: string;
  }) =>
    (install.marketIdentifier ?? install.id).replace(/[^a-zA-Z0-9_-]/g, "_"),
  langChainMcpToolName: (input: {
    install: { marketIdentifier: string | null; id: string };
    serverToolName: string;
  }) =>
    `mcp__${(input.install.marketIdentifier ?? input.install.id).replace(/[^a-zA-Z0-9_-]/g, "_")}__${input.serverToolName}`,
}));

vi.mock("./market-service", () => ({
  marketService: {
    getMcp: vi.fn(),
    getMcpManifest: mocks.getMcpManifest,
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
  listUserCredentialInstallIds: vi.fn(async () => new Set<string>()),
  listWorkspaceMcpInstalls: mocks.listWorkspaceMcpInstalls,
  setWorkspaceMcpToolsEnabled: mocks.setWorkspaceMcpToolsEnabled,
  updateMcpActionRun: mocks.updateMcpActionRun,
  updateMcpToolRun: mocks.updateMcpToolRun,
  updateWorkspaceMcpInstall: mocks.updateWorkspaceMcpInstall,
  upsertWorkspaceMcpCredential: mocks.upsertWorkspaceMcpCredential,
  upsertWorkspaceMcpTools: mocks.upsertWorkspaceMcpTools,
}));

import {
  MCP_TOOL_APPROVED_NOTE,
  McpService,
  mcpEndpointRequiresAuth,
  stripLangChainMcpToolPrefix,
  withMcpApprovalNote,
} from "./service";
import { assertSafeMcpEndpoint } from "./security";
import { config } from "../../shared/config";
import {
  getMcpOAuthStatus,
  listUserConnectedOAuthInstallIds,
} from "./oauth-repository";
import { listUserCredentialInstallIds } from "./repository";

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
  metadata?: Record<string, unknown>;
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
    metadata: input.metadata,
    invoke,
  } as unknown as DynamicStructuredTool;
}

function serviceInput(input: {
  installIds: string[];
  toolIds?: string[];
  mcpActions?: Array<{
    actionRunId: string;
    toolName: string;
    requestJson: Record<string, unknown>;
  }>;
}) {
  return {
    workspaceId: "workspace_1",
    userId: "user_1",
    threadId: "thread_1",
    runId: "run_1",
    installIds: input.installIds,
    toolIds: input.toolIds,
    ...(input.mcpActions ? { mcpActions: input.mcpActions } : {}),
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

test("MCP auth probing fails installation preparation on network errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error("connection refused");
  });
  try {
    await assert.rejects(
      () => mcpEndpointRequiresAuth("https://mcp.example.com/mcp"),
      (error) =>
        error instanceof McpError && error.code === "MCP_AUTH_PROBE_FAILED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP auth probing treats a same-origin redirect as not requiring auth", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(null, { status: 307, headers: { location: "/mcp/" } }),
  );
  try {
    assert.equal(
      await mcpEndpointRequiresAuth("https://mcp.example.com/mcp"),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP auth probing blocks a cross-origin redirect", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://login.example.net/sso" },
      }),
  );
  try {
    await assert.rejects(
      () => mcpEndpointRequiresAuth("https://mcp.example.com/mcp"),
      (error) =>
        error instanceof McpError && error.code === "MCP_ENDPOINT_BLOCKED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildLangChainToolsForTurn rejects an unavailable selected install", async () => {
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

  await assert.rejects(
    () =>
      new McpService().buildLangChainToolsForTurn(
        serviceInput({ installIds: [active.id, disabled.id] }),
      ),
    (error) =>
      error instanceof McpError && error.code === "MCP_INSTALL_UNAVAILABLE",
  );

  assert.equal(mocks.createLangChainMcpClient.mock.calls.length, 0);
});

test("buildLangChainToolsForTurn fails the turn and closes clients when discovery fails", async () => {
  resetMcpServiceMocks();
  const healthy = mcpInstall({ id: "healthy" });
  const broken = mcpInstall({ id: "broken", marketIdentifier: "broken" });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([healthy, broken]);
  toolsByInstallId.set(healthy.id, [
    originalTool({ name: "mcp__github__read_repo" }),
  ]);
  // Override the client factory so the broken install throws on getTools.
  mocks.createLangChainMcpClient.mockImplementation(
    ({ install }: { install: WorkspaceMcpInstallRecord }) => {
      const close = vi.fn(async () => undefined);
      clientCloseMocks.push(close);
      return {
        close,
        getTools: vi.fn(async () => {
          if (install.id === "broken") {
            throw new Error("connection refused");
          }
          return toolsByInstallId.get(install.id) ?? [];
        }),
      };
    },
  );

  await assert.rejects(
    () =>
      new McpService().buildLangChainToolsForTurn(
        serviceInput({ installIds: [healthy.id, broken.id] }),
      ),
    (error) =>
      error instanceof McpError && error.code === "MCP_CONNECTION_FAILED",
  );

  // Both the already-open healthy client and the failing client are closed.
  assert.equal(clientCloseMocks[0]?.mock.calls.length, 1);
  assert.equal(clientCloseMocks[1]?.mock.calls.length, 1);
});

test("buildLangChainToolsForTurn rejects unregistered tools exposed by a selected server", async () => {
  resetMcpServiceMocks();
  const install = mcpInstall({ id: "mcp_install_1" });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__read_repo" }),
    originalTool({ name: "mcp__github__new_unregistered_tool" }),
  ]);

  await assert.rejects(
    () =>
      new McpService().buildLangChainToolsForTurn(
        serviceInput({ installIds: [install.id] }),
      ),
    (error) =>
      error instanceof McpError && error.code === "MCP_TOOL_DISCOVERY_MISMATCH",
  );
  assert.equal(clientCloseMocks[0]?.mock.calls.length, 1);
});

test("buildLangChainToolsForTurn does not bind tools disabled per-tool", async () => {
  resetMcpServiceMocks();
  const install = mcpInstall({
    id: "mcp_install_1",
    tools: [
      mcpTool({ id: "t_read", serverToolName: "read_repo", enabled: true }),
      mcpTool({ id: "t_write", serverToolName: "write_repo", enabled: false }),
    ],
  });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__read_repo" }),
    originalTool({ name: "mcp__github__write_repo" }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );

  // Only the enabled tool is bound even though the server exposes both.
  assert.equal(runtime.tools.length, 1);
  await runtime.close();
});

test("MCP binding keeps readable metadata separate from provider-safe execution names", async () => {
  resetMcpServiceMocks();
  const install = mcpInstall({
    id: "mcp_display",
    name: "AnyCrawl",
    tools: [
      mcpTool({
        id: "tool_display",
        serverToolName: "search_full_articles",
        title: "搜索完整文章 Search full articles",
      }),
    ],
  });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  toolsByInstallId.set(install.id, [
    originalTool({
      name: "mcp__github__search_full_articles",
      metadata: { annotations: { readOnlyHint: true } },
    }),
  ]);
  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );
  assert.equal(
    runtime.tools[0]?.name,
    langChainMcpToolName({ install, serverToolName: "search_full_articles" }),
  );
  assert.deepEqual(runtime.tools[0]?.metadata?.sourceweftMcpDisplay, {
    serverName: "AnyCrawl",
    toolName: "搜索完整文章 Search full articles",
  });
  assert.deepEqual(runtime.tools[0]?.metadata?.annotations, {
    readOnlyHint: true,
  });
  await runtime.close();
});

test("buildLangChainToolsForTurn forces approval for an unverified install's read tool", async () => {
  resetMcpServiceMocks();
  const install = mcpInstall({
    id: "mcp_install_1",
    verified: false,
    tools: [
      mcpTool({
        id: "t_read",
        serverToolName: "read_repo",
        normalizedToolName: "mcp__github__read_repo",
        risk: "read",
        enabled: true,
      }),
    ],
  });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__read_repo" }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );

  // The manifest declares this tool "read" (low risk), but an unverified
  // install can't be trusted to self-assert — it is gated for approval anyway.
  assert.ok(runtime.interruptOn["mcp__github__read_repo"]);
  await runtime.close();
});

test("buildLangChainToolsForTurn does not gate a verified install's read tool", async () => {
  resetMcpServiceMocks();
  const install = mcpInstall({
    id: "mcp_install_1",
    verified: true,
    tools: [
      mcpTool({
        id: "t_read",
        serverToolName: "read_repo",
        normalizedToolName: "mcp__github__read_repo",
        risk: "read",
        enabled: true,
      }),
    ],
  });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__read_repo" }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );

  assert.deepEqual(runtime.interruptOn, {});
  await runtime.close();
});

test("buildLangChainToolsForTurn resolves the invoking user's own static credential", async () => {
  resetMcpServiceMocks();
  const install = mcpInstall({ id: "mcp_install_1", authType: "bearer" });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "bearer",
    encryptedSecret: "encrypted-user-token",
  });
  mocks.decryptSecret.mockReturnValue("user-token");
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__read_repo" }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );

  // Per-user credentials: the lookup is scoped to the turn's user, never a
  // workspace-shared credential.
  assert.equal(
    mocks.findWorkspaceMcpCredential.mock.calls[0]?.[0]?.userId,
    "user_1",
  );
  await runtime.close();
});

test("createApprovalForInterruptedTool resolves camelCase LangChain tool names", async () => {
  resetMcpServiceMocks();
  const install = mcpInstall({
    id: "mcp_install_1",
    tools: [
      mcpTool({
        id: "t_create",
        serverToolName: "createIssue",
        normalizedToolName: "mcp__github__createissue",
        risk: "write",
      }),
    ],
  });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);

  const payload = await new McpService().createApprovalForInterruptedTool({
    workspaceId: "workspace_1",
    userId: "user_1",
    // The interrupt carries the raw LangChain name, not the normalized slug.
    toolName: "mcp__github__createIssue",
    args: { title: "bug" },
    toolCallId: "call_42",
  });

  // Previously this returned null (normalized-name mismatch) and hard-failed
  // the turn; now it resolves the tool and creates an approval.
  assert.notEqual(payload, null);
  assert.equal(
    mocks.createMcpActionRun.mock.calls[0]?.[0]?.serverToolName,
    "createIssue",
  );
});

test("testInstall preserves existing tool metadata instead of clobbering it", async () => {
  resetMcpServiceMocks();
  const install = mcpInstall({ id: "mcp_install_1" });
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  mocks.upsertWorkspaceMcpTools.mockResolvedValue(undefined);
  mocks.updateWorkspaceMcpInstall.mockResolvedValue(install);
  toolsByInstallId.set(install.id, [
    originalTool({
      name: "mcp__github__read_repo",
      metadata: {
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
    }),
  ]);
  mocks.createLangChainMcpClient.mockImplementation(
    ({ install: target }: { install: WorkspaceMcpInstallRecord }) => {
      const close = vi.fn(async () => undefined);
      clientCloseMocks.push(close);
      return {
        close,
        getTools: vi.fn(async () => toolsByInstallId.get(target.id) ?? []),
      };
    },
  );

  await new McpService().testInstall({
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: install.id,
  });

  assert.equal(
    mocks.upsertWorkspaceMcpTools.mock.calls[0]?.[0]?.preserveExistingMetadata,
    true,
  );
  const discovered =
    mocks.upsertWorkspaceMcpTools.mock.calls[0]?.[0]?.tools?.[0];
  assert.deepEqual(discovered?.inputSchema, {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: true,
  });
  assert.equal(discovered?.normalizedToolName, "mcp__github__read_repo");
  assert.deepEqual(discovered?.annotations, {
    readOnlyHint: true,
    idempotentHint: true,
  });
});

test("MCP prechecks receive the configured address mode and deployment origins", async () => {
  const originalChecks = config.endpointAddressChecksEnabled;
  const endpointCheck = vi.mocked(assertSafeMcpEndpoint);
  try {
    for (const enforceAddressChecks of [false, true]) {
      config.endpointAddressChecksEnabled = enforceAddressChecks;
      resetMcpServiceMocks();
      const install = mcpInstall({ id: `mcp_${enforceAddressChecks}` });
      mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
      mocks.upsertWorkspaceMcpTools.mockResolvedValue(undefined);
      mocks.updateWorkspaceMcpInstall.mockResolvedValue(install);

      await new McpService().testInstall({
        workspaceId: "workspace_1",
        userId: "user_1",
        installId: install.id,
      });

      assert.deepEqual(endpointCheck.mock.calls[0]?.[1], {
        enforceAddressChecks,
        allowedInternalOrigins: ["https://mcp.internal"],
      });
    }
  } finally {
    config.endpointAddressChecksEnabled = originalChecks;
  }
});

test("all backend dev entrypoints explicitly select development runtime mode", () => {
  const packageJson = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../package.json", import.meta.url)),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };

  for (const script of ["dev:api", "dev:worker", "dev:scheduler"]) {
    assert.match(
      packageJson.scripts?.[script] ?? "",
      /^NODE_ENV=development\s/,
    );
  }
});

test("installMarketMcp refuses to downgrade an already-installed newer version", async () => {
  resetMcpServiceMocks();
  mocks.getMcpManifest.mockResolvedValue({
    manifest: {
      schemaVersion: 1,
      identifier: "github",
      name: "GitHub",
      summary: "GitHub MCP",
      version: "1.0.0",
      categories: ["developer-tools"],
      transport: "streamable_http",
      endpointUrl: "https://mcp.example.com/mcp",
      auth: { required: false, type: "none", allowedHeaderNames: [] },
      tools: [],
      official: true,
      verified: false,
      desktopOnly: false,
      webExecutable: true,
    },
    version: { provenanceJson: {} },
  });
  // A newer version (2.0.0) is already installed.
  mocks.findWorkspaceMcpInstallByMarketIdentifier.mockResolvedValue(
    mcpInstall({ id: "mcp_install_1", marketVersion: "2.0.0" }),
  );

  await assert.rejects(
    () =>
      new McpService().installMarketMcp({
        workspaceId: "workspace_1",
        userId: "user_1",
        identifier: "github",
      }),
    (error) =>
      error instanceof McpError &&
      error.code === "MCP_MARKET_VERSION_DOWNGRADE",
  );
  // The downgrade is rejected before any install write happens.
  assert.equal(mocks.createOrUpdateMarketMcpInstall.mock.calls.length, 0);
});

test("installMarketMcp logs mcp.installed with truncated ids once the row is written", async () => {
  resetMcpServiceMocks();
  mocks.requireMcpWorkspace.mockResolvedValue({
    workspace: {
      id: "workspace_0199cd4f7b1e7c3a",
      organizationId: "team_0199cd4f7b1e7c3a9f0e",
    },
    membership: { role: "editor" },
  });
  // An OAuth manifest skips the live auth probe that a "none" manifest runs.
  mocks.getMcpManifest.mockResolvedValue({
    manifest: {
      schemaVersion: 1,
      identifier: "github",
      name: "GitHub",
      summary: "GitHub MCP",
      version: "1.2.0",
      categories: ["developer-tools"],
      transport: "streamable_http",
      endpointUrl: "https://mcp.example.com/mcp?token=should-not-be-logged",
      auth: { required: true, type: "oauth", allowedHeaderNames: [] },
      tools: [],
      official: true,
      verified: false,
      desktopOnly: false,
      webExecutable: true,
    },
    item: { verified: false },
    version: { provenanceJson: {} },
  });
  mocks.findWorkspaceMcpInstallByMarketIdentifier.mockResolvedValue(null);
  mocks.createOrUpdateMarketMcpInstall.mockResolvedValue(
    mcpInstall({
      id: "mcp_install_2",
      marketVersion: "1.2.0",
      authType: "oauth",
      workspaceId: "workspace_0199cd4f7b1e7c3a",
      teamId: "team_0199cd4f7b1e7c3a9f0e",
    }),
  );

  const result = await new McpService().installMarketMcp({
    workspaceId: "workspace_0199cd4f7b1e7c3a",
    userId: "user_0199cd4f7b1e7c3a9f0e",
    identifier: "github",
  });

  assert.equal(result.install.id, "mcp_install_2");
  const installed = mocks.logInfo.mock.calls.filter(
    (call) => call[0] === "mcp.installed",
  );
  assert.equal(installed.length, 1);
  const fields = installed[0]?.[1] as Record<string, unknown>;
  assert.deepEqual(fields, {
    teamId: "team_019",
    workspaceId: "workspac",
    identifier: "github",
    version: "1.2.0",
  });
  const serialized = JSON.stringify(fields);
  assert.ok(
    !serialized.includes("team_0199cd4f7b1e7c3a9f0e"),
    "team id leaked",
  );
  assert.ok(!serialized.includes("user_0199cd4f"), "user id leaked");
  assert.ok(!serialized.includes("mcp.example.com"), "endpoint leaked");
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
    argsSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: true,
    },
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

test("approved high-risk MCP action resumes by args-matched ref under a different execution-time tool-call id", async () => {
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
  // The approval lives on a run keyed by the payload-derived hitl ref, resolved
  // by args — NOT by the tool-call id the tool sees at execution time.
  mocks.findMcpActionRun.mockImplementation(async ({ actionRunId }) =>
    actionRunId === "mcp_action_approved"
      ? actionRun({
          id: "mcp_action_approved",
          installId: install.id,
          toolId: "tool_write",
          serverToolName: "create_issue",
          normalizedToolName: "mcp__github__create_issue",
          risk: "write",
          status: "approved",
          requestJson: { title: "Ship MCP" },
          requestPreview: "create_issue",
          idempotencyKey: "hitl:thread_1:cp_1:0:mcp__github__create_issue",
        })
      : null,
  );
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__create_issue", invoke }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({
      installIds: [install.id],
      mcpActions: [
        {
          actionRunId: "mcp_action_approved",
          toolName: "mcp__github__create_issue",
          requestJson: { title: "Ship MCP" },
        },
      ],
    }),
  );
  // A sub-agent re-executes with a fresh tool-call id that never appeared in the
  // top-level graph; approval must still resolve.
  const output = await runtime.tools[0]?.invoke(
    { title: "Ship MCP" },
    { configurable: { tool_call_id: "call_subagent_fresh" } },
  );

  // The result tells the model the user approved the call.
  assert.deepEqual(output, {
    url: "https://example.com/issue/1",
    approval: MCP_TOOL_APPROVED_NOTE,
  });
  assert.equal(invoke.mock.calls.length, 1);
  assert.equal(
    mocks.findMcpActionRun.mock.calls[0]?.[0].actionRunId,
    "mcp_action_approved",
  );
  assert.equal(mocks.updateMcpActionRun.mock.calls[0]?.[0].status, "running");
  assert.equal(
    mocks.updateMcpActionRun.mock.calls.at(-1)?.[0].status,
    "succeeded",
  );
});

test("the approval note is added to text, content-block and object results", () => {
  assert.equal(
    withMcpApprovalNote("created"),
    `${MCP_TOOL_APPROVED_NOTE}\n\ncreated`,
  );
  assert.deepEqual(withMcpApprovalNote([{ type: "text", text: "created" }]), [
    { type: "text", text: MCP_TOOL_APPROVED_NOTE },
    { type: "text", text: "created" },
  ]);
  assert.deepEqual(withMcpApprovalNote({ id: 1 }), {
    id: 1,
    approval: MCP_TOOL_APPROVED_NOTE,
  });
});

test("MCP action ref for different args does not approve the call", async () => {
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
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__github__create_issue", invoke }),
  ]);

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({
      installIds: [install.id],
      // Approved for a DIFFERENT title — must not satisfy this call.
      mcpActions: [
        {
          actionRunId: "mcp_action_approved",
          toolName: "mcp__github__create_issue",
          requestJson: { title: "Something else" },
        },
      ],
    }),
  );
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
  assert.equal(mocks.findMcpActionRun.mock.calls.length, 0);
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
      assert.equal((error as McpError).code, "MCP_CONFIRMATION_INVALID_STATE");
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
  // Edited args must resume as an "edit" decision so the tool re-executes with
  // them; a plain approve would run the model's ORIGINAL args while the audit
  // record above says the edited ones were approved and executed.
  assert.deepEqual(result.resume, {
    decisions: [
      {
        type: "edit",
        editedAction: {
          name: "mcp__github__create_issue",
          args: { title: "Edited" },
        },
      },
    ],
  });
  assert.equal(result.confirmation.status, "approved");
  assert.deepEqual(result.confirmation.preview.requestJson, {
    title: "Edited",
  });
});

// --- Member-chosen auth method (#337) --------------------------------------

/** Arcmira-like: an OAuth server that also accepts `Authorization: Bearer`. */
function oauthOrKeyInstall(
  input: Partial<WorkspaceMcpInstallRecord> = {},
): WorkspaceMcpInstallRecord {
  return mcpInstall({
    id: "mcp_install_arcmira",
    marketIdentifier: "arcmira",
    name: "Arcmira",
    authType: "oauth",
    credentialStatus: "required",
    manifestJson: {
      auth: {
        type: "oauth",
        required: true,
        headerName: "Authorization",
        allowedHeaderNames: ["Authorization"],
        posture: "required",
        methods: [
          { type: "oauth" },
          { type: "header", name: "Authorization", scheme: "bearer" },
        ],
      },
    },
    ...input,
  });
}

/** Exa-like: open server with an optional secret header. */
function optionalKeyInstall(
  input: Partial<WorkspaceMcpInstallRecord> = {},
): WorkspaceMcpInstallRecord {
  return mcpInstall({
    id: "mcp_install_exa",
    marketIdentifier: "exa",
    name: "Exa",
    authType: "none",
    credentialStatus: "not_required",
    manifestJson: {
      auth: {
        type: "none",
        required: false,
        allowedHeaderNames: [],
        posture: "optional",
        methods: [{ type: "header", name: "x-api-key" }],
      },
    },
    ...input,
  });
}

function resetAuthMethodMocks() {
  resetMcpServiceMocks();
  vi.mocked(getMcpOAuthStatus).mockResolvedValue({
    connected: false,
    issuer: null,
  });
  vi.mocked(listUserConnectedOAuthInstallIds).mockResolvedValue(new Set());
  vi.mocked(listUserCredentialInstallIds).mockResolvedValue(new Set());
  mocks.decryptSecret.mockImplementation((cipherText: string) =>
    cipherText.replace(/^enc:/, ""),
  );
  mocks.upsertWorkspaceMcpCredential.mockResolvedValue(undefined);
  mocks.deleteMcpOAuthSession.mockResolvedValue(undefined);
}

function lastClientAuth() {
  const call = mocks.createLangChainMcpClient.mock.calls.at(-1)?.[0] as
    | {
        headers: Record<string, string>;
        authProvider?: unknown;
      }
    | undefined;
  assert.ok(call, "no MCP client was created");
  return call;
}

function credentialInput(
  input: Partial<Parameters<McpService["upsertCredentials"]>[0]>,
) {
  return {
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: "mcp_install_arcmira",
    authType: "bearer" as const,
    ...input,
  };
}

test("saving a bearer key on an OAuth-or-key install stores it and drops only this member's OAuth session", async () => {
  resetAuthMethodMocks();
  const install = oauthOrKeyInstall();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  vi.mocked(listUserCredentialInstallIds).mockResolvedValue(
    new Set([install.id]),
  );

  const result = await new McpService().upsertCredentials(
    credentialInput({ authType: "bearer", bearerToken: "arc-key" }),
  );

  const saved = mocks.upsertWorkspaceMcpCredential.mock.calls[0]?.[0];
  assert.equal(saved?.authType, "bearer");
  assert.equal(saved?.encryptedSecret, "enc:arc-key");
  assert.equal(saved?.userId, "user_1");
  assert.deepEqual(mocks.deleteMcpOAuthSession.mock.calls, [
    [
      {
        teamId: "team_1",
        workspaceId: "workspace_1",
        installId: install.id,
        userId: "user_1",
      },
    ],
  ]);
  assert.equal(result.install.credentialStatus, "configured");
  assert.equal(result.install.connectedVia, "header");
});

test("a turn on an OAuth-or-key install sends the member's saved bearer key", async () => {
  resetAuthMethodMocks();
  const install = oauthOrKeyInstall();
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "bearer",
    encryptedSecret: "enc:arc-key",
  });
  toolsByInstallId.set(install.id, [
    originalTool({ name: "mcp__arcmira__read_repo" }),
  ]);
  install.tools = [
    mcpTool({
      installId: install.id,
      normalizedToolName: "mcp__arcmira__read_repo",
    }),
  ];

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );

  const auth = lastClientAuth();
  assert.deepEqual(auth.headers, { Authorization: "Bearer arc-key" });
  assert.equal(auth.authProvider, undefined);
  assert.equal(
    mocks.findWorkspaceMcpCredential.mock.calls[0]?.[0]?.userId,
    "user_1",
  );
  await runtime.close();
});

test("a turn on an OAuth-or-key install prefers the member's OAuth session", async () => {
  resetAuthMethodMocks();
  const install = oauthOrKeyInstall({ tools: [] });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  vi.mocked(getMcpOAuthStatus).mockResolvedValue({
    connected: true,
    issuer: "https://auth.arcmira.example",
  });
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "bearer",
    encryptedSecret: "enc:stale-key",
  });

  const runtime = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );

  const auth = lastClientAuth();
  assert.deepEqual(auth.headers, {});
  assert.ok(auth.authProvider, "expected the member's OAuth provider");
  assert.equal(mocks.findWorkspaceMcpCredential.mock.calls.length, 0);
  await runtime.close();
});

test("a turn on an OAuth-or-key install with neither connection still needs OAuth", async () => {
  resetAuthMethodMocks();
  const install = oauthOrKeyInstall({ tools: [] });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);

  await assert.rejects(
    () =>
      new McpService().buildLangChainToolsForTurn(
        serviceInput({ installIds: [install.id] }),
      ),
    (error: unknown) =>
      error instanceof McpError &&
      error.code === "MCP_OAUTH_NOT_CONNECTED" &&
      error.statusCode === 409,
  );
  assert.equal(mocks.createLangChainMcpClient.mock.calls.length, 0);
});

test("testInstall on an OAuth-or-key install uses the member's saved bearer key", async () => {
  resetAuthMethodMocks();
  const install = oauthOrKeyInstall();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "bearer",
    encryptedSecret: "enc:arc-key",
  });
  mocks.upsertWorkspaceMcpTools.mockResolvedValue(undefined);
  mocks.updateWorkspaceMcpInstall.mockResolvedValue(install);

  await new McpService().testInstall({
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: install.id,
  });

  const auth = lastClientAuth();
  assert.deepEqual(auth.headers, { Authorization: "Bearer arc-key" });
  assert.equal(auth.authProvider, undefined);
});

test("testInstall returns the install with the member's own connection status", async () => {
  resetAuthMethodMocks();
  const install = oauthOrKeyInstall();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "bearer",
    encryptedSecret: "enc:arc-key",
  });
  mocks.upsertWorkspaceMcpTools.mockResolvedValue(undefined);
  // The row as stored: the install-level status, never the member's.
  mocks.updateWorkspaceMcpInstall.mockResolvedValue({
    ...install,
    credentialStatus: "required",
  });
  vi.mocked(listUserCredentialInstallIds).mockResolvedValue(
    new Set([install.id]),
  );

  const result = await new McpService().testInstall({
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: install.id,
  });

  assert.equal(result.install.credentialStatus, "configured");
  assert.equal(result.install.connectedVia, "header");
});

test("testInstall on an OAuth-or-key install with no connection fails fast", async () => {
  resetAuthMethodMocks();
  const install = oauthOrKeyInstall();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);

  await assert.rejects(
    () =>
      new McpService().testInstall({
        workspaceId: "workspace_1",
        userId: "user_1",
        installId: install.id,
      }),
    (error: unknown) =>
      error instanceof McpError &&
      error.code === "MCP_OAUTH_NOT_CONNECTED" &&
      error.statusCode === 400,
  );
  assert.equal(mocks.updateWorkspaceMcpInstall.mock.calls.length, 0);
});

test("credential saves of a method the install does not accept are rejected", async () => {
  const cases: Array<{
    install: WorkspaceMcpInstallRecord;
    input: Partial<Parameters<McpService["upsertCredentials"]>[0]>;
  }> = [
    // Arcmira's header method is Bearer, not an arbitrary API-key header.
    {
      install: oauthOrKeyInstall(),
      input: {
        authType: "api_key_header",
        apiKeyHeaderName: "X-Api-Key",
        apiKey: "k",
      },
    },
    {
      install: oauthOrKeyInstall(),
      input: { authType: "custom_headers", headers: { "X-Api-Key": "k" } },
    },
    // An optional key install's method is a plain header, not Bearer.
    {
      install: optionalKeyInstall(),
      input: { authType: "bearer", bearerToken: "k" },
    },
    // Legacy installs accept only their own type.
    {
      install: mcpInstall({ authType: "bearer", manifestJson: {} }),
      input: {
        authType: "api_key_header",
        apiKeyHeaderName: "X-Api-Key",
        apiKey: "k",
      },
    },
    {
      install: mcpInstall({ authType: "oauth", manifestJson: {} }),
      input: { authType: "bearer", bearerToken: "k" },
    },
  ];
  for (const { install, input } of cases) {
    resetAuthMethodMocks();
    mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
    await assert.rejects(
      () =>
        new McpService().upsertCredentials(
          credentialInput({ installId: install.id, ...input }),
        ),
      (error: unknown) =>
        error instanceof McpError &&
        error.code === "MCP_CREDENTIAL_METHOD_NOT_ALLOWED" &&
        error.statusCode === 400,
      `${install.authType} install accepted ${input.authType}`,
    );
    assert.equal(mocks.upsertWorkspaceMcpCredential.mock.calls.length, 0);
    assert.equal(mocks.deleteMcpOAuthSession.mock.calls.length, 0);
  }
});

test("a method-backed API-key save takes the header name from the method, not the client", async () => {
  resetAuthMethodMocks();
  const install = optionalKeyInstall();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  vi.mocked(listUserCredentialInstallIds).mockResolvedValue(
    new Set([install.id]),
  );

  const result = await new McpService().upsertCredentials(
    credentialInput({
      installId: install.id,
      authType: "api_key_header",
      apiKeyHeaderName: "X-Forwarded-To-Attacker",
      apiKey: "exa-key",
    }),
  );

  const saved = mocks.upsertWorkspaceMcpCredential.mock.calls[0]?.[0];
  assert.equal(saved?.authType, "api_key_header");
  assert.equal(saved?.headerName, "x-api-key");
  assert.equal(saved?.encryptedSecret, "enc:exa-key");
  // No OAuth method, so there is no OAuth session to replace.
  assert.equal(mocks.deleteMcpOAuthSession.mock.calls.length, 0);
  assert.equal(result.install.credentialStatus, "configured");
  assert.equal(result.install.connectedVia, "header");
});

test("a turn on an optional-key install sends the member's saved key, or nothing", async () => {
  resetAuthMethodMocks();
  const install = optionalKeyInstall({ tools: [] });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([install]);
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "api_key_header",
    encryptedSecret: "enc:exa-key",
    headerName: "x-api-key",
  });

  const withKey = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );
  assert.deepEqual(lastClientAuth().headers, { "x-api-key": "exa-key" });
  await withKey.close();

  mocks.findWorkspaceMcpCredential.mockResolvedValue(null);
  const withoutKey = await new McpService().buildLangChainToolsForTurn(
    serviceInput({ installIds: [install.id] }),
  );
  assert.deepEqual(lastClientAuth().headers, {});
  // No OAuth method: the member's OAuth status is never consulted.
  assert.equal(vi.mocked(getMcpOAuthStatus).mock.calls.length, 0);
  await withoutKey.close();
});

test("legacy installs without declared methods save and resolve auth as before", async () => {
  resetAuthMethodMocks();
  // api_key_header keeps the client-chosen header name.
  const keyInstall = mcpInstall({
    id: "mcp_install_key",
    authType: "api_key_header",
    manifestJson: { auth: { type: "api_key_header", headerName: "X-Api-Key" } },
  });
  mocks.findWorkspaceMcpInstall.mockResolvedValue(keyInstall);
  await new McpService().upsertCredentials(
    credentialInput({
      installId: keyInstall.id,
      authType: "api_key_header",
      apiKeyHeaderName: "X-Custom-Key",
      apiKey: "k",
    }),
  );
  assert.equal(
    mocks.upsertWorkspaceMcpCredential.mock.calls[0]?.[0]?.headerName,
    "X-Custom-Key",
  );
  assert.equal(mocks.deleteMcpOAuthSession.mock.calls.length, 0);

  // An OAuth-only install never reads a stored credential.
  const oauthInstall = mcpInstall({
    id: "mcp_install_oauth",
    authType: "oauth",
    tools: [],
  });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([oauthInstall]);
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "bearer",
    encryptedSecret: "enc:stray",
  });
  await assert.rejects(
    () =>
      new McpService().buildLangChainToolsForTurn(
        serviceInput({ installIds: [oauthInstall.id] }),
      ),
    (error: unknown) =>
      error instanceof McpError && error.code === "MCP_OAUTH_NOT_CONNECTED",
  );
  assert.equal(mocks.findWorkspaceMcpCredential.mock.calls.length, 0);

  // A static install without the member's credential fails preparation.
  const bearerInstall = mcpInstall({
    id: "mcp_install_bearer",
    authType: "bearer",
    tools: [],
  });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([bearerInstall]);
  mocks.findWorkspaceMcpCredential.mockResolvedValue(null);
  vi.mocked(getMcpOAuthStatus).mockClear();
  await assert.rejects(
    () =>
      new McpService().buildLangChainToolsForTurn(
        serviceInput({ installIds: [bearerInstall.id] }),
      ),
    (error: unknown) =>
      error instanceof McpError && error.code === "MCP_CREDENTIAL_REQUIRED",
  );
  assert.equal(vi.mocked(getMcpOAuthStatus).mock.calls.length, 0);
});

test("listInstalls overlays per-member status and connectedVia in two batched queries", async () => {
  resetAuthMethodMocks();
  const viaOAuth = oauthOrKeyInstall({ id: "a_oauth" });
  const viaHeader = oauthOrKeyInstall({ id: "b_header" });
  const unconnected = oauthOrKeyInstall({ id: "c_none" });
  const optionalWithKey = optionalKeyInstall({ id: "d_optional_key" });
  const optionalWithout = optionalKeyInstall({ id: "e_optional" });
  const legacyOpen = mcpInstall({ id: "f_open", authType: "none" });
  const legacyBearer = mcpInstall({ id: "g_bearer", authType: "bearer" });
  const legacyOAuth = mcpInstall({ id: "h_oauth", authType: "oauth" });
  mocks.listWorkspaceMcpInstalls.mockResolvedValue([
    viaOAuth,
    viaHeader,
    unconnected,
    optionalWithKey,
    optionalWithout,
    legacyOpen,
    legacyBearer,
    legacyOAuth,
  ]);
  vi.mocked(listUserConnectedOAuthInstallIds).mockResolvedValue(
    new Set(["a_oauth"]),
  );
  vi.mocked(listUserCredentialInstallIds).mockResolvedValue(
    new Set(["b_header", "d_optional_key"]),
  );

  const { items } = await new McpService().listInstalls({
    workspaceId: "workspace_1",
    userId: "user_1",
  });

  assert.deepEqual(
    items.map((item) => [item.id, item.credentialStatus, item.connectedVia]),
    [
      ["a_oauth", "configured", "oauth"],
      ["b_header", "configured", "header"],
      ["c_none", "required", null],
      ["d_optional_key", "configured", "header"],
      ["e_optional", "not_required", null],
      ["f_open", "not_required", null],
      ["g_bearer", "required", null],
      ["h_oauth", "required", null],
    ],
  );
  const oauthCalls = vi.mocked(listUserConnectedOAuthInstallIds).mock.calls;
  const credentialCalls = vi.mocked(listUserCredentialInstallIds).mock.calls;
  assert.equal(oauthCalls.length, 1);
  assert.equal(credentialCalls.length, 1);
  assert.deepEqual(oauthCalls[0]?.[0]?.installIds, [
    "a_oauth",
    "b_header",
    "c_none",
    "h_oauth",
  ]);
  // A legacy OAuth-only or open install is never matched to a stored key.
  assert.deepEqual(credentialCalls[0]?.[0]?.installIds, [
    "a_oauth",
    "b_header",
    "c_none",
    "d_optional_key",
    "e_optional",
    "g_bearer",
  ]);
});

/** Two members' own accounts on one install: each key sees different tools. */
function memberAccounts(
  install: WorkspaceMcpInstallRecord,
  tools: Record<string, string[] | Error>,
) {
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  mocks.findWorkspaceMcpCredential.mockImplementation(
    async (scope: { userId: string }) => ({
      authType: "bearer",
      encryptedSecret: `enc:key-of-${scope.userId}`,
    }),
  );
  mocks.createLangChainMcpClient.mockImplementation(
    ({ headers }: { headers: { Authorization?: string } }) => {
      const member = headers.Authorization?.replace("Bearer key-of-", "") ?? "";
      const close = vi.fn(async () => undefined);
      clientCloseMocks.push(close);
      return {
        close,
        getTools: vi.fn(async () => {
          const listed = tools[member];
          if (listed instanceof Error) throw listed;
          return (listed ?? []).map((name) =>
            originalTool({
              name: `mcp__arcmira__${name}`,
              metadata: { annotations: { readOnlyHint: name.startsWith("get") } },
            }),
          );
        }),
      };
    },
  );
}

test("discoverToolsForMember returns each member their own tools and writes nothing shared", async () => {
  resetAuthMethodMocks();
  memberAccounts(oauthOrKeyInstall(), {
    user_a: ["get_a", "put_a"],
    user_b: ["get_b"],
  });
  const service = new McpService();
  const input = { workspaceId: "workspace_1", installId: "mcp_install_arcmira" };

  const first = await service.discoverToolsForMember({ ...input, userId: "user_a" });
  const second = await service.discoverToolsForMember({ ...input, userId: "user_b" });

  assert.deepEqual(first.tools.map((tool) => tool.name), ["get_a", "put_a"]);
  assert.deepEqual(first.tools.map((tool) => tool.readOnly), [true, false]);
  assert.deepEqual(second.tools.map((tool) => tool.name), ["get_b"]);
  // The shared tool rows and the install's shared health are untouched.
  assert.equal(mocks.upsertWorkspaceMcpTools.mock.calls.length, 0);
  assert.equal(mocks.updateWorkspaceMcpInstall.mock.calls.length, 0);
  // Every client was closed.
  assert.ok(clientCloseMocks.length === 2);
  for (const close of clientCloseMocks) assert.equal(close.mock.calls.length, 1);
});

test("a member's failing credential fails only their own discovery and never marks the install", async () => {
  resetAuthMethodMocks();
  memberAccounts(oauthOrKeyInstall(), {
    user_a: ["get_a"],
    user_b: new Error("401 Unauthorized: bad key sk-secretsecretsecret123456"),
  });
  const service = new McpService();
  const input = { workspaceId: "workspace_1", installId: "mcp_install_arcmira" };

  await assert.rejects(
    () => service.discoverToolsForMember({ ...input, userId: "user_b" }),
    (error: unknown) =>
      error instanceof McpError &&
      error.code === "MCP_MEMBER_DISCOVERY_FAILED" &&
      !error.message.includes("sk-secretsecretsecret123456"),
  );
  const ok = await service.discoverToolsForMember({ ...input, userId: "user_a" });
  assert.deepEqual(ok.tools.map((tool) => tool.name), ["get_a"]);
  // testInstall would have set status "error" and a lastError here.
  assert.equal(mocks.updateWorkspaceMcpInstall.mock.calls.length, 0);
  assert.equal(mocks.upsertWorkspaceMcpTools.mock.calls.length, 0);
});

test("a member's discovery is offered to the catalog without anything about them", async () => {
  resetAuthMethodMocks();
  mocks.recordMemberObservedTools.mockResolvedValue({ recorded: true, outcome: "created" });
  memberAccounts(oauthOrKeyInstall({ endpointUrl: "https://mcp.arcmira.com/mcp" }), {
    user_a: ["get_a", "put_a"],
  });
  await new McpService().discoverToolsForMember({
    workspaceId: "workspace_1",
    userId: "user_a",
    installId: "mcp_install_arcmira",
  });
  await vi.waitFor(() => assert.equal(mocks.recordMemberObservedTools.mock.calls.length, 1));
  const offered = mocks.recordMemberObservedTools.mock.calls[0]![0] as Record<string, unknown>;
  assert.equal(offered.marketIdentifier, "arcmira");
  assert.equal(offered.endpointUrl, "https://mcp.arcmira.com/mcp");
  assert.equal(offered.complete, true);
  assert.deepEqual(
    (offered.tools as Array<{ name: string }>).map((tool) => tool.name),
    ["get_a", "put_a"],
  );
  // Nothing that says who connected, or where, is passed on.
  assert.deepEqual(Object.keys(offered).sort(), ["complete", "endpointUrl", "marketIdentifier", "tools"]);
  assert.ok(!JSON.stringify(offered).match(/user_a|workspace_1|team_1|mcp_install_arcmira/));
});

test("a failing observation never fails the member's discovery", async () => {
  resetAuthMethodMocks();
  mocks.recordMemberObservedTools.mockRejectedValue(new Error("database is down"));
  memberAccounts(oauthOrKeyInstall(), { user_a: ["get_a"] });
  const result = await new McpService().discoverToolsForMember({
    workspaceId: "workspace_1",
    userId: "user_a",
    installId: "mcp_install_arcmira",
  });
  assert.deepEqual(result.tools.map((tool) => tool.name), ["get_a"]);
  await vi.waitFor(() => assert.equal(mocks.recordMemberObservedTools.mock.calls.length, 1));
});

test("a cut-off discovery is offered as incomplete, a failed one not at all", async () => {
  resetAuthMethodMocks();
  mocks.recordMemberObservedTools.mockResolvedValue({ recorded: false, reason: "incomplete" });
  const install = oauthOrKeyInstall();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "bearer",
    encryptedSecret: "enc:key",
  });
  toolsByInstallId.set(
    install.id,
    Array.from({ length: 250 }, (_, index) =>
      originalTool({ name: `mcp__arcmira__tool_${index}` }),
    ),
  );
  await new McpService().discoverToolsForMember({
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: install.id,
  });
  await vi.waitFor(() => assert.equal(mocks.recordMemberObservedTools.mock.calls.length, 1));
  assert.equal(
    (mocks.recordMemberObservedTools.mock.calls[0]![0] as { complete: boolean }).complete,
    false,
  );

  resetAuthMethodMocks();
  memberAccounts(oauthOrKeyInstall(), {
    user_b: new Error("401 Unauthorized"),
  });
  await assert.rejects(() =>
    new McpService().discoverToolsForMember({
      workspaceId: "workspace_1",
      userId: "user_b",
      installId: "mcp_install_arcmira",
    }),
  );
  assert.equal(mocks.recordMemberObservedTools.mock.calls.length, 0);
});

test("a member without permission to manage MCP cannot discover, and no client is created", async () => {
  resetAuthMethodMocks();
  memberAccounts(oauthOrKeyInstall(), { user_a: ["get_a"] });
  mocks.requireMcpWorkspace.mockImplementation(
    async (input: { userId: string; permission: string }) => {
      if (input.userId === "viewer" || input.permission !== "mcp.manage") {
        throw new McpError(403, "MCP_FORBIDDEN", "no access");
      }
      return {
        workspace: { id: "workspace_1", organizationId: "team_1" },
        membership: { role: "workspace_admin" },
      };
    },
  );
  await assert.rejects(
    () =>
      new McpService().discoverToolsForMember({
        workspaceId: "workspace_1",
        userId: "viewer",
        installId: "mcp_install_arcmira",
      }),
    (error: unknown) => error instanceof McpError && error.code === "MCP_FORBIDDEN",
  );
  assert.equal(mocks.createLangChainMcpClient.mock.calls.length, 0);
});

test("discoverToolsForMember bounds the count and drops oversize definitions", async () => {
  resetAuthMethodMocks();
  const install = oauthOrKeyInstall();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(install);
  mocks.findWorkspaceMcpCredential.mockResolvedValue({
    authType: "bearer",
    encryptedSecret: "enc:key",
  });
  const tools = Array.from({ length: 250 }, (_, index) =>
    originalTool({ name: `mcp__arcmira__tool_${index}` }),
  );
  // One tool whose schema alone is far past the per-tool limit.
  (tools[3] as unknown as { schema: unknown }).schema = {
    type: "object",
    properties: { blob: { type: "string", description: "x".repeat(40_000) } },
  };
  toolsByInstallId.set(install.id, tools);

  const result = await new McpService().discoverToolsForMember({
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: install.id,
  });

  assert.equal(result.toolCount, 250);
  assert.equal(result.truncated, true);
  assert.equal(result.skippedOversize, 1);
  assert.equal(result.tools.length, 199);
  assert.ok(!result.tools.some((tool) => tool.name === "tool_3"));
  assert.equal(mocks.upsertWorkspaceMcpTools.mock.calls.length, 0);
});

test("discoverToolsForMember on an unconnected OAuth install fails fast without a client", async () => {
  resetAuthMethodMocks();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(oauthOrKeyInstall());
  await assert.rejects(
    () =>
      new McpService().discoverToolsForMember({
        workspaceId: "workspace_1",
        userId: "user_1",
        installId: "mcp_install_arcmira",
      }),
    (error: unknown) =>
      error instanceof McpError && error.code === "MCP_OAUTH_NOT_CONNECTED",
  );
  assert.equal(mocks.createLangChainMcpClient.mock.calls.length, 0);
});

test("discoverToolsForMember on a key-required install without a saved key says so and calls nothing", async () => {
  resetAuthMethodMocks();
  mocks.findWorkspaceMcpInstall.mockResolvedValue(
    mcpInstall({
      id: "mcp_install_key",
      authType: "bearer",
      credentialStatus: "required",
    }),
  );
  mocks.findWorkspaceMcpCredential.mockResolvedValue(null);
  await assert.rejects(
    () =>
      new McpService().discoverToolsForMember({
        workspaceId: "workspace_1",
        userId: "user_1",
        installId: "mcp_install_key",
      }),
    (error: unknown) =>
      error instanceof McpError &&
      error.code === "MCP_NOT_CONNECTED" &&
      error.statusCode === 400,
  );
  assert.equal(mocks.createLangChainMcpClient.mock.calls.length, 0);
});
