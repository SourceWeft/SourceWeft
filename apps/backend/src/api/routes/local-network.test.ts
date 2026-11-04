import { Hono } from "hono";
import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: true,
  owned: vi.fn(),
  list: vi.fn(),
  respond: vi.fn(),
  setMode: vi.fn(),
  caller: vi.fn(),
}));
vi.mock("../middleware/auth-session", () => ({
  requireSession: async () =>
    state.session
      ? { user: { id: "owner" }, session: { id: "session" } }
      : null,
}));
vi.mock("../../modules/devices/access", () => ({
  resolveLocalCaller: async (...args: unknown[]) => {
    state.caller(...args);
    return { sessionId: "session", nativeAccessId: "native" };
  },
}));
vi.mock("../../modules/devices/service", () => ({
  ownedThread: async (...args: unknown[]) => {
    state.owned(...args);
    return { id: "t", workspaceId: "w" };
  },
}));
vi.mock("../../modules/devices/network-approvals", () => ({
  listPendingNetworkRequests: state.list,
  respondToNetworkRequest: state.respond,
  setDeviceNetworkMode: state.setMode,
}));
import { registerLocalNetworkRoutes } from "./local-network";

function app() {
  const server = new Hono();
  server.onError((error, c) =>
    c.json(
      { code: (error as { code?: string }).code },
      ((error as { statusCode?: number }).statusCode as 400) ?? 500,
    ),
  );
  registerLocalNetworkRoutes(server);
  return server;
}
const post = (server: Hono, path: string, body: unknown) =>
  server.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const respondPath = "/v1/workspaces/w/local-network-requests/r1/respond";

beforeEach(() => {
  state.session = true;
  vi.clearAllMocks();
  state.list.mockResolvedValue({ requests: [] });
  state.respond.mockResolvedValue({
    request: { id: "r1", status: "allowed", scope: "once" },
  });
  state.setMode.mockResolvedValue({ id: "pc", networkMode: "strict" });
});

test("listing is a live, uncached read of the caller's own conversation", async () => {
  const server = app();
  const response = await server.request(
    "/v1/workspaces/w/threads/t/network-requests",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(state.owned).toHaveBeenCalledWith("owner", "w", "t");
  expect(state.list).toHaveBeenCalledWith({
    userId: "owner",
    workspaceId: "w",
    threadId: "t",
  });
  state.session = false;
  expect(
    (await server.request("/v1/workspaces/w/threads/t/network-requests"))
      .status,
  ).toBe(401);
});

test("answering passes the decision and an optional TTL for the session's user only", async () => {
  const server = app();
  expect(
    (
      await post(server, respondPath, {
        decision: "allow_always",
        trust: { ttlSeconds: 3600 },
      })
    ).status,
  ).toBe(200);
  expect(state.respond).toHaveBeenLastCalledWith({
    userId: "owner",
    workspaceId: "w",
    requestId: "r1",
    decision: "allow_always",
    ttlSeconds: 3600,
  });
  await post(server, respondPath, { decision: "deny" });
  expect(state.respond).toHaveBeenLastCalledWith({
    userId: "owner",
    workspaceId: "w",
    requestId: "r1",
    decision: "deny",
  });
  state.session = false;
  expect((await post(server, respondPath, { decision: "deny" })).status).toBe(
    401,
  );
});

test("a client cannot choose the host, the user or an unknown decision", async () => {
  const server = app();
  state.respond.mockClear();
  for (const body of [
    { decision: "approve" },
    { decision: "allow_always", host: "evil.example" },
    { decision: "allow_always", trust: { host: "evil.example" } },
    { decision: "deny", userId: "someone-else" },
    { decision: "allow_always", trust: { ttlSeconds: -1 } },
    {},
    null,
  ])
    expect(
      (await post(server, respondPath, body)).status,
      JSON.stringify(body),
    ).toBe(400);
  expect(state.respond).not.toHaveBeenCalled();
});

test("the network mode is a validated per-computer setting that needs the native proof", async () => {
  const server = app();
  const patch = (body: unknown) =>
    server.request("/v1/local-devices/pc", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-local-proof": "proof" },
      body: JSON.stringify(body),
    });
  expect((await patch({ networkMode: "strict" })).status).toBe(200);
  expect(state.caller).toHaveBeenCalledWith("owner", "session", "proof");
  expect(state.setMode).toHaveBeenCalledWith({
    userId: "owner",
    deviceId: "pc",
    caller: { sessionId: "session", nativeAccessId: "native" },
    networkMode: "strict",
  });
  for (const body of [
    { networkMode: "all" },
    { networkMode: "open", name: "x" },
    {},
  ])
    expect((await patch(body)).status).toBe(400);
  expect(state.setMode).toHaveBeenCalledTimes(1);
  state.session = false;
  expect((await patch({ networkMode: "open" })).status).toBe(401);
});
