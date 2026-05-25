import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { WorkspaceMcpInstallRecord } from "./types";

const mocks = vi.hoisted(() => ({
  constructorSpy: vi.fn(),
}));

vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: class {
    constructor(config: unknown) {
      mocks.constructorSpy(config);
    }
  },
}));

import { createLangChainMcpClient } from "./langchain-client";

function install(
  input: Partial<WorkspaceMcpInstallRecord> = {},
): WorkspaceMcpInstallRecord {
  return {
    id: "mcp_install_1",
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
    authType: "bearer",
    credentialStatus: "configured",
    enabled: true,
    manifestJson: {},
    signature: "signature",
    signingKeyId: "sourceweft",
    lastTestedAt: null,
    lastError: null,
    createdBy: "user_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tools: [],
    ...input,
  };
}

test("createLangChainMcpClient configures streamable HTTP MCP servers", () => {
  mocks.constructorSpy.mockClear();

  createLangChainMcpClient({
    install: install({ marketIdentifier: "github" }),
    headers: { Authorization: "Bearer secret" },
  });

  assert.deepEqual(mocks.constructorSpy.mock.calls[0]?.[0], {
    throwOnLoadError: true,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "mcp",
    useStandardContentBlocks: true,
    onConnectionError: "throw",
    mcpServers: {
      github: {
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer secret" },
        automaticSSEFallback: false,
      },
    },
  });
});

test("createLangChainMcpClient enables SSE fallback for http_sse_compat manifests", () => {
  mocks.constructorSpy.mockClear();

  createLangChainMcpClient({
    install: install({
      marketIdentifier: "legacy",
      transport: "http_sse_compat",
    }),
  });

  const config = mocks.constructorSpy.mock.calls[0]?.[0] as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  const server = config.mcpServers.legacy;
  assert.ok(server);
  assert.equal(server.transport, "http");
  assert.equal(server.automaticSSEFallback, true);
});

test("createLangChainMcpClient configures SSE MCP servers and falls back to install id", () => {
  mocks.constructorSpy.mockClear();

  createLangChainMcpClient({
    install: install({
      id: "mcp_install_sse",
      marketIdentifier: null,
      transport: "sse",
      endpointUrl: "https://mcp.example.com/sse",
    }),
  });

  const config = mocks.constructorSpy.mock.calls[0]?.[0] as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  const server = config.mcpServers.mcp_install_sse;
  assert.ok(server);
  assert.equal(server.transport, "sse");
  assert.equal(server.url, "https://mcp.example.com/sse");
});
