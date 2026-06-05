import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createWorkspaceMcpInstall,
  createWorkspaceMcpManifestSnapshot,
  getHostedMcpTransport,
  isHostedMcpTransport,
} from "./mcp-install";
import { createNormalizedInvocationError } from "./errors";

test("workspace MCP install model supports marketplace and remote custom installs", () => {
  const marketplace = createWorkspaceMcpInstall({
    id: "mcp_install_market",
    workspaceId: "workspace_1",
    source: "marketplace",
    marketIdentifier: "github",
    transport: "sse",
    endpointUrl: "https://mcp.example.com/sse",
    manifest: createWorkspaceMcpManifestSnapshot({
      serverInstallId: "mcp_install_market",
      tools: [],
      prompts: [],
      resources: [],
      discoveredAt: "2026-01-01T00:00:00.000Z",
      schemaHash: "hash_market",
    }),
  });
  const customHttp = createWorkspaceMcpInstall({
    id: "mcp_install_custom",
    workspaceId: "workspace_1",
    source: "custom_remote",
    transport: "streamable_http",
    endpointUrl: "https://mcp.example.com/mcp",
    manifest: createWorkspaceMcpManifestSnapshot({
      serverInstallId: "mcp_install_custom",
      tools: [],
      prompts: [],
      resources: [],
      discoveredAt: "2026-01-01T00:00:00.000Z",
      schemaHash: "hash_custom",
    }),
  });

  assert.equal(marketplace.source, "marketplace");
  assert.equal(marketplace.marketIdentifier, "github");
  assert.equal(customHttp.source, "custom_remote");
  assert.equal(customHttp.transport, "streamable_http");
});

test("hosted backend accepts SSE, streamable HTTP, and HTTP/SSE compat transports", () => {
  assert.equal(isHostedMcpTransport("sse"), true);
  assert.equal(isHostedMcpTransport("streamable_http"), true);
  assert.equal(isHostedMcpTransport("http_sse_compat"), true);
  assert.equal(getHostedMcpTransport("sse"), "sse");
  assert.equal(getHostedMcpTransport("streamable_http"), "streamable_http");
  assert.equal(getHostedMcpTransport("http_sse_compat"), "http_sse_compat");
});

test("hosted backend rejects stdio MCP installs with normalized transport error", () => {
  assert.equal(isHostedMcpTransport("stdio"), false);
  assert.throws(
    () => getHostedMcpTransport("stdio"),
    /Hosted backend does not support stdio MCP transport/,
  );

  const error = createNormalizedInvocationError({
    code: "MCP_TRANSPORT_UNSUPPORTED",
    message: "Hosted backend does not support stdio MCP transport",
    sourceRef: {
      kind: "mcp_tool",
      serverInstallId: "mcp_stdio",
      serverToolName: "local_tool",
    },
  });
  assert.equal(error.code, "MCP_TRANSPORT_UNSUPPORTED");
});

test("manifest snapshot models tools, prompts, resources, discovered timestamp, and schema hash", () => {
  const manifest = createWorkspaceMcpManifestSnapshot({
    serverInstallId: "mcp_install_1",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    schemaHash: "schema_hash_1",
    tools: [
      {
        id: "tool_1",
        serverInstallId: "mcp_install_1",
        serverToolName: "create_issue",
        normalizedToolName: "github_create_issue",
        title: "Create issue",
        description: "Create a GitHub issue",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        risk: "high",
        enabled: true,
        schemaHash: "tool_schema_hash_1",
      },
    ],
    prompts: [
      {
        id: "prompt_1",
        serverInstallId: "mcp_install_1",
        name: "triage_issue",
        title: "Triage issue",
        description: "Draft issue triage",
        argumentsSchema: { type: "object" },
        enabled: true,
        schemaHash: "prompt_schema_hash_1",
      },
    ],
    resources: [
      {
        id: "resource_1",
        serverInstallId: "mcp_install_1",
        uri: "github://issues/1",
        title: "Issue 1",
        description: "GitHub issue resource",
        mimeType: "text/markdown",
        enabled: true,
        schemaHash: "resource_schema_hash_1",
      },
    ],
  });

  assert.equal(manifest.serverInstallId, "mcp_install_1");
  assert.equal(manifest.schemaHash, "schema_hash_1");
  assert.equal(manifest.tools[0]?.serverInstallId, "mcp_install_1");
  assert.equal(manifest.prompts[0]?.serverInstallId, "mcp_install_1");
  assert.equal(manifest.resources[0]?.serverInstallId, "mcp_install_1");
  assert.equal(manifest.tools[0]?.risk, "high");
});
