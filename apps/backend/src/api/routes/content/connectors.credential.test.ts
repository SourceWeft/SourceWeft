import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { checkConnectorConfigRequestSchema } from "@sourceweft/contracts";
import { createWorkspaceRouteTestApp, readJson } from "../../../test/hono";
import { ApiError, toApiError } from "../../response/api-response";
import { logApiError } from "../../response/log-api-error";
import { logger } from "../../../shared/logger";

const mocks = vi.hoisted(() => ({
  getSessionUserId: vi.fn(),
  requireSession: vi.fn(),
  checkConfigReadiness: vi.fn(),
  createConnector: vi.fn(),
  rotateConnectorCredential: vi.fn(),
}));

vi.mock("../../middleware/auth-session", () => ({
  getSessionUserId: mocks.getSessionUserId,
  requireSession: mocks.requireSession,
}));
vi.mock("../../../modules/connectors", () => ({
  connectorService: {
    checkConfigReadiness: mocks.checkConfigReadiness,
    createConnector: mocks.createConnector,
    rotateConnectorCredential: mocks.rotateConnectorCredential,
  },
}));

import { registerConnectorRoutes } from "./connectors";

const SECRET = "app-password-DO-NOT-LOG-5a7c";
const app = () => createWorkspaceRouteTestApp(registerConnectorRoutes);
const base = "/v1/workspaces/workspace_1/connectors";

function signedIn() {
  vi.resetAllMocks();
  mocks.getSessionUserId.mockReturnValue("user_1");
  mocks.requireSession.mockResolvedValue({
    user: { id: "user_1", email: "u@example.com", name: "U" },
    session: { id: "s", userId: "user_1" },
  });
}

function request(path: string, method: string, payload: unknown) {
  return app().request(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("check forwards the credential to the service", async () => {
  signedIn();
  mocks.checkConfigReadiness.mockResolvedValue({ ready: true });

  const response = await request("/check", "POST", {
    connectorType: "webdav",
    configJson: { endpoint: "https://dav.example.com/" },
    credential: { username: "dav-user", secret: SECRET },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(mocks.checkConfigReadiness.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    connectorType: "webdav",
    configJson: { endpoint: "https://dav.example.com/" },
    credential: { username: "dav-user", secret: SECRET },
  });
});

test("create forwards the credential to the service", async () => {
  signedIn();
  mocks.createConnector.mockResolvedValue({ connector: { id: "c" } });

  const response = await request("", "POST", {
    connectorType: "webdav",
    name: "WebDAV",
    configJson: { endpoint: "https://dav.example.com/" },
    credential: { username: "dav-user", secret: SECRET },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(mocks.createConnector.mock.calls[0]?.[0].credential, {
    username: "dav-user",
    secret: SECRET,
  });
});

test("rotate requires a session", async () => {
  vi.resetAllMocks();
  mocks.requireSession.mockResolvedValue(null);

  const response = await request("/conn_1/credential", "PUT", {
    username: "dav-user",
    secret: SECRET,
  });

  assert.equal(response.status, 401);
  assert.equal(mocks.rotateConnectorCredential.mock.calls.length, 0);
});

test("rotate rejects an invalid body without reaching the service", async () => {
  signedIn();

  const response = await request("/conn_1/credential", "PUT", {
    username: "dav-user",
  });

  assert.equal(response.status, 400);
  assert.equal((await readJson(response)).code, "VALIDATION_ERROR");
  assert.equal(mocks.rotateConnectorCredential.mock.calls.length, 0);
});

test("rotate calls the service and returns the credential status uncached", async () => {
  signedIn();
  mocks.rotateConnectorCredential.mockResolvedValue({
    credentialConfigured: true,
    displayName: "dav-user",
  });

  const response = await request("/conn_1/credential", "PUT", {
    username: "dav-user",
    secret: SECRET,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await readJson(response), {
    credentialConfigured: true,
    displayName: "dav-user",
  });
  assert.deepEqual(mocks.rotateConnectorCredential.mock.calls[0]?.[0], {
    workspaceId: "workspace_1",
    userId: "user_1",
    connectorId: "conn_1",
    credential: { username: "dav-user", secret: SECRET },
  });
});

test("a validation-rejected check body never returns the secret", async () => {
  signedIn();

  // configJson is required: this body fails validation while carrying a secret.
  const response = await request("/check", "POST", {
    connectorType: "webdav",
    credential: { username: "dav-user", secret: SECRET },
  });

  assert.equal(response.status, 400);
  const bodyText = JSON.stringify(await readJson(response));
  assert.ok(!bodyText.includes(SECRET));
  assert.equal(mocks.checkConfigReadiness.mock.calls.length, 0);
});

test("the error log and error body for a failed check carry no secret", () => {
  // The zod flatten that becomes the validation error body, and everything the
  // error handler logs for it, must be free of the secret.
  const parsed = checkConnectorConfigRequestSchema.safeParse({
    connectorType: "",
    configJson: {},
    credential: { username: "dav-user", secret: SECRET },
  });
  assert.equal(parsed.success, false);
  const flatten = parsed.success
    ? {}
    : (parsed.error.flatten() as Record<string, unknown>);
  assert.ok(!JSON.stringify(flatten).includes(SECRET));

  const apiError = ApiError.validation(flatten);
  // The body returned to the client.
  assert.ok(
    !JSON.stringify({
      code: apiError.code,
      message: apiError.message,
      details: apiError.details,
    }).includes(SECRET),
  );

  // The error handler's log output, captured through the real logger.
  const info = vi.spyOn(logger, "info");
  const error = vi.spyOn(logger, "error");
  logApiError({
    method: "POST",
    pathname: "/v1/workspaces/workspace_1/connectors/check",
    userAgent: "vitest",
    apiError,
    error: parsed.success ? new Error("unreachable") : parsed.error,
  });
  // Also run the branch for a 5xx connector-style error, with its own message.
  const serverError = toApiError(
    new ApiError(500, "CONNECTOR_CREDENTIAL_REQUIRED", "A secret is required"),
  );
  logApiError({
    method: "PUT",
    pathname: "/v1/workspaces/workspace_1/connectors/conn_1/credential",
    userAgent: "vitest",
    apiError: serverError,
    error: serverError,
  });

  const logged = [...info.mock.calls, ...error.mock.calls]
    .map((call) => JSON.stringify(call))
    .join("\n");
  assert.ok(!logged.includes(SECRET));

  info.mockRestore();
  error.mockRestore();
});
