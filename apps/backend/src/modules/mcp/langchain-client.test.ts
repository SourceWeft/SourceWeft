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

import {
  createLangChainMcpClient,
  langChainMcpServerKey,
} from "./langchain-client";

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

  const record = install({ marketIdentifier: "github" });
  createLangChainMcpClient({
    install: record,
    headers: { Authorization: "Bearer secret" },
  });

  assert.deepEqual(mocks.constructorSpy.mock.calls[0]?.[0], {
    throwOnLoadError: true,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: "mcp",
    useStandardContentBlocks: true,
    onConnectionError: "throw",
    mcpServers: {
      [langChainMcpServerKey(record)]: {
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

  const record = install({
    marketIdentifier: "legacy",
    transport: "http_sse_compat",
  });
  createLangChainMcpClient({ install: record });

  const config = mocks.constructorSpy.mock.calls[0]?.[0] as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  const server = config.mcpServers[langChainMcpServerKey(record)];
  assert.ok(server);
  assert.equal(server.transport, "http");
  assert.equal(server.automaticSSEFallback, true);
});

test("createLangChainMcpClient does not enable SSE fallback for streamable_http", () => {
  mocks.constructorSpy.mockClear();

  const record = install({
    marketIdentifier: "streamable",
    transport: "streamable_http",
  });
  createLangChainMcpClient({ install: record });

  const config = mocks.constructorSpy.mock.calls[0]?.[0] as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  const server = config.mcpServers[langChainMcpServerKey(record)];
  assert.ok(server);
  assert.equal(server.transport, "http");
  assert.equal(server.automaticSSEFallback, false);
});

test("createLangChainMcpClient configures SSE MCP servers and falls back to install id", () => {
  mocks.constructorSpy.mockClear();

  const record = install({
    id: "mcp_install_sse",
    marketIdentifier: null,
    transport: "sse",
    endpointUrl: "https://mcp.example.com/sse",
  });
  createLangChainMcpClient({ install: record });

  const config = mocks.constructorSpy.mock.calls[0]?.[0] as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  const server = config.mcpServers[langChainMcpServerKey(record)];
  assert.ok(server);
  assert.equal(server.transport, "sse");
  assert.equal(server.url, "https://mcp.example.com/sse");
});

test("langChainMcpServerKey disambiguates identifiers that sanitize alike", () => {
  // `io.github.a/b` and `io.github.a.b` both collapse to `io_github_a_b`; the
  // install-id suffix must keep their server keys distinct so their tool names
  // (and interruptOn entries) never collide.
  const a = langChainMcpServerKey({
    marketIdentifier: "io.github.a/b",
    id: "install_aaaa",
  });
  const b = langChainMcpServerKey({
    marketIdentifier: "io.github.a.b",
    id: "install_bbbb",
  });
  assert.notEqual(a, b);
  assert.match(a, /^[a-zA-Z0-9_-]+$/);
  assert.match(b, /^[a-zA-Z0-9_-]+$/);
});

test("createLangChainMcpClient rejects missing endpointUrl before construction", () => {
  mocks.constructorSpy.mockClear();

  assert.throws(
    () =>
      createLangChainMcpClient({
        install: install({ endpointUrl: null }),
      }),
    /MCP endpoint is required/,
  );
  assert.equal(mocks.constructorSpy.mock.calls.length, 0);
});

test("createLangChainMcpClient rejects hosted stdio before construction", () => {
  mocks.constructorSpy.mockClear();

  assert.throws(
    () =>
      createLangChainMcpClient({
        install: install({
          transport: "stdio",
          endpointUrl: null,
          desktopOnly: true,
          webExecutable: false,
        }),
      }),
    /Hosted backend does not support stdio MCP transport/,
  );
  assert.equal(mocks.constructorSpy.mock.calls.length, 0);
});
