import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkspaceMcpInstallRecord } from "./types";
import {
  createLangChainMcpClient,
  langChainMcpServerKey,
  langChainMcpToolName,
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

test("langChainMcpToolName is provider-safe, bounded, and collision-resistant", () => {
  const record = install({
    id: "install-with-a-stable-suffix",
    marketIdentifier: "io.github.acme/repository",
  });
  const first = langChainMcpToolName({
    install: record,
    serverToolName: "issues/create or update a very long record name",
  });
  const second = langChainMcpToolName({
    install: record,
    serverToolName: "issues:create or update a very long record name",
  });

  assert.match(first, /^[a-zA-Z0-9_-]+$/u);
  assert.ok(first.length <= 64);
  assert.notEqual(first, second);
  assert.equal(
    langChainMcpToolName({ install: record, serverToolName: "read_repo" }),
    `mcp__${langChainMcpServerKey(record)}__read_repo`,
  );
});

test("langChainMcpServerKey disambiguates identifiers that sanitize alike", () => {
  // `io.github.a/b` and `io.github.a.b` both collapse to `io_github_a_b`; the
  // install-id suffix must keep their server keys distinct so their tool names
  // (and interruptOn entries) never collide.
  const a = langChainMcpServerKey({
    marketIdentifier: "io.github.a/b",
    id: "install_shared_prefix_aaaa",
  });
  const b = langChainMcpServerKey({
    marketIdentifier: "io.github.a.b",
    id: "install_shared_prefix_bbbb",
  });
  assert.notEqual(a, b);
  assert.match(a, /^[a-zA-Z0-9_-]+$/);
  assert.match(b, /^[a-zA-Z0-9_-]+$/);
});

test("createLangChainMcpClient rejects missing endpointUrl before construction", () => {
  assert.throws(
    () =>
      createLangChainMcpClient({
        install: install({ endpointUrl: null }),
      }),
    /MCP endpoint is required/,
  );
});

test("createLangChainMcpClient rejects hosted stdio before construction", () => {
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
});
