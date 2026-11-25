import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));
vi.mock("../../../modules/connectors", () => ({
  connectorCredentialFlowService: {
    start: mocks.start,
    poll: mocks.poll,
    cancel: mocks.cancel,
  },
}));

import { registerConnectorRoutes } from "./connectors";

const SERVER = "https://cloud.example.com";
const FLOW_ID = "flow-id-0123456789abcdef";
const app = () => createWorkspaceRouteTestApp(registerConnectorRoutes);
const base = "/v1/workspaces/workspace_1/connectors/nextcloud/credential-flow";

function request(path: string, method: string, payload?: unknown) {
  return app().request(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function signedIn() {
  mocks.getSessionUserId.mockReturnValue("user_1");
  mocks.requireSession.mockResolvedValue({
    user: { id: "user_1", email: "u@example.com", name: "U" },
    session: { id: "s", userId: "user_1" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

test("start requires a session", async () => {
  mocks.requireSession.mockResolvedValue(null);
  const response = await request("/start", "POST", {
    serverUrl: SERVER,
    name: "My Nextcloud",
  });
  assert.equal(response.status, 401);
  assert.equal(mocks.start.mock.calls.length, 0);
});

test("start rejects an invalid body without reaching the service", async () => {
  signedIn();
  // `name` is required.
  const response = await request("/start", "POST", { serverUrl: SERVER });
  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "VALIDATION_ERROR");
  assert.equal(mocks.start.mock.calls.length, 0);
});

test("start forwards the fields to the service and returns flowId + loginUrl uncached", async () => {
  signedIn();
  mocks.start.mockResolvedValue({
    flowId: FLOW_ID,
    loginUrl: `${SERVER}/index.php/login/v2/flow/abc`,
  });

  const response = await request("/start", "POST", {
    serverUrl: SERVER,
    name: "My Nextcloud",
    roots: ["/Docs/"],
    periodicIndexingEnabled: true,
    connectorId: "conn_1",
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson(response), {
    flowId: FLOW_ID,
    loginUrl: `${SERVER}/index.php/login/v2/flow/abc`,
  });
  assert.deepEqual(mocks.start.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    connectorType: "nextcloud",
    serverUrl: SERVER,
    name: "My Nextcloud",
    roots: ["/Docs/"],
    periodicIndexingEnabled: true,
    connectorId: "conn_1",
  });
});

test("start rejects an unknown field (strict body) and never returns it", async () => {
  signedIn();
  const response = await request("/start", "POST", {
    serverUrl: SERVER,
    name: "My Nextcloud",
    appPassword: "should-not-be-accepted",
  });
  assert.equal(response.status, 400);
  const bodyText = JSON.stringify(await readJson(response));
  assert.ok(!bodyText.includes("should-not-be-accepted"));
  assert.equal(mocks.start.mock.calls.length, 0);
});

test("poll requires a session", async () => {
  mocks.requireSession.mockResolvedValue(null);
  const response = await request("/poll", "POST", { flowId: FLOW_ID });
  assert.equal(response.status, 401);
  assert.equal(mocks.poll.mock.calls.length, 0);
});

test("poll forwards the flowId and returns the status uncached", async () => {
  signedIn();
  mocks.poll.mockResolvedValue({ status: "pending" });

  const response = await request("/poll", "POST", { flowId: FLOW_ID });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson(response), { status: "pending" });
  assert.deepEqual(mocks.poll.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    connectorType: "nextcloud",
    flowId: FLOW_ID,
  });
});

test("poll rejects a body with an unknown field without reaching the service", async () => {
  signedIn();
  const response = await request("/poll", "POST", {
    flowId: FLOW_ID,
    token: "extra",
  });
  assert.equal(response.status, 400);
  assert.equal(mocks.poll.mock.calls.length, 0);
});

test("cancel requires a session", async () => {
  mocks.requireSession.mockResolvedValue(null);
  const response = await request(`/${FLOW_ID}`, "DELETE");
  assert.equal(response.status, 401);
  assert.equal(mocks.cancel.mock.calls.length, 0);
});

test("cancel forwards the flowId from the path and returns the result", async () => {
  signedIn();
  mocks.cancel.mockResolvedValue({ canceled: true });

  const response = await request(`/${FLOW_ID}`, "DELETE");

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { canceled: true });
  assert.deepEqual(mocks.cancel.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    connectorType: "nextcloud",
    flowId: FLOW_ID,
  });
});
