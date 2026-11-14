import assert from "node:assert/strict";
import { Hono } from "hono";
import { beforeEach, test, vi } from "vitest";
import { AppleTokenError } from "../../modules/auth/apple-tokens";

const mocks = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  store: vi.fn(),
}));

vi.mock("../middleware/auth-session", () => ({
  requireSession: async () => mocks.session,
  getSessionUserId: (session: { user: { id: string } }) => session.user.id,
}));
vi.mock("../../modules/auth/apple-account-tokens", () => ({
  storeAppleRefreshToken: mocks.store,
}));

const { registerAuthAppleRoutes } = await import("./auth-apple");

function post(body: unknown) {
  const app = new Hono();
  registerAuthAppleRoutes(app);
  return app.request("http://localhost/v1/auth/apple/authorization-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function codeOf(response: Response) {
  return ((await response.json()) as { code?: string }).code;
}

beforeEach(() => {
  mocks.session = { user: { id: "user-1" } };
  mocks.store.mockReset();
});

test("signed-out requests are refused before Apple is contacted", async () => {
  mocks.session = null;
  const response = await post({ code: "code-1" });
  assert.equal(response.status, 401);
  assert.equal(mocks.store.mock.calls.length, 0);
});

test("a missing, empty or oversized code is a validation error", async () => {
  for (const body of [
    {},
    { code: "" },
    { code: "x".repeat(2049) },
    "not json",
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal(await codeOf(response), "VALIDATION_ERROR");
  }
  assert.equal(mocks.store.mock.calls.length, 0);
});

test("a code for the signed-in user is stored", async () => {
  mocks.store.mockResolvedValue({ kind: "stored" });
  const response = await post({ code: " code-1 " });
  assert.equal(response.status, 200);
  assert.deepEqual(mocks.store.mock.calls[0]!.slice(0, 2), [
    "user-1",
    "code-1",
  ]);
});

test("each outcome maps to its own status and code", async () => {
  const cases: Array<[unknown, number, string]> = [
    [{ kind: "disabled" }, 404, "APPLE_SIGN_IN_DISABLED"],
    [{ kind: "not_linked" }, 409, "APPLE_ACCOUNT_NOT_LINKED"],
    [
      new AppleTokenError("refused", "invalid_grant", 400),
      400,
      "APPLE_AUTHORIZATION_CODE_REJECTED",
    ],
    [new AppleTokenError("offline", "network", 0), 502, "APPLE_UNAVAILABLE"],
    [new AppleTokenError("down", "unknown", 503), 502, "APPLE_UNAVAILABLE"],
  ];
  for (const [outcome, status, code] of cases) {
    mocks.store.mockReset();
    if (outcome instanceof Error) mocks.store.mockRejectedValue(outcome);
    else mocks.store.mockResolvedValue(outcome);
    const response = await post({ code: "code-1" });
    assert.equal(response.status, status, code);
    assert.equal(await codeOf(response), code);
  }
});
