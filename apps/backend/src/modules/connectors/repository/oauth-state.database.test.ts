import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../../test/isolated-database";

let schema: typeof import("@sourceweft/db");
let states: typeof import("./oauth-state");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("oauth_state");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  states = await import("./oauth-state");
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
    name: "OAuth state test",
    slug: workspaceId,
  });
  return { teamId, workspaceId };
}

function futureExpiry() {
  return new Date(Date.now() + 60_000);
}

test("consuming a state row returns the authorization attempt it was created with", async () => {
  const scope = await workspace();
  const created = await states.createOAuthStateRecord({
    stateHash: randomUUID(),
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    userId: "user-1",
    connectorType: "gmail",
    expiresAt: futureExpiry(),
    attemptRef: "ca_test",
  });
  assert.equal(created.attemptRef, "ca_test");

  const consumed = await states.consumeOAuthStateRecord({
    stateHash: created.stateHash,
    connectorType: "gmail",
    now: new Date(),
  });

  assert.equal(consumed?.attemptRef, "ca_test");
});

test("a state row created without an authorization attempt consumes to null", async () => {
  const scope = await workspace();
  const created = await states.createOAuthStateRecord({
    stateHash: randomUUID(),
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    userId: "user-1",
    connectorType: "gmail",
    expiresAt: futureExpiry(),
  });
  assert.equal(created.attemptRef, null);

  const consumed = await states.consumeOAuthStateRecord({
    stateHash: created.stateHash,
    connectorType: "gmail",
    now: new Date(),
  });

  assert.equal(consumed?.attemptRef, null);
});

test("finding a state row returns the authorization attempt it was created with", async () => {
  const scope = await workspace();
  const created = await states.createOAuthStateRecord({
    stateHash: randomUUID(),
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    userId: "user-1",
    connectorType: "gmail",
    expiresAt: futureExpiry(),
    attemptRef: "ca_test",
  });

  const found = await states.findOAuthStateRecord({
    stateHash: created.stateHash,
    connectorType: "gmail",
    now: new Date(),
  });

  assert.equal(found?.attemptRef, "ca_test");
});
