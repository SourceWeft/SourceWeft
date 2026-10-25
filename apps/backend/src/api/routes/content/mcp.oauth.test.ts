import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { McpError } from "../../../modules/mcp/errors";
import {
  createRouteTestApp,
  createWorkspaceRouteTestApp,
  readJson,
} from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  completeMcpOAuthCallback: vi.fn(),
  discoverToolsForMember: vi.fn(),
  findMcpOAuthCompletion: vi.fn(),
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
  startMcpOAuthAuthorization: vi.fn(),
}));

vi.mock("../../../shared/config", () => ({
  config: { auth: { webBaseUrl: "https://app.sourceweft.test" } },
}));
vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));
vi.mock("../../../modules/mcp", () => ({
  mcpService: { discoverToolsForMember: mocks.discoverToolsForMember },
}));
vi.mock("../../../modules/mcp/oauth-service", () => ({
  completeMcpOAuthCallback: mocks.completeMcpOAuthCallback,
  startMcpOAuthAuthorization: mocks.startMcpOAuthAuthorization,
}));
vi.mock("../../../modules/mcp/oauth-repository", () => ({
  findMcpOAuthCompletion: mocks.findMcpOAuthCompletion,
}));

import { registerMcpOAuthCallbackRoutes, registerMcpRoutes } from "./mcp";

const callbackApp = () => createRouteTestApp(registerMcpOAuthCallbackRoutes);
const workspaceApp = () => createWorkspaceRouteTestApp(registerMcpRoutes);
const WEB = "https://app.sourceweft.test";

function reset() {
  vi.clearAllMocks();
  mocks.getSessionUserId.mockReturnValue("user_1");
  mocks.requireSession.mockResolvedValue({
    user: { id: "user_1" },
    session: { id: "s", userId: "user_1" },
  });
}

async function callback(query: string) {
  const response = await callbackApp().request(`/v1/mcp/oauth/callback?${query}`);
  assert.equal(response.status, 302);
  return response.headers.get("location");
}

test("a connected callback returns to the stored destination with a completion reference only", async () => {
  reset();
  mocks.completeMcpOAuthCallback.mockResolvedValue({
    outcome: "connected",
    returnTo: "/dashboard/mcp/io.github.o%2Fexample",
    completionRef: "a".repeat(32),
  });
  const location = await callback("code=c1&state=s1&returnTo=https://evil.example");
  assert.equal(
    location,
    `${WEB}/dashboard/mcp/io.github.o%2Fexample?mcpOAuth=connected&mcpRef=${"a".repeat(32)}`,
  );
  // Only the state, the code and the provider's error are read from the request.
  assert.deepEqual(mocks.completeMcpOAuthCallback.mock.calls[0]?.[0], {
    state: "s1",
    code: "c1",
    providerError: undefined,
    sessionUserId: "user_1",
  });
});

test("denials and failures return to the stored destination with a fixed reason", async () => {
  reset();
  mocks.completeMcpOAuthCallback.mockResolvedValue({
    outcome: "denied",
    returnTo: "/dashboard/mcp/io.github.o%2Fexample",
    reason: "denied",
  });
  assert.equal(
    await callback("error=access_denied&state=s1"),
    `${WEB}/dashboard/mcp/io.github.o%2Fexample?mcpOAuth=error&mcpReason=denied`,
  );
  assert.equal(
    mocks.completeMcpOAuthCallback.mock.calls[0]?.[0].providerError,
    "access_denied",
  );
});

test("an unknown, expired or replayed state goes to the fixed safe page", async () => {
  reset();
  mocks.completeMcpOAuthCallback.mockResolvedValue({ outcome: "invalid" });
  assert.equal(
    await callback("code=c1&state=s1"),
    `${WEB}/dashboard/mcp?mcpOAuth=invalid`,
  );
  // No state at all never reaches the service.
  mocks.completeMcpOAuthCallback.mockClear();
  assert.equal(await callback("code=c1"), `${WEB}/dashboard/mcp?mcpOAuth=invalid`);
  assert.equal(mocks.completeMcpOAuthCallback.mock.calls.length, 0);
});

test("an unexpected failure in the callback also lands on the fixed page", async () => {
  reset();
  mocks.completeMcpOAuthCallback.mockRejectedValue(new Error("db down"));
  assert.equal(
    await callback("code=c1&state=s1"),
    `${WEB}/dashboard/mcp?mcpOAuth=invalid`,
  );
});

test("GET /v1/mcp/oauth/completions/:ref resolves only for the signed-in member", async () => {
  reset();
  mocks.findMcpOAuthCompletion.mockResolvedValue({
    workspaceId: "workspace_1",
    installId: "install_1",
  });
  const response = await callbackApp().request(
    `/v1/mcp/oauth/completions/${"b".repeat(32)}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    workspaceId: "workspace_1",
    installId: "install_1",
  });
  assert.deepEqual(mocks.findMcpOAuthCompletion.mock.calls[0]?.[0], {
    userId: "user_1",
    ref: "b".repeat(32),
  });

  mocks.findMcpOAuthCompletion.mockResolvedValue(null);
  assert.equal(
    (await callbackApp().request(`/v1/mcp/oauth/completions/${"c".repeat(32)}`))
      .status,
    404,
  );
  mocks.requireSession.mockResolvedValue(null);
  assert.equal(
    (await callbackApp().request(`/v1/mcp/oauth/completions/${"b".repeat(32)}`))
      .status,
    401,
  );
});

test("POST /oauth/authorize forwards the validated-by-the-service returnTo", async () => {
  reset();
  mocks.startMcpOAuthAuthorization.mockResolvedValue({ status: "connected" });
  const response = await workspaceApp().request(
    "/v1/workspaces/workspace_1/mcp-installs/install_1/oauth/authorize",
    {
      method: "POST",
      body: JSON.stringify({ returnTo: "/dashboard/mcp" }),
      headers: { "content-type": "application/json" },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.startMcpOAuthAuthorization.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: "install_1",
    returnTo: "/dashboard/mcp",
  });
});

test("POST /oauth/authorize reports a refused destination and a timeout by code", async () => {
  reset();
  const path = "/v1/workspaces/workspace_1/mcp-installs/install_1/oauth/authorize";
  const post = () =>
    workspaceApp().request(path, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
  mocks.startMcpOAuthAuthorization.mockRejectedValue(
    new McpError(400, "MCP_OAUTH_RETURN_INVALID", "The return destination is not allowed"),
  );
  let response = await post();
  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "MCP_OAUTH_RETURN_INVALID");
  mocks.startMcpOAuthAuthorization.mockRejectedValue(
    new McpError(504, "MCP_OAUTH_TIMEOUT", "The MCP server's sign-in did not answer in time"),
  );
  response = await post();
  assert.equal(response.status, 504);
  assert.equal((await readJson(response)).code, "MCP_OAUTH_TIMEOUT");
});

test("POST /discover-tools forwards the member and requires a session", async () => {
  reset();
  const result = { tools: [], toolCount: 0, truncated: false, skippedOversize: 0 };
  mocks.discoverToolsForMember.mockResolvedValue(result);
  const path = "/v1/workspaces/workspace_1/mcp-installs/install_1/discover-tools";
  const response = await workspaceApp().request(path, { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), result);
  assert.deepEqual(mocks.discoverToolsForMember.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    installId: "install_1",
  });
  mocks.requireSession.mockResolvedValue(null);
  assert.equal(
    (await workspaceApp().request(path, { method: "POST", body: "{}" })).status,
    401,
  );
});
