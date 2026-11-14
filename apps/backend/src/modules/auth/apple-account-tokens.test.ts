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
vi.mock("../../shared/config", () => ({
  config: {
    modelGatewayEncryptionSecret: "test-model-secret-at-least-32-chars",
    auth: {
      appleAppBundleId: "",
      appleTeamId: "",
      appleKeyId: "",
      applePrivateKey: "",
    },
  },
}));

const tokens = await import("./apple-account-tokens");

beforeEach(() => {
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
