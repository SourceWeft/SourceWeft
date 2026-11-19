import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/**
 * Apple refresh tokens against real PostgreSQL (Better Auth's `account`
 * table): stored encrypted on the signed-in user's own Apple row, never on
 * another user's, and revoked before an account is deleted, with every
 * failure aborting the deletion. Apple itself is a fake; nothing leaves the
 * machine.
 */

let schema: typeof import("@sourceweft/db");
let tokens: typeof import("./apple-account-tokens");
let appleErrors: typeof import("./apple-tokens");
let secrets: typeof import("../../shared/secrets");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const saved: Record<string, string | undefined> = {};
const VARS = {
  DATABASE_URL: "",
  AUTH_APPLE_APP_BUNDLE_ID: "nicelab.sourceweft.mobile",
  AUTH_APPLE_SERVICES_ID: "com.sourceweft.web",
  AUTH_APPLE_TEAM_ID: "TEAM123456",
  AUTH_APPLE_KEY_ID: "KEY1234567",
  AUTH_APPLE_PRIVATE_KEY: generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
};

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("apple_tokens");
  VARS.DATABASE_URL = isolated.url;
  for (const [name, value] of Object.entries(VARS)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  schema = await import("@sourceweft/db");
  tokens = await import("./apple-account-tokens");
  appleErrors = await import("./apple-tokens");
  secrets = await import("../../shared/secrets");
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function user(appleSubject?: string) {
  const id = `apple-user-${randomUUID()}`;
  await schema.database.query(
    `insert into "user" (id, name, email, "emailVerified") values ($1, 'Apple test', $2, true)`,
    [id, `${id}@example.test`],
  );
  if (appleSubject) {
    await schema.database.query(
      `insert into "account" (id, "accountId", "providerId", "userId", "updatedAt")
       values ($1, $2, 'apple', $3, now())`,
      [randomUUID(), appleSubject, id],
    );
  }
  return id;
}

async function storedToken(userId: string) {
  const result = await schema.database.query<{ refreshToken: string | null }>(
    `select "refreshToken" from "account" where "userId" = $1 and "providerId" = 'apple'`,
    [userId],
  );
  return result.rows[0]?.refreshToken ?? null;
}

function fakeApple(subject: string, refreshToken = "refresh-1") {
  const revoked: string[] = [];
  return {
    revoked,
    deps: {
      exchange: async () => ({ refreshToken, subject }),
      revoke: async (_settings: unknown, token: string) => {
        revoked.push(token);
      },
    },
  };
}

test("the refresh token is stored encrypted on the signed-in user's Apple account", async () => {
  const subject = `sub-${randomUUID()}`;
  const userId = await user(subject);
  const apple = fakeApple(subject, "refresh-1");

  assert.deepEqual(
    await tokens.storeAppleRefreshToken(userId, "code-1", apple.deps),
    { kind: "stored" },
  );
  const stored = await storedToken(userId);
  assert.ok(stored);
  assert.notEqual(stored, "refresh-1");
  assert.deepEqual(tokens.openAppleRefreshToken(stored, "unused"), {
    clientId: "nicelab.sourceweft.mobile",
    refreshToken: "refresh-1",
  });
  assert.deepEqual(apple.revoked, []);

  // A later sign-in replaces it with the newest token.
  await tokens.storeAppleRefreshToken(
    userId,
    "code-2",
    fakeApple(subject, "refresh-2").deps,
  );
  assert.equal(
    tokens.openAppleRefreshToken((await storedToken(userId))!, "unused")
      .refreshToken,
    "refresh-2",
  );
});

test("a code for an Apple ID the user has not linked stores nothing and revokes the new grant", async () => {
  const ownSubject = `sub-${randomUUID()}`;
  const otherSubject = `sub-${randomUUID()}`;
  const userId = await user(ownSubject);
  const otherUserId = await user(otherSubject);
  const apple = fakeApple(otherSubject, "refresh-stray");

  assert.deepEqual(
    await tokens.storeAppleRefreshToken(userId, "code-1", apple.deps),
    { kind: "not_linked" },
  );
  assert.deepEqual(apple.revoked, ["refresh-stray"]);
  assert.equal(await storedToken(userId), null);
  assert.equal(await storedToken(otherUserId), null);
});

test("deleting an account without Apple sign-in calls Apple not at all", async () => {
  const userId = await user();
  const revoked: string[] = [];
  await tokens.revokeAppleTokensBeforeDelete(userId, async (_s, token) => {
    revoked.push(token);
  });
  assert.deepEqual(revoked, []);
});

test("deleting an account revokes its stored Apple refresh token", async () => {
  const subject = `sub-${randomUUID()}`;
  const userId = await user(subject);
  await tokens.storeAppleRefreshToken(
    userId,
    "code-1",
    fakeApple(subject, "refresh-to-revoke").deps,
  );
  const revoked: string[] = [];
  await tokens.revokeAppleTokensBeforeDelete(userId, async (_s, token) => {
    revoked.push(token);
  });
  assert.deepEqual(revoked, ["refresh-to-revoke"]);
});

async function setStoredToken(userId: string, value: string) {
  await schema.database.query(
    `update "account" set "refreshToken" = $1 where "userId" = $2 and "providerId" = 'apple'`,
    [value, userId],
  );
}

test("deleting revokes each token as the client it was issued to", async () => {
  // Web: written by Better Auth's callback through the account hook.
  const webUser = await user(`sub-${randomUUID()}`);
  const row: Record<string, unknown> = {
    providerId: "apple",
    refreshToken: "refresh-web",
  };
  tokens.protectAppleAccountWrite(row, { path: "/callback/:id" });
  await setStoredToken(webUser, row.refreshToken as string);

  // Legacy: a bare encrypted token from before the client was recorded.
  const legacyUser = await user(`sub-${randomUUID()}`);
  await setStoredToken(
    legacyUser,
    secrets.encryptSecret(
      "refresh-legacy",
      process.env.MODEL_GATEWAY_ENCRYPTION_SECRET!,
    ),
  );

  for (const [userId, expected] of [
    [webUser, { clientId: "com.sourceweft.web", token: "refresh-web" }],
    [
      legacyUser,
      { clientId: "nicelab.sourceweft.mobile", token: "refresh-legacy" },
    ],
  ] as const) {
    const calls: Array<{ clientId: string; token: string }> = [];
    await tokens.revokeAppleTokensBeforeDelete(userId, async (s, token) => {
      calls.push({ clientId: s.clientId, token });
    });
    assert.deepEqual(calls, [expected]);
  }
});

test("an Apple account without a stored token blocks deletion until the person signs in again", async () => {
  const userId = await user(`sub-${randomUUID()}`);
  await assert.rejects(
    tokens.revokeAppleTokensBeforeDelete(userId, async () => {}),
    (error: unknown) =>
      error instanceof Error &&
      /Sign in with Apple again/.test(error.message) &&
      (error as { status?: string }).status === "BAD_REQUEST",
  );
});

test("Apple failing to revoke aborts the deletion; an already revoked token does not", async () => {
  const subject = `sub-${randomUUID()}`;
  const userId = await user(subject);
  await tokens.storeAppleRefreshToken(
    userId,
    "code-1",
    fakeApple(subject).deps,
  );

  await assert.rejects(
    tokens.revokeAppleTokensBeforeDelete(userId, async () => {
      throw new appleErrors.AppleTokenError("down", "network", 0);
    }),
    (error: unknown) =>
      error instanceof Error &&
      /Nothing was deleted/.test(error.message) &&
      (error as { status?: string }).status === "SERVICE_UNAVAILABLE",
  );

  await tokens.revokeAppleTokensBeforeDelete(userId, async () => {
    throw new appleErrors.AppleTokenError("gone", "invalid_grant", 400);
  });
});
