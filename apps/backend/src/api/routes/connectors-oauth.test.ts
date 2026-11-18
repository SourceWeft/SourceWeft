import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createRouteTestApp, readJson } from "../../test/hono";

const mocks = vi.hoisted(() => ({
  usesBrokeredAuthorization: vi.fn(),
  getGlobalCallbackState: vi.fn(),
  finishGlobalCallback: vi.fn(),
}));

vi.mock("../../modules/connectors", () => ({
  connectorOAuthService: {
    usesBrokeredAuthorization: mocks.usesBrokeredAuthorization,
    getGlobalCallbackState: mocks.getGlobalCallbackState,
    finishGlobalCallback: mocks.finishGlobalCallback,
  },
}));

import { registerConnectorOAuthRoutes } from "./connectors-oauth";

const app = () => createRouteTestApp(registerConnectorOAuthRoutes);

function reset() {
  vi.resetAllMocks();
}

test("a brokered connector's failed-status callback redirects to the stored destination and stores nothing", async () => {
  reset();
  mocks.usesBrokeredAuthorization.mockReturnValue(true);
  mocks.getGlobalCallbackState.mockResolvedValue({
    connectorType: "composio_gmail",
    redirectAfter: "https://app.sourceweft.test/dashboard",
    workspaceId: "workspace_1",
  });

  const response = await app().request(
    "/v1/connectors/oauth/composio_gmail/callback?state=s1&status=failed",
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(
    location.origin + location.pathname,
    "https://app.sourceweft.test/dashboard",
  );
  assert.equal(location.searchParams.get("connector_oauth"), "error");
  assert.equal(location.searchParams.get("workspace_id"), "workspace_1");
  assert.equal(mocks.finishGlobalCallback.mock.calls.length, 0);
});

test("a brokered connector's successful callback needs no code and passes every query parameter through", async () => {
  reset();
  mocks.usesBrokeredAuthorization.mockReturnValue(true);
  mocks.finishGlobalCallback.mockResolvedValue({
    account: {
      id: "account_1",
      connectorType: "composio_gmail",
      workspaceId: "workspace_1",
    },
    redirectAfter: "https://app.sourceweft.test/dashboard",
  });

  const response = await app().request(
    "/v1/connectors/oauth/composio_gmail/callback?state=s1&status=success&connected_account_id=ca_1",
  );

  assert.equal(response.status, 302);
  assert.deepEqual(mocks.finishGlobalCallback.mock.calls[0]?.[0], {
    connectorType: "composio_gmail",
    state: "s1",
    callbackParams: {
      state: "s1",
      status: "success",
      connected_account_id: "ca_1",
    },
  });
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.searchParams.get("connector_oauth"), "success");
  assert.equal(location.searchParams.get("account_id"), "account_1");
});

test("a brokered connector's callback without a redirect returns the result directly", async () => {
  reset();
  mocks.usesBrokeredAuthorization.mockReturnValue(true);
  mocks.finishGlobalCallback.mockResolvedValue({
    account: {
      id: "account_1",
      connectorType: "composio_gmail",
      workspaceId: "workspace_1",
    },
    redirectAfter: null,
  });

  const response = await app().request(
    "/v1/connectors/oauth/composio_gmail/callback?state=s1&status=success",
  );

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal((body.account as { id: string }).id, "account_1");
});

test("an oauth2 connector's callback still fails without a code, as today", async () => {
  reset();
  mocks.usesBrokeredAuthorization.mockReturnValue(false);

  const response = await app().request(
    "/v1/connectors/oauth/notion/callback?state=s1",
  );

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.equal(body.code, "CONNECTOR_OAUTH_CALLBACK_INVALID");
  assert.equal(mocks.finishGlobalCallback.mock.calls.length, 0);
});

test("an oauth2 connector's callback with a code still exchanges it as today", async () => {
  reset();
  mocks.usesBrokeredAuthorization.mockReturnValue(false);
  mocks.finishGlobalCallback.mockResolvedValue({
    account: {
      id: "account_2",
      connectorType: "notion",
      workspaceId: "workspace_1",
    },
    redirectAfter: "https://app.sourceweft.test/dashboard",
  });

  const response = await app().request(
    "/v1/connectors/oauth/notion/callback?state=s1&code=c1",
  );

  assert.equal(response.status, 302);
  assert.deepEqual(mocks.finishGlobalCallback.mock.calls[0]?.[0], {
    connectorType: "notion",
    code: "c1",
    state: "s1",
  });
});

test("a missing state is rejected before checking whether the connector is brokered", async () => {
  reset();

  const response = await app().request(
    "/v1/connectors/oauth/notion/callback?code=c1",
  );

  assert.equal(response.status, 400);
  assert.equal(mocks.usesBrokeredAuthorization.mock.calls.length, 0);
});
