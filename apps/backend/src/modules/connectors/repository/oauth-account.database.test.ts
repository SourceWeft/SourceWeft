import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let accounts: typeof import("./oauth-account");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("connector_oauth");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  accounts = await import("./oauth-account");
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
    name: "OAuth account test",
    slug: workspaceId,
  });
  return { teamId, workspaceId };
}

async function account(input: {
  teamId: string;
  workspaceId: string;
  connectorType?: string;
  providerAccountId?: string | null;
  createdAt?: Date;
}) {
  const created = await accounts.createOAuthAccountRecord({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    connectorType: input.connectorType ?? "google_drive",
    providerAccountId:
      input.providerAccountId === undefined
        ? "permission-1"
        : input.providerAccountId,
    providerAccountEmail: "old@example.com",
    displayName: "Old name",
    scopes: ["old.scope"],
    accessTokenEncrypted: "enc(access-1)",
    refreshTokenEncrypted: "enc(refresh-1)",
    createdBy: "user-1",
  });
  if (input.createdAt) {
    await schema.db
      .update(schema.connectorOAuthAccounts)
      .set({ createdAt: input.createdAt })
      .where(eq(schema.connectorOAuthAccounts.id, created.id));
  }
  return created;
}

async function connector(input: {
  teamId: string;
  workspaceId: string;
  oauthAccountId: string;
  status?: "active" | "disabled";
}) {
  const id = randomUUID();
  await schema.db.insert(schema.sourceConnectors).values({
    id,
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    connectorType: "google_drive",
    name: id,
    oauthAccountId: input.oauthAccountId,
    status: input.status ?? "active",
  });
  return id;
}

const lookup = (scope: { teamId: string; workspaceId: string }) =>
  accounts.findReauthorizableOAuthAccountRecord({
    ...scope,
    connectorType: "google_drive",
    providerAccountId: "permission-1",
  });

test("finds a stored authorization for the same provider account whatever its status", async () => {
  const scope = await workspace();
  const stored = await account(scope);
  await accounts.updateOAuthAccountStatusRecord({
    ...scope,
    accountId: stored.id,
    status: "reauth_required",
    lastError: "invalid_grant",
  });

  const found = await lookup(scope);

  assert.equal(found?.id, stored.id);
  assert.equal(found?.status, "reauth_required");
});

test("does not match another workspace, connector type, or provider account", async () => {
  const scope = await workspace();
  const other = await workspace();
  await account(other);
  await account({ ...scope, connectorType: "gmail" });
  await account({ ...scope, providerAccountId: "permission-2" });
  await account({ ...scope, providerAccountId: null });

  assert.equal(await lookup(scope), null);
});

test("prefers the authorization a connector uses over a newer unused one", async () => {
  const scope = await workspace();
  const attached = await account({
    ...scope,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  await account({ ...scope, createdAt: new Date("2026-06-01T00:00:00.000Z") });
  await connector({ ...scope, oauthAccountId: attached.id });

  assert.equal((await lookup(scope))?.id, attached.id);
});

test("prefers a live connector's authorization over a disabled connector's", async () => {
  const scope = await workspace();
  const disabled = await account({
    ...scope,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  });
  const live = await account({
    ...scope,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  await connector({
    ...scope,
    oauthAccountId: disabled.id,
    status: "disabled",
  });
  await connector({ ...scope, oauthAccountId: live.id });

  assert.equal((await lookup(scope))?.id, live.id);
});

test("falls back to the newest authorization when no connector uses any", async () => {
  const scope = await workspace();
  await account({ ...scope, createdAt: new Date("2026-01-01T00:00:00.000Z") });
  const newest = await account({
    ...scope,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  });

  assert.equal((await lookup(scope))?.id, newest.id);
});

test("reauthorizing replaces the tokens and makes the authorization active again", async () => {
  const scope = await workspace();
  const stored = await account(scope);
  await accounts.updateOAuthAccountStatusRecord({
    ...scope,
    accountId: stored.id,
    status: "reauth_required",
    lastError: "invalid_grant",
  });
  const expiresAt = new Date("2026-11-14T10:00:00.000Z");

  const refreshed = await accounts.reauthorizeOAuthAccountRecord({
    ...scope,
    accountId: stored.id,
    providerAccountEmail: "new@example.com",
    displayName: "New name",
    scopes: ["new.scope"],
    accessTokenEncrypted: "enc(access-2)",
    refreshTokenEncrypted: "enc(refresh-2)",
    expiresAt,
  });

  assert.equal(refreshed?.id, stored.id);
  assert.equal(refreshed?.status, "active");
  assert.equal(refreshed?.lastError, null);
  assert.equal(refreshed?.displayName, "New name");
  assert.equal(refreshed?.providerAccountEmail, "new@example.com");
  assert.deepEqual(refreshed?.scopes, ["new.scope"]);
  assert.equal(refreshed?.createdBy, "user-1");
  const row = await accounts.findOAuthAccountRecord({
    ...scope,
    accountId: stored.id,
  });
  assert.equal(row?.accessTokenEncrypted, "enc(access-2)");
  assert.equal(row?.refreshTokenEncrypted, "enc(refresh-2)");
  assert.equal(row?.expiresAt, expiresAt.toISOString());
});

test("reauthorizing without a new refresh token keeps the stored one", async () => {
  const scope = await workspace();
  const stored = await account(scope);

  await accounts.reauthorizeOAuthAccountRecord({
    ...scope,
    accountId: stored.id,
    providerAccountEmail: null,
    displayName: "New name",
    scopes: ["new.scope"],
    accessTokenEncrypted: "enc(access-2)",
    expiresAt: null,
  });

  const row = await accounts.findOAuthAccountRecord({
    ...scope,
    accountId: stored.id,
  });
  assert.equal(row?.accessTokenEncrypted, "enc(access-2)");
  assert.equal(row?.refreshTokenEncrypted, "enc(refresh-1)");
  assert.equal(row?.providerAccountEmail, "old@example.com");
});

test("reauthorizing an authorization outside the workspace changes nothing", async () => {
  const scope = await workspace();
  const other = await workspace();
  const stored = await account(scope);

  const refreshed = await accounts.reauthorizeOAuthAccountRecord({
    ...other,
    accountId: stored.id,
    providerAccountEmail: null,
    displayName: "New name",
    scopes: [],
    accessTokenEncrypted: "enc(access-2)",
    expiresAt: null,
  });

  assert.equal(refreshed, null);
  const row = await accounts.findOAuthAccountRecord({
    ...scope,
    accountId: stored.id,
  });
  assert.equal(row?.accessTokenEncrypted, "enc(access-1)");
});
