import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let accounts: typeof import("./oauth-account");
let connectors: typeof import("./connector");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("connector_teams");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  accounts = await import("./oauth-account");
  connectors = await import("./connector");
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

/** A team with two workspaces; each has a connector on an authorization and one indexed source. */
async function team() {
  const teamId = randomUUID();
  const ids = [];
  for (const name of ["first", "second"]) {
    const workspaceId = randomUUID();
    await schema.db.insert(schema.workspaces).values({
      id: workspaceId,
      organizationId: teamId,
      name,
      slug: workspaceId,
    });
    const account = await accounts.createOAuthAccountRecord({
      teamId,
      workspaceId,
      connectorType: "gmail",
      providerAccountId: `${name}@example.com`,
      providerAccountEmail: `${name}@example.com`,
      displayName: name,
      scopes: [],
      accessTokenEncrypted: `enc(${name})`,
      refreshTokenEncrypted: null,
      expiresAt: null,
      createdBy: "user-1",
    });
    const connectorId = randomUUID();
    await schema.db.insert(schema.sourceConnectors).values({
      id: connectorId,
      teamId,
      workspaceId,
      connectorType: "gmail",
      name: `${name} mail`,
      oauthAccountId: account.id,
    });
    const sourceId = randomUUID();
    await schema.db.insert(schema.sources).values({
      id: sourceId,
      teamId,
      workspaceId,
      ingestKind: "connector",
      sourceType: "connector",
      connectorId,
      title: `${name} message`,
      status: "indexed",
    });
    ids.push({ workspaceId, accountId: account.id, connectorId, sourceId });
  }
  return { teamId, ids };
}

test("lists every stored authorization of a team, across workspaces, with secrets", async () => {
  const target = await team();
  const other = await team();

  const listed = await accounts.listTeamOAuthAccountSecretRecords(
    target.teamId,
  );

  assert.deepEqual(
    listed.map((item) => item.id).sort(),
    target.ids.map((item) => item.accountId).sort(),
  );
  assert.ok(
    listed.every((item) => item.accessTokenEncrypted.startsWith("enc(")),
  );
  assert.ok(
    !listed.some((item) => other.ids.some((o) => o.accountId === item.id)),
  );
});

test("deletes a team's connector sources, connectors and authorizations, and nothing of another team", async () => {
  const target = await team();
  const other = await team();

  const result = await connectors.hardDeleteTeamConnectorRecords(target.teamId);

  assert.deepEqual(result, {
    connectorsDeleted: 2,
    sourcesDeleted: 2,
    authorizationsDeleted: 2,
  });
  const remaining = async (teamId: string) => ({
    connectors: (
      await schema.db
        .select()
        .from(schema.sourceConnectors)
        .where(eq(schema.sourceConnectors.teamId, teamId))
    ).length,
    sources: (
      await schema.db
        .select()
        .from(schema.sources)
        .where(eq(schema.sources.teamId, teamId))
    ).length,
    accounts: (
      await schema.db
        .select()
        .from(schema.connectorOAuthAccounts)
        .where(eq(schema.connectorOAuthAccounts.teamId, teamId))
    ).length,
  });
  assert.deepEqual(await remaining(target.teamId), {
    connectors: 0,
    sources: 0,
    accounts: 0,
  });
  assert.deepEqual(await remaining(other.teamId), {
    connectors: 2,
    sources: 2,
    accounts: 2,
  });
});

test("deleting a team with no connector data is a no-op", async () => {
  assert.deepEqual(
    await connectors.hardDeleteTeamConnectorRecords(randomUUID()),
    {
      connectorsDeleted: 0,
      sourcesDeleted: 0,
      authorizationsDeleted: 0,
    },
  );
});
