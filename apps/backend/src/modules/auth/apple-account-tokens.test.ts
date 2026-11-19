import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    accountId: string;
    refreshToken: string | null;
  }>,
  query: vi.fn(),
}));

vi.mock("@sourceweft/db", () => ({ database: { query: mocks.query } }));
const auth = vi.hoisted(() => ({
  appleAppBundleId: "",
  appleServicesId: "",
  appleTeamId: "",
  appleKeyId: "",
  applePrivateKey: "",
}));
const SECRET = "test-model-secret-at-least-32-chars";

vi.mock("../../shared/config", () => ({
  config: { modelGatewayEncryptionSecret: SECRET, auth },
}));

const tokens = await import("./apple-account-tokens");
const { decryptSecret } = await import("../../shared/secrets");

beforeEach(() => {
  auth.appleServicesId = "";
  mocks.rows = [];
  mocks.query.mockReset();
  mocks.query.mockImplementation(async () => ({ rows: mocks.rows }));
});

test("with Sign in with Apple off, a code is neither exchanged nor stored", async () => {
  const exchange = vi.fn();
  const revoke = vi.fn();
  assert.equal(tokens.appleKeySettings(), null);
  assert.deepEqual(
    await tokens.storeAppleRefreshToken("user-1", "code-1", {
      exchange,
      revoke,
    }),
    { kind: "disabled" },
  );
  assert.equal(exchange.mock.calls.length, 0);
  assert.equal(mocks.query.mock.calls.length, 0);
});

test("with Sign in with Apple off, an account without Apple rows deletes normally", async () => {
  const revoke = vi.fn();
  await tokens.revokeAppleTokensBeforeDelete("user-1", revoke);
  assert.equal(revoke.mock.calls.length, 0);
});

test("an Apple account on a server that cannot revoke blocks deletion instead of skipping it", async () => {
  mocks.rows = [{ id: "acc-1", accountId: "sub-1", refreshToken: "v1:x:y:z" }];
  const revoke = vi.fn();
  await assert.rejects(
    tokens.revokeAppleTokensBeforeDelete("user-1", revoke),
    (error: unknown) =>
      error instanceof Error &&
      (error as { status?: string }).status === "SERVICE_UNAVAILABLE" &&
      /not set up to revoke/.test(error.message),
  );
  assert.equal(revoke.mock.calls.length, 0);
});

test("a web sign-in's refresh token is sealed with the Services ID before it is written", () => {
  auth.appleServicesId = "com.sourceweft.web";
  for (const path of ["/callback/:id", "/callback/apple"]) {
    const data: Record<string, unknown> = {
      providerId: "apple",
      accountId: "sub-1",
      accessToken: "access-1",
      refreshToken: "refresh-web",
      idToken: "id-token",
    };
    tokens.protectAppleAccountWrite(data, { path });
    assert.equal("accessToken" in data, false);
    assert.equal(data.idToken, "id-token");
    assert.equal(typeof data.refreshToken, "string");
    assert.ok(!(data.refreshToken as string).includes("refresh-web"));
    assert.deepEqual(
      JSON.parse(decryptSecret(data.refreshToken as string, SECRET)),
      { clientId: "com.sourceweft.web", token: "refresh-web" },
    );
    assert.deepEqual(
      tokens.openAppleRefreshToken(data.refreshToken as string, "bundle"),
      { clientId: "com.sourceweft.web", refreshToken: "refresh-web" },
    );
  }
});

test("a refresh token from anywhere but the OAuth callback is never stored", () => {
  auth.appleServicesId = "com.sourceweft.web";
  for (const context of [{ path: "/sign-in/social" }, null, undefined]) {
    const data: Record<string, unknown> = {
      providerId: "apple",
      accessToken: "client-access",
      refreshToken: "client-supplied",
    };
    tokens.protectAppleAccountWrite(data, context);
    assert.deepEqual(data, { providerId: "apple" });
  }
  // Without web sign-in configured there is no client to seal it for.
  auth.appleServicesId = "";
  const data: Record<string, unknown> = {
    providerId: "apple",
    refreshToken: "refresh-web",
  };
  tokens.protectAppleAccountWrite(data, { path: "/callback/:id" });
  assert.deepEqual(data, { providerId: "apple" });
});

test("other providers' account writes are left alone", () => {
  auth.appleServicesId = "com.sourceweft.web";
  const data = {
    providerId: "google",
    accessToken: "access",
    refreshToken: "refresh",
  };
  tokens.protectAppleAccountWrite(data, { path: "/callback/:id" });
  assert.deepEqual(data, {
    providerId: "google",
    accessToken: "access",
    refreshToken: "refresh",
  });
});

test("a token stored before the client was recorded belongs to the iOS app", async () => {
  const { encryptSecret } = await import("../../shared/secrets");
  assert.deepEqual(
    tokens.openAppleRefreshToken(
      encryptSecret("legacy-refresh", SECRET),
      "nicelab.sourceweft.mobile",
    ),
    { clientId: "nicelab.sourceweft.mobile", refreshToken: "legacy-refresh" },
  );
});
