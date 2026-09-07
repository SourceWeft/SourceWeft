import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceMcpInstallRecord } from "./types";
import {
  createLangChainMcpClient,
  langChainMcpServerKey,
} from "./langchain-client";
import { McpOAuthClientProvider } from "./oauth-provider";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const settings = vi.hoisted(() => ({
  endpointAddressChecksEnabled: true,
  mcpAllowedInternalOrigins: [] as string[],
}));
vi.mock("../../shared/config", () => ({ config: settings }));
const clients: ReturnType<typeof createLangChainMcpClient>[] = [];
const servers: HttpServer[] = [];
const protocolServers: Server[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(protocolServers.splice(0).map((server) => server.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  settings.mcpAllowedInternalOrigins = [];
  settings.endpointAddressChecksEnabled = true;
});

function install(
  url: string,
  transport: WorkspaceMcpInstallRecord["transport"],
): WorkspaceMcpInstallRecord {
  return {
    id: "integration-install",
    marketIdentifier: "org.example/echo",
    name: "Echo",
    endpointUrl: url,
    transport,
    authType: "none",
  } as WorkspaceMcpInstallRecord;
}

function protocolServer() {
  const server = new Server(
    { name: "test", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: String(request.params.arguments?.value) }],
    structuredContent: { echoed: request.params.arguments?.value },
  }));
  protocolServers.push(server);
  return server;
}

async function httpFixture(
  mode: "http" | "sse" | "compat",
  token?: string,
  oauthRefresh = false,
) {
  const protocol = protocolServer();
  const seen: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    custom?: string;
  }> = [];
  let sse: SSEServerTransport | undefined;
  const http = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  if (mode === "http") await protocol.connect(http);
  let origin = "";
  const server = createServer((req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      custom: req.headers["x-test-key"] as string | undefined,
    });
    if (
      oauthRefresh &&
      req.url?.startsWith("/.well-known/oauth-protected-resource")
    ) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          resource: `${origin}/sse`,
          authorization_servers: [origin],
        }),
      );
      return;
    }
    if (
      oauthRefresh &&
      req.url?.startsWith("/.well-known/oauth-authorization-server")
    ) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      );
      return;
    }
    if (oauthRefresh && req.url === "/token") {
      let body = "";
      req.on("data", (part) => {
        body += part;
      });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        const fields = new URLSearchParams(body);
        if (
          fields.get("grant_type") !== "refresh_token" ||
          fields.get("refresh_token") !== "fixture-refresh"
        ) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.end(
          JSON.stringify({
            access_token: token,
            refresh_token: "fixture-refresh",
            token_type: "Bearer",
          }),
        );
      });
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      );
      res.writeHead(401);
      res.end();
      return;
    }
    const respond = async () => {
      if (mode === "http") {
        await http.handleRequest(req, res);
        return;
      }
      if (req.url === "/sse" && req.method === "GET") {
        sse = new SSEServerTransport("/messages", res);
        await protocol.connect(sse);
        return;
      }
      if (req.url?.startsWith("/messages") && req.method === "POST" && sse) {
        await sse.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    };
    void respond().catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  settings.mcpAllowedInternalOrigins = [origin];
  return { origin, seen };
}

for (const mode of ["http", "sse", "compat"] as const) {
  test(`real ${mode} discovery and tool calls preserve names, headers and content`, async () => {
    const fixture = await httpFixture(mode);
    const record = install(
      `${fixture.origin}/${mode === "sse" ? "sse" : "mcp"}`,
      mode === "compat"
        ? "http_sse_compat"
        : mode === "sse"
          ? "sse"
          : "streamable_http",
    );
    const client = createLangChainMcpClient({
      install: record,
      headers: { "X-Test-Key": "fixture-key" },
    });
    clients.push(client);
    const [tools, same] = await Promise.all([
      client.getTools(),
      client.getTools(),
    ]);
    assert.strictEqual(tools, same, "one connection for concurrent discovery");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, `mcp__${langChainMcpServerKey(record)}__echo`);
    assert.deepEqual(tools[0]?.metadata?.annotations, { readOnlyHint: true });
    const result = await tools[0]!.invoke({ value: "hello" });
    assert.ok(JSON.stringify(result).includes("hello"));
    assert.ok(
      fixture.seen.every((request) => request.custom === "fixture-key"),
    );
    if (mode === "compat") {
      assert.ok(
        fixture.seen.some(
          (request) => request.url === "/mcp" && request.method === "POST",
        ),
      );
      assert.ok(
        fixture.seen.some(
          (request) => request.url === "/mcp" && request.method === "GET",
        ),
      );
      assert.ok(
        fixture.seen.some(
          (request) => request.url === "/sse" && request.method === "GET",
        ),
      );
    }
    await client.close();
    await assert.rejects(client.getTools(), /closed/);
  });
}

test("development MCP transport discovers and calls an unlisted local service", async () => {
  const fixture = await httpFixture("http");
  settings.endpointAddressChecksEnabled = false;
  settings.mcpAllowedInternalOrigins = [];
  const client = createLangChainMcpClient({
    install: install(`${fixture.origin}/mcp`, "streamable_http"),
  });
  clients.push(client);
  const tools = await client.getTools();
  assert.equal(tools.length, 1);
  assert.ok(
    JSON.stringify(await tools[0]!.invoke({ value: "development" })).includes(
      "development",
    ),
  );
});

test("pure OAuth SSE without custom headers sends the user's token on GET and POST", async () => {
  const fixture = await httpFixture("sse", "oauth-user-token");
  const provider = new McpOAuthClientProvider({
    issuer: fixture.origin,
    redirectUrl: `${fixture.origin}/callback`,
    clientName: "test",
    configuredClients: {},
    store: {
      loadClientInformation: async () => undefined,
      saveClientInformation: async () => {},
      loadTokens: async () => ({
        access_token: "oauth-user-token",
        token_type: "Bearer",
      }),
      saveTokens: async () => {},
      loadCodeVerifier: async () => undefined,
      saveCodeVerifier: async () => {},
      loadState: async () => undefined,
      saveState: async () => {},
    },
  });
  const client = createLangChainMcpClient({
    install: { ...install(`${fixture.origin}/sse`, "sse"), authType: "oauth" },
    authProvider: provider,
  });
  clients.push(client);
  const tools = await client.getTools();
  await tools[0]!.invoke({ value: "oauth hello" });
  assert.ok(fixture.seen.some((request) => request.method === "GET"));
  assert.ok(fixture.seen.some((request) => request.method === "POST"));
  assert.ok(
    fixture.seen.every(
      (request) => request.authorization === "Bearer oauth-user-token",
    ),
  );
});

test("runtime OAuth refresh on 401 uses the controlled transport and stores the replacement token", async () => {
  const fixture = await httpFixture("sse", "fresh-token", true);
  let tokens: OAuthTokens = {
    access_token: "expired-token",
    refresh_token: "fixture-refresh",
    token_type: "Bearer",
  };
  const provider = new McpOAuthClientProvider({
    issuer: fixture.origin,
    redirectUrl: `${fixture.origin}/callback`,
    clientName: "test",
    configuredClients: { [fixture.origin]: { clientId: "test-client" } },
    store: {
      loadClientInformation: async () => undefined,
      saveClientInformation: async () => {},
      loadTokens: async () => tokens,
      saveTokens: async (next) => {
        tokens = next;
      },
      loadCodeVerifier: async () => undefined,
      saveCodeVerifier: async () => {},
      loadState: async () => undefined,
      saveState: async () => {},
    },
  });
  const client = createLangChainMcpClient({
    install: { ...install(`${fixture.origin}/sse`, "sse"), authType: "oauth" },
    authProvider: provider,
  });
  clients.push(client);
  const tools = await client.getTools();
  await tools[0]!.invoke({ value: "after refresh" });
  assert.equal(tokens.access_token, "fresh-token");
  assert.equal(
    fixture.seen.filter((request) => request.url === "/token").length,
    1,
  );
  assert.ok(
    fixture.seen.some(
      (request) =>
        request.url === "/sse" &&
        request.authorization === "Bearer expired-token",
    ),
  );
  assert.ok(
    fixture.seen.some(
      (request) =>
        request.url?.startsWith("/messages") &&
        request.authorization === "Bearer fresh-token",
    ),
  );
});

test("streamable_http never silently selects SSE on a 4xx", async () => {
  const fixture = await httpFixture("compat");
  const client = createLangChainMcpClient({
    install: install(`${fixture.origin}/mcp`, "streamable_http"),
  });
  clients.push(client);
  await assert.rejects(client.getTools());
  assert.ok(!fixture.seen.some((request) => request.url === "/sse"));
});

test("unlisted internal endpoint is refused before any protocol request or fallback", async () => {
  const fixture = await httpFixture("compat");
  settings.mcpAllowedInternalOrigins = [];
  const client = createLangChainMcpClient({
    install: install(`${fixture.origin}/mcp`, "http_sse_compat"),
  });
  clients.push(client);
  await assert.rejects(client.getTools(), /HTTPS|deployment|allowed/);
  assert.equal(fixture.seen.length, 0);
});
