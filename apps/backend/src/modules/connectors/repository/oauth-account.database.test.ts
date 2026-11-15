import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";
import type { ConnectorOAuthAccountStatus } from "../types";

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
  accessTokenEncrypted?: string;
  refreshTokenEncrypted?: string | null;
  lastRefreshAt?: Date | null;
  expiresAt?: Date | null;
  status?: ConnectorOAuthAccountStatus;
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
    accessTokenEncrypted: input.accessTokenEncrypted ?? "enc(access-1)",
    refreshTokenEncrypted:
      input.refreshTokenEncrypted === undefined
        ? "enc(refresh-1)"
        : input.refreshTokenEncrypted,
    expiresAt: input.expiresAt ?? null,
    createdBy: "user-1",
  });
  const overrides: Partial<typeof schema.connectorOAuthAccounts.$inferInsert> =
    {};
  if (input.createdAt) overrides.createdAt = input.createdAt;
  if (input.lastRefreshAt !== undefined)
    overrides.lastRefreshAt = input.lastRefreshAt;
  if (input.status) overrides.status = input.status;
  if (Object.keys(overrides).length > 0) {
    await schema.db
      .update(schema.connectorOAuthAccounts)
      .set(overrides)
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

test("the refresh lock applies a token write and returns the result", async () => {
  const scope = await workspace();
  const stored = await account({
    ...scope,
    accessTokenEncrypted: "enc(a1)",
    refreshTokenEncrypted: "enc(r1)",
  });
  const expiresAt = new Date("2026-12-01T00:00:00.000Z");
  const before = Date.now();

  const result = await accounts.withOAuthAccountRefreshLock(
    { ...scope, accountId: stored.id, lockTimeoutMs: 5_000 },
    async (locked) => {
      assert.equal(locked?.refreshTokenEncrypted, "enc(r1)");
      assert.equal(locked?.accessTokenEncrypted, "enc(a1)");
      return {
        write: {
          kind: "token" as const,
          accessTokenEncrypted: "enc(a2)",
          refreshTokenEncrypted: "enc(r2)",
          expiresAt,
        },
        result: "a2",
      };
    },
  );

  assert.equal(result, "a2");
  const row = await accounts.findOAuthAccountRecord({
    ...scope,
    accountId: stored.id,
  });
  assert.equal(row?.accessTokenEncrypted, "enc(a2)");
  assert.equal(row?.refreshTokenEncrypted, "enc(r2)");
  assert.equal(row?.expiresAt, expiresAt.toISOString());
  assert.equal(row?.status, "active");
  assert.equal(row?.lastError, null);
  assert.ok(row?.lastRefreshAt);
  assert.ok(Date.parse(row!.lastRefreshAt!) >= before - 1_000);
  assert.ok(Date.parse(row!.lastRefreshAt!) <= Date.now() + 1_000);
});

test("an undefined refresh token keeps the stored one and null clears it", async () => {
  const scope = await workspace();
  const kept = await account({ ...scope, refreshTokenEncrypted: "enc(keep)" });
  const cleared = await account({
    ...scope,
    refreshTokenEncrypted: "enc(clear)",
  });

  await accounts.withOAuthAccountRefreshLock(
    { ...scope, accountId: kept.id, lockTimeoutMs: 5_000 },
    async () => ({
      write: {
        kind: "token" as const,
        accessTokenEncrypted: "enc(kept-access)",
        expiresAt: null,
      },
      result: null,
    }),
  );
  await accounts.withOAuthAccountRefreshLock(
    { ...scope, accountId: cleared.id, lockTimeoutMs: 5_000 },
    async () => ({
      write: {
        kind: "token" as const,
        accessTokenEncrypted: "enc(cleared-access)",
        refreshTokenEncrypted: null,
        expiresAt: null,
      },
      result: null,
    }),
  );

  const keptRow = await accounts.findOAuthAccountRecord({
    ...scope,
    accountId: kept.id,
  });
  const clearedRow = await accounts.findOAuthAccountRecord({
    ...scope,
    accountId: cleared.id,
  });
  assert.equal(keptRow?.refreshTokenEncrypted, "enc(keep)");
  assert.equal(clearedRow?.refreshTokenEncrypted, null);
});

test("a status write commits even though the caller throws afterwards", async () => {
  const scope = await workspace();
  const stored = await account(scope);

  const outcome = await accounts.withOAuthAccountRefreshLock(
    { ...scope, accountId: stored.id, lockTimeoutMs: 5_000 },
    async () => ({
      write: {
        kind: "status" as const,
        status: "reauth_required" as const,
        lastError: "invalid_grant",
      },
      result: { ok: false as const },
    }),
  );
  assert.equal(outcome.ok, false);

  // The write already committed inside the repository function; a caller
  // throwing after it returns (the later service task) cannot undo that.
  assert.throws(() => {
    if (!outcome.ok) throw new Error("service surfaces failure after commit");
  });

  const row = await accounts.findOAuthAccountRecord({
    ...scope,
    accountId: stored.id,
  });
  assert.equal(row?.status, "reauth_required");
  assert.equal(row?.lastError, "invalid_grant");
  assert.equal(row?.accessTokenEncrypted, "enc(access-1)");
  assert.equal(row?.refreshTokenEncrypted, "enc(refresh-1)");
});

test("nothing is written when decide throws", async () => {
  const scope = await workspace();
  const stored = await account(scope);

  await assert.rejects(
    accounts.withOAuthAccountRefreshLock(
      { ...scope, accountId: stored.id, lockTimeoutMs: 5_000 },
      async () => {
        throw new Error("provider refresh failed");
      },
    ),
    /provider refresh failed/,
  );

  const row = await accounts.findOAuthAccountRecord({
    ...scope,
    accountId: stored.id,
  });
  assert.equal(row?.accessTokenEncrypted, "enc(access-1)");
  assert.equal(row?.refreshTokenEncrypted, "enc(refresh-1)");
  assert.equal(row?.status, "active");
});

test("a missing account reaches decide as null", async () => {
  const scope = await workspace();
  let seen: unknown = "not-called";

  const result = await accounts.withOAuthAccountRefreshLock(
    { ...scope, accountId: randomUUID(), lockTimeoutMs: 5_000 },
    async (locked) => {
      seen = locked;
      return { write: { kind: "none" as const }, result: "done" };
    },
  );

  assert.equal(seen, null);
  assert.equal(result, "done");
});

test("a second caller waits for the first and sees its write", async () => {
  const scope = await workspace();
  const stored = await account(scope);
  const ref = { ...scope, accountId: stored.id, lockTimeoutMs: 5_000 };

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = accounts.withOAuthAccountRefreshLock(ref, async () => {
    await gate;
    return {
      write: {
        kind: "token" as const,
        accessTokenEncrypted: "enc(a2)",
        expiresAt: null,
      },
      result: 1,
    };
  });
  const seen: Array<string | undefined> = [];
  const second = accounts.withOAuthAccountRefreshLock(ref, async (locked) => {
    seen.push(locked?.accessTokenEncrypted);
    return { write: { kind: "none" as const }, result: 2 };
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(seen, []); // still blocked

    release();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(seen, ["enc(a2)"]);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
});

test("a lock wait past the timeout is reported as busy", async () => {
  const scope = await workspace();
  const stored = await account(scope);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = accounts.withOAuthAccountRefreshLock(
    { ...scope, accountId: stored.id, lockTimeoutMs: 5_000 },
    async () => {
      await gate;
      return { write: { kind: "none" as const }, result: 1 };
    },
  );

  try {
    // Give the first caller time to acquire the row lock before the second
    // caller starts waiting on it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = accounts.withOAuthAccountRefreshLock(
      { ...scope, accountId: stored.id, lockTimeoutMs: 200 },
      async () => ({ write: { kind: "none" as const }, result: 2 }),
    );
    await assert.rejects(
      second,
      (error: { statusCode?: number; code?: string }) =>
        error.statusCode === 503 &&
        error.code === "CONNECTOR_OAUTH_REFRESH_BUSY",
    );
  } finally {
    release();
    await first;
  }
});

test("keep-alive lists active accounts with a refresh token, oldest first", async () => {
  const scope = await workspace();
  const refreshedBefore = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000);
  const soon = new Date(Date.now() + 60 * 60_000);
  const connectorTypes = ["google_drive"];

  // Earlier tests in this shared database-test file leave their own "due"
  // rows behind (old fixed `createdAt` values from other scopes). Capture
  // that count up front so the limit assertion below is exact without
  // depending on how many other tests ran before this one.
  const beforeCount = (
    await accounts.listOAuthAccountsDueForKeepAlive({
      refreshedBefore,
      limit: 10_000,
      connectorTypes,
    })
  ).length;

  const a = await account({
    ...scope,
    lastRefreshAt: days(10),
    expiresAt: soon,
  });
  const b = await account({
    ...scope,
    lastRefreshAt: null,
    createdAt: days(9),
    expiresAt: soon,
  });
  const c = await account({
    ...scope,
    lastRefreshAt: days(2),
    expiresAt: soon,
  });
  const d = await account({
    ...scope,
    lastRefreshAt: days(10),
    expiresAt: soon,
    status: "reauth_required",
  });
  const e = await account({
    ...scope,
    lastRefreshAt: days(10),
    expiresAt: soon,
    refreshTokenEncrypted: null,
  });
  // F4: old and otherwise due, but no expiry — never refreshed, so excluded.
  const f = await account({
    ...scope,
    lastRefreshAt: days(10),
    expiresAt: null,
  });
  const ids = new Set([a.id, b.id, c.id, d.id, e.id, f.id]);

  const due = await accounts.listOAuthAccountsDueForKeepAlive({
    refreshedBefore,
    limit: 10_000,
    connectorTypes,
  });
  const mine = due.filter((row) => ids.has(row.id));
  assert.deepEqual(mine.map((row) => row.id), [a.id, b.id]);

  const limited = await accounts.listOAuthAccountsDueForKeepAlive({
    refreshedBefore,
    limit: beforeCount + 1,
    connectorTypes,
  });
  assert.deepEqual(
    limited.filter((row) => ids.has(row.id)).map((row) => row.id),
    [a.id],
  );
});

// F5
test("keep-alive filters by connector type and returns nothing for an empty list", async () => {
  const scope = await workspace();
  const refreshedBefore = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60_000);
  const soon = new Date(Date.now() + 60 * 60_000);

  const drive = await account({
    ...scope,
    connectorType: "google_drive",
    providerAccountId: "drive-1",
    lastRefreshAt: days(10),
    expiresAt: soon,
  });
  const gmail = await account({
    ...scope,
    connectorType: "gmail",
    providerAccountId: "gmail-1",
    lastRefreshAt: days(10),
    expiresAt: soon,
  });

  const driveOnly = await accounts.listOAuthAccountsDueForKeepAlive({
    refreshedBefore,
    limit: 10_000,
    connectorTypes: ["google_drive"],
  });
  const driveIds = driveOnly.map((row) => row.id);
  assert.ok(driveIds.includes(drive.id));
  assert.ok(!driveIds.includes(gmail.id));

  const none = await accounts.listOAuthAccountsDueForKeepAlive({
    refreshedBefore,
    limit: 10_000,
    connectorTypes: [],
  });
  assert.deepEqual(none, []);
});
