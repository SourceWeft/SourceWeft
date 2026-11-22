/**
 * Cross-connection proof: `ConnectorOAuthService.getRuntimeToken` against a
 * real PostgreSQL database, with two *separate service instances* standing in
 * for two processes (each has its own in-process single-flight map, so only
 * `withOAuthAccountRefreshLock`'s row lock can serialize them). No repository
 * mock here — the point is to prove the real lock and the real envelope
 * encryption behave correctly together.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let accounts: typeof import("./repository/oauth-account");
let teamSecrets: typeof import("../../shared/team-secrets");
let oauthServiceModule: typeof import("./oauth-service");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("oauth_refresh");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  accounts = await import("./repository/oauth-account");
  teamSecrets = await import("../../shared/team-secrets");
  oauthServiceModule = await import("./oauth-service");
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

async function workspace() {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "OAuth refresh lock test",
    slug: workspaceId,
  });
  return { teamId, workspaceId };
}

/** Creates an OAuth account whose tokens are envelope-encrypted through
 * `encryptTeamSecret`, exactly as `storeAuthorization` writes them, so the
 * service under test decrypts real ciphertext rather than a test stand-in. */
async function account(input: {
  teamId: string;
  workspaceId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}) {
  const accessTokenEncrypted = await teamSecrets.encryptTeamSecret(
    input.accessToken,
    input.teamId,
  );
  const refreshTokenEncrypted = await teamSecrets.encryptTeamSecret(
    input.refreshToken,
    input.teamId,
  );
  return accounts.createOAuthAccountRecord({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    connectorType: "google_drive",
    providerAccountId: "permission-1",
    providerAccountEmail: "person@example.com",
    displayName: "Person",
    scopes: ["drive.file"],
    accessTokenEncrypted,
    refreshTokenEncrypted,
    expiresAt: input.expiresAt,
    createdBy: "user-1",
  });
}

async function storedRow(scope: { teamId: string; workspaceId: string }, accountId: string) {
  const row = await accounts.findOAuthAccountRecord({ ...scope, accountId });
  if (!row) throw new Error(`account ${accountId} disappeared`);
  return row;
}

test("two service instances refresh one account with a single provider call", async () => {
  const scope = await workspace();
  const stored = await account({
    ...scope,
    accessToken: "a1",
    refreshToken: "r1",
    expiresAt: new Date(Date.now() - 1_000),
  });

  let calls = 0;
  const refreshOAuthToken = async ({
    refreshToken,
  }: {
    refreshToken: string;
  }) => {
    calls += 1;
    // A second call would arrive with the rotated "r2" — proof the provider
    // was only ever handed the single-use token once.
    assert.equal(refreshToken, "r1");
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: new Date(Date.now() + 3_600_000),
    };
  };
  const registry = { getAdapter: () => ({ exchangeOAuthCode: vi.fn(), refreshOAuthToken }) };
  const serviceA = new oauthServiceModule.ConnectorOAuthService(
    registry as never,
  );
  const serviceB = new oauthServiceModule.ConnectorOAuthService(
    registry as never,
  );

  const input = {
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    accountId: stored.id,
    connectorType: "google_drive",
  };
  const before = Date.now();
  const [a, b] = await Promise.all([
    serviceA.getRuntimeToken(input),
    serviceB.getRuntimeToken(input),
  ]);

  assert.deepEqual([a, b], ["a2", "a2"]);
  assert.equal(calls, 1);

  const row = await storedRow(scope, stored.id);
  assert.equal(row.status, "active");
  assert.equal(
    await teamSecrets.decryptTeamSecret(row.accessTokenEncrypted, scope.teamId),
    "a2",
  );
  assert.equal(
    await teamSecrets.decryptTeamSecret(row.refreshTokenEncrypted, scope.teamId),
    "r2",
  );
  assert.ok(row.lastRefreshAt);
  assert.ok(Date.parse(row.lastRefreshAt!) >= before - 1_000);
});

// Review Focus 5: a refresh the provider refuses must leave the account
// marked `reauth_required` after the error is thrown.
test("a refusal leaves the account marked after the error is thrown", async () => {
  const scope = await workspace();
  const stored = await account({
    ...scope,
    accessToken: "a1",
    refreshToken: "r1",
    expiresAt: new Date(Date.now() - 1_000),
  });

  const refreshOAuthToken = vi.fn(async () => {
    throw Object.assign(new Error("invalid_grant"), { statusCode: 400 });
  });
  const registry = { getAdapter: () => ({ exchangeOAuthCode: vi.fn(), refreshOAuthToken }) };
  const service = new oauthServiceModule.ConnectorOAuthService(
    registry as never,
  );
  const input = {
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    accountId: stored.id,
    connectorType: "google_drive",
  };

  await assert.rejects(
    service.getRuntimeToken(input),
    (error: { code?: string }) => error.code === "CONNECTOR_REAUTH_REQUIRED",
  );

  const row = await storedRow(scope, stored.id);
  assert.equal(row.status, "reauth_required");
  assert.equal(row.lastError, "invalid_grant");

  // A second call sees the marked row directly and never calls the provider
  // again.
  await assert.rejects(
    service.getRuntimeToken(input),
    (error: { code?: string }) =>
      error.code === "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
  );
  assert.equal(refreshOAuthToken.mock.calls.length, 1);
});

test("a transport failure leaves the account active with its old tokens", async () => {
  const scope = await workspace();
  const stored = await account({
    ...scope,
    accessToken: "a1",
    refreshToken: "r1",
    expiresAt: new Date(Date.now() - 1_000),
  });

  const refreshOAuthToken = vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
  const registry = { getAdapter: () => ({ exchangeOAuthCode: vi.fn(), refreshOAuthToken }) };
  const service = new oauthServiceModule.ConnectorOAuthService(
    registry as never,
  );
  const input = {
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    accountId: stored.id,
    connectorType: "google_drive",
  };

  await assert.rejects(service.getRuntimeToken(input));

  const row = await storedRow(scope, stored.id);
  assert.equal(row.status, "active");
  assert.equal(row.lastError, null);
  assert.equal(
    await teamSecrets.decryptTeamSecret(row.accessTokenEncrypted, scope.teamId),
    "a1",
  );
  assert.equal(
    await teamSecrets.decryptTeamSecret(row.refreshTokenEncrypted, scope.teamId),
    "r1",
  );
});
