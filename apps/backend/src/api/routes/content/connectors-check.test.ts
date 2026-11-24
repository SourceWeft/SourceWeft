import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
  checkConfigReadiness: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));
vi.mock("../../../modules/connectors", () => ({
  connectorService: { checkConfigReadiness: mocks.checkConfigReadiness },
}));

import { registerConnectorRoutes } from "./connectors";

const app = () => createWorkspaceRouteTestApp(registerConnectorRoutes);
const url = "/v1/workspaces/workspace_1/connectors/check";

function signedIn() {
  vi.resetAllMocks();
  mocks.getSessionUserId.mockReturnValue("user_1");
  mocks.requireSession.mockResolvedValue({
    user: { id: "user_1", email: "u@example.com", name: "U" },
    session: { id: "s", userId: "user_1" },
  });
}

function post(payload: unknown) {
  return app().request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("check returns 401 without a session and never reaches the service", async () => {
  vi.resetAllMocks();
  mocks.requireSession.mockResolvedValue(null);

  const response = await post({ connectorType: "rss", configJson: {} });

  assert.equal(response.status, 401);
  assert.equal(mocks.checkConfigReadiness.mock.calls.length, 0);
});

test("check returns 400 for an invalid body", async () => {
  signedIn();

  for (const payload of [
    { connectorType: "", configJson: {} },
    { connectorType: "rss" },
    { connectorType: "rss", configJson: "nope" },
  ]) {
    const response = await post(payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal((await readJson(response)).code, "VALIDATION_ERROR");
  }
  assert.equal(mocks.checkConfigReadiness.mock.calls.length, 0);
});

test("check passes the service result through uncached", async () => {
  signedIn();
  mocks.checkConfigReadiness.mockResolvedValue({
    ready: false,
    reason: "feed_timeout",
    message: "The feed did not respond in time.",
  });

  const response = await post({
    connectorType: " rss ",
    configJson: { feedUrl: "https://example.com/feed.xml" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson(response), {
    ready: false,
    reason: "feed_timeout",
    message: "The feed did not respond in time.",
  });
  assert.deepEqual(mocks.checkConfigReadiness.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    connectorType: "rss",
    configJson: { feedUrl: "https://example.com/feed.xml" },
  });
});
