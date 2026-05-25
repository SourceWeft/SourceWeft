import assert from "node:assert/strict";
import { Hono } from "hono";
import { test, vi } from "vitest";
import { McpError } from "../../../modules/mcp/errors";
import { ApiError, ApiResponse, toApiError } from "../../response/api-response";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  listActionRuns: vi.fn(),
  listMarketMcpCategories: vi.fn(),
  listToolRuns: vi.fn(),
  deleteInstall: vi.fn(),
  installMarketMcp: vi.fn(),
  requireSession: vi.fn(),
  testInstall: vi.fn(),
  updateInstall: vi.fn(),
  upsertCredentials: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));

vi.mock("../../../modules/mcp", () => ({
  mcpService: {
    getMarketMcp: vi.fn(),
    deleteInstall: mocks.deleteInstall,
    installMarketMcp: mocks.installMarketMcp,
    listActionRuns: mocks.listActionRuns,
    listInstalls: vi.fn(),
    listMarketMcpCategories: mocks.listMarketMcpCategories,
    listMarketMcp: vi.fn(),
    listToolRuns: mocks.listToolRuns,
    testInstall: mocks.testInstall,
    updateInstall: mocks.updateInstall,
    upsertCredentials: mocks.upsertCredentials,
  },
}));

import { registerMcpRoutes } from "./mcp";

function createTestApp() {
  const app = new Hono();
  const workspaceRoutes = new Hono();
  registerMcpRoutes(workspaceRoutes);
  app.route("/v1/workspaces/:workspaceId", workspaceRoutes);
  app.notFound((c) => ApiResponse.error(c, ApiError.notFound()));
  app.onError((error, c) => ApiResponse.error(c, toApiError(error)));
  return app;
}

function resetRouteMocks() {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockReturnValue("user_1");
  mocks.requireSession.mockResolvedValue({
    user: {
      id: "user_1",
      email: "user@example.com",
      name: "User",
    },
    session: {
      id: "session_1",
      userId: "user_1",
    },
  });
}

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("MCP routes return unauthorized when there is no session", async () => {
  resetRouteMocks();
  mocks.requireSession.mockResolvedValue(null);

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/mcp-runs",
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await readJson(response), {
    code: "UNAUTHORIZED",
    message: "Unauthorized",
  });
  assert.equal(mocks.listToolRuns.mock.calls.length, 0);
});

test("GET /mcp-runs forwards workspace, user, cursor, and numeric limit", async () => {
  resetRouteMocks();
  mocks.listToolRuns.mockResolvedValue({
    items: [],
    nextCursor: null,
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/mcp-runs?limit=25&cursor=2026-01-01T00%3A00%3A00.000Z",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    items: [],
    nextCursor: null,
  });
  assert.deepEqual(mocks.listToolRuns.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    limit: 25,
    cursor: "2026-01-01T00:00:00.000Z",
  });
});

test("GET /mcp-action-runs ignores invalid limit values", async () => {
  resetRouteMocks();
  mocks.listActionRuns.mockResolvedValue({
    items: [],
    nextCursor: "next",
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/mcp-action-runs?limit=not-a-number&cursor=abc",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(mocks.listActionRuns.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    limit: undefined,
    cursor: "abc",
  });
});

test("POST /market/mcp/:identifier/install validates request body", async () => {
  resetRouteMocks();

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/market/mcp/github/install",
    {
      method: "POST",
      body: JSON.stringify({ version: 1 }),
      headers: { "content-type": "application/json" },
    },
  );

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "VALIDATION_ERROR");
  assert.equal(mocks.installMarketMcp.mock.calls.length, 0);
});

test("GET /market/mcp/categories forwards workspace and user", async () => {
  resetRouteMocks();
  mocks.listMarketMcpCategories.mockResolvedValue({
    items: [
      {
        id: "mcp-cat-browser-automation",
        slug: "browser-automation",
        name: "Browser Automation",
        description: "Browser control and automation.",
      },
    ],
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/market/mcp/categories",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    items: [
      {
        id: "mcp-cat-browser-automation",
        slug: "browser-automation",
        name: "Browser Automation",
        description: "Browser control and automation.",
      },
    ],
  });
  assert.deepEqual(mocks.listMarketMcpCategories.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
  });
  assert.equal(mocks.installMarketMcp.mock.calls.length, 0);
});

test("POST /market/mcp/:identifier/install decodes identifier and returns 201", async () => {
  resetRouteMocks();
  mocks.installMarketMcp.mockResolvedValue({
    install: {
      id: "mcp_install_1",
    },
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/market/mcp/github%2Fserver/install",
    {
      method: "POST",
      body: JSON.stringify({
        version: "1.2.3",
        endpointUrlOverride: "https://mcp.example.com/mcp",
      }),
      headers: { "content-type": "application/json" },
    },
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await readJson(response), {
    install: {
      id: "mcp_install_1",
    },
  });
  assert.deepEqual(mocks.installMarketMcp.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    identifier: "github/server",
    version: "1.2.3",
    endpointUrlOverride: "https://mcp.example.com/mcp",
  });
});

test("PATCH /mcp-installs/:installId validates toolIds", async () => {
  resetRouteMocks();

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/mcp-installs/mcp_install_1",
    {
      method: "PATCH",
      body: JSON.stringify({ enabled: true, toolIds: [1] }),
      headers: { "content-type": "application/json" },
    },
  );

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "VALIDATION_ERROR");
  assert.equal(mocks.updateInstall.mock.calls.length, 0);
});

test("DELETE /mcp-installs/:installId forwards workspace, user, and install", async () => {
  resetRouteMocks();
  mocks.deleteInstall.mockResolvedValue({
    deleted: true,
    installId: "mcp_install_1",
  });

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/mcp-installs/mcp_install_1",
    { method: "DELETE" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    deleted: true,
    installId: "mcp_install_1",
  });
  assert.deepEqual(mocks.deleteInstall.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: "mcp_install_1",
  });
});

test("POST /mcp-installs/:installId/credentials validates auth-specific payloads", async () => {
  resetRouteMocks();
  mocks.upsertCredentials.mockRejectedValue(
    new McpError(400, "MCP_CREDENTIAL_REQUIRED", "Bearer token is required"),
  );

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/mcp-installs/mcp_install_1/credentials",
    {
      method: "POST",
      body: JSON.stringify({ authType: "bearer" }),
      headers: { "content-type": "application/json" },
    },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await readJson(response), {
    code: "MCP_CREDENTIAL_REQUIRED",
    message: "Bearer token is required",
  });
  assert.deepEqual(mocks.upsertCredentials.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: "mcp_install_1",
    authType: "bearer",
  });
});

test("POST /mcp-installs/:installId/test maps MCP errors to API errors", async () => {
  resetRouteMocks();
  mocks.testInstall.mockRejectedValue(
    new McpError(403, "MCP_FORBIDDEN", "No MCP access"),
  );

  const response = await createTestApp().request(
    "/v1/workspaces/workspace_1/mcp-installs/mcp_install_1/test",
    {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await readJson(response), {
    code: "MCP_FORBIDDEN",
    message: "No MCP access",
  });
});
