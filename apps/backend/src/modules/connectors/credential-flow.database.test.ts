import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/**
 * Database-backed coverage for the credential login-flow state rows — the
 * lifecycle that cannot be proven with mocks: the encrypted `attemptRef`
 * round-tripping through real team-secret encryption, the single atomic consume
 * (two concurrent completions, one winner), the per-user/type live count behind
 * the attempt cap, the owner-scoped cancel, and the opportunistic expiry sweep.
 *
 * Runs only under the database lane (`pnpm test:database`), which provisions a
 * migrated template; it needs a reachable PostgreSQL plus
 * MODEL_GATEWAY_ENCRYPTION_SECRET for team-secret encryption. Docker is
 * unavailable in the local sandbox, so this suite is written to type-check and
 * runs in CI.
 */

let schema: typeof import("@sourceweft/db");
let repo: typeof import("./repository");
let teamSecrets: typeof import("../../shared/team-secrets");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("credential_flow");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repo = await import("./repository");
  teamSecrets = await import("../../shared/team-secrets");
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

const CONNECTOR_TYPE = "nextcloud";
const POLL_TOKEN = "poll-token-secret";

function hashFlowId(flowId: string) {
  return createHash("sha256").update(flowId).digest("hex");
}

async function workspace() {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Credential flow test",
    slug: workspaceId,
  });
  return { teamId, workspaceId };
}

function future() {
  return new Date(Date.now() + 600_000);
}

function past() {
  return new Date(Date.now() - 1000);
}

async function createFlow(input: {
  teamId: string;
  workspaceId: string;
  userId: string;
  flowId: string;
  expiresAt: Date;
  attemptRef?: string | null;
}) {
  return repo.createOAuthStateRecord({
    stateHash: hashFlowId(input.flowId),
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    connectorType: CONNECTOR_TYPE,
    expiresAt: input.expiresAt,
    attemptRef: input.attemptRef ?? null,
  });
}

async function storedRow(stateHash: string) {
  const [row] = await schema.db
    .select()
    .from(schema.connectorOAuthStates)
    .where(eq(schema.connectorOAuthStates.stateHash, stateHash));
  return row;
}

test("a stored flow's encrypted attemptRef decrypts to the pending blob and is cleared on claim", async () => {
  const scope = await workspace();
  const blob = JSON.stringify({
    pending: { pollToken: POLL_TOKEN },
    name: "My Nextcloud",
    roots: ["/"],
  });
  const attemptRef = await teamSecrets.encryptTeamSecret(blob, scope.teamId);
  // Encrypted at rest: the column is not the plaintext.
  assert.ok(!attemptRef.includes(POLL_TOKEN));

  const flowId = randomUUID();
  const created = await createFlow({
    ...scope,
    userId: "user-1",
    flowId,
    expiresAt: future(),
    attemptRef,
  });

  const found = await repo.findOAuthStateRecord({
    stateHash: created.stateHash,
    connectorType: CONNECTOR_TYPE,
    now: new Date(),
  });
  assert.ok(found);
  assert.equal(
    await teamSecrets.decryptTeamSecret(found.attemptRef, scope.teamId),
    blob,
  );

  // First claim wins, the second loses: a flow completes exactly once.
  assert.equal(
    await repo.claimCredentialFlowRecord({
      stateHash: created.stateHash,
      connectorType: CONNECTOR_TYPE,
      now: new Date(),
    }),
    true,
  );
  assert.equal(
    await repo.claimCredentialFlowRecord({
      stateHash: created.stateHash,
      connectorType: CONNECTOR_TYPE,
      now: new Date(),
    }),
    false,
  );

  const row = await storedRow(created.stateHash);
  assert.ok(row?.consumedAt);
  assert.equal(row?.attemptRef, null);
});

test("countLiveCredentialFlowRecords counts only unconsumed, unexpired rows for the user and type", async () => {
  const scope = await workspace();
  const live1 = await createFlow({
    ...scope,
    userId: "user-1",
    flowId: randomUUID(),
    expiresAt: future(),
  });
  await createFlow({
    ...scope,
    userId: "user-1",
    flowId: randomUUID(),
    expiresAt: future(),
  });
  // An expired row and another user's row must not count.
  await createFlow({
    ...scope,
    userId: "user-1",
    flowId: randomUUID(),
    expiresAt: past(),
  });
  await createFlow({
    ...scope,
    userId: "user-2",
    flowId: randomUUID(),
    expiresAt: future(),
  });

  assert.equal(
    await repo.countLiveCredentialFlowRecords({
      userId: "user-1",
      workspaceId: scope.workspaceId,
      connectorType: CONNECTOR_TYPE,
      now: new Date(),
    }),
    2,
  );

  // Consuming one live row drops the count.
  await repo.claimCredentialFlowRecord({
    stateHash: live1.stateHash,
    connectorType: CONNECTOR_TYPE,
    now: new Date(),
  });
  assert.equal(
    await repo.countLiveCredentialFlowRecords({
      userId: "user-1",
      workspaceId: scope.workspaceId,
      connectorType: CONNECTOR_TYPE,
      now: new Date(),
    }),
    1,
  );
});

test("deleteCredentialFlowRecord removes only the owner's unconsumed row", async () => {
  const scope = await workspace();
  const created = await createFlow({
    ...scope,
    userId: "user-1",
    flowId: randomUUID(),
    expiresAt: future(),
  });

  // A non-owner's cancel affects nothing.
  assert.equal(
    await repo.deleteCredentialFlowRecord({
      stateHash: created.stateHash,
      connectorType: CONNECTOR_TYPE,
      userId: "user-2",
      workspaceId: scope.workspaceId,
    }),
    false,
  );
  assert.ok(await storedRow(created.stateHash));

  // The owner's cancel removes it.
  assert.equal(
    await repo.deleteCredentialFlowRecord({
      stateHash: created.stateHash,
      connectorType: CONNECTOR_TYPE,
      userId: "user-1",
      workspaceId: scope.workspaceId,
    }),
    true,
  );
  assert.equal(await storedRow(created.stateHash), undefined);
});

test("deleteExpiredCredentialFlowRecords removes expired rows of the type and keeps live ones", async () => {
  const scope = await workspace();
  const expired = await createFlow({
    ...scope,
    userId: "user-1",
    flowId: randomUUID(),
    expiresAt: past(),
  });
  const live = await createFlow({
    ...scope,
    userId: "user-1",
    flowId: randomUUID(),
    expiresAt: future(),
  });

  const removed = await repo.deleteExpiredCredentialFlowRecords({
    connectorType: CONNECTOR_TYPE,
    now: new Date(),
  });
  assert.ok(removed >= 1);
  assert.equal(await storedRow(expired.stateHash), undefined);
  assert.ok(await storedRow(live.stateHash));
});
