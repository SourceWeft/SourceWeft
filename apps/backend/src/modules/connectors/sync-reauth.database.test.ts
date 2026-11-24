import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { fakeBilling } from "./sync-test-support";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

/**
 * Database-backed proof that a rejected credential during a real sync run flips
 * the connector's own account row to `reauth_required` (the state the web
 * reconnect banner reads through `credentialConfigured`) and fails the run with
 * the adapter's diagnostic code. The mock-lane sibling `sync-reauth.test.ts`
 * covers the same branch with doubles; this one runs the real orchestrator
 * against real repository writes.
 *
 * Runs only under the database lane (`pnpm test:database`), which provisions a
 * migrated template; it needs a reachable PostgreSQL with pgvector plus
 * MODEL_GATEWAY_ENCRYPTION_SECRET for team-secret encryption. It could not be
 * executed locally (the Docker daemon is unresponsive and native PostgreSQL
 * lacks pgvector).
 */

const CONNECTOR_TYPE = "webdav";

let schema: typeof import("@sourceweft/db");
let connectorRepo: typeof import("./repository");
let teamSecrets: typeof import("../../shared/team-secrets");
let connectorRuntime: typeof import("./index");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

class AdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function manifest(): ConnectorManifest {
  return {
    type: CONNECTOR_TYPE,
    displayName: "WebDAV",
    auth: { kind: "credential", scheme: "basic" },
    sync: {
      supportsIncremental: false,
      defaultFrequencyMinutes: 360,
      resources: [
        {
          type: "webdav_file",
          displayName: "WebDAV file",
          supportsDeleteDetection: true,
        },
      ],
    },
    actions: [],
    configSchema: { type: "object" },
  } as ConnectorManifest;
}

/** An async iterable whose first iteration rejects with the reauth condition,
 * modelling a discovery that fails on its first provider call (a 401). */
function rejectingIterable(error: unknown): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  };
}

/** A credential adapter whose discovery always throws the reauth condition. */
function rejectingAdapter(): ConnectorAdapter {
  return {
    getManifest: manifest,
    discover: () =>
      rejectingIterable(
        new AdapterError(
          422,
          "WEBDAV_REAUTH_REQUIRED",
          "The WebDAV username or app password was not accepted.",
        ),
      ),
    extract: async ({ item }: { item: unknown }) => ({ item }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("connector_reauth");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  connectorRepo = await import("./repository");
  teamSecrets = await import("../../shared/team-secrets");
  connectorRuntime = await import("./index");
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

beforeEach(async () => {
  await schema.db.delete(schema.connectorSyncRuns);
  await schema.db.delete(schema.sourceConnectors);
  await schema.db.delete(schema.connectorOAuthAccounts);
  await schema.db.delete(schema.workspaces);
});

async function seed() {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Reauth test",
    slug: workspaceId,
  });
  const accessTokenEncrypted = await teamSecrets.encryptTeamSecret(
    JSON.stringify({ username: "dav-user", secret: "app-password" }),
    teamId,
  );
  const { connector, accountId } =
    await connectorRepo.createCredentialConnectorRecord({
      teamId,
      workspaceId,
      connectorType: CONNECTOR_TYPE,
      name: "dav",
      configJson: { endpoint: "https://dav.example.com/", roots: ["/docs/"] },
      providerAccountId: "pid:https://dav.example.com/#dav-user",
      displayName: "dav-user",
      accessTokenEncrypted,
      createdBy: "user-1",
    });
  return { teamId, workspaceId, connectorId: connector.id, accountId };
}

function orchestratorFor() {
  const billing = fakeBilling();
  const registry = new connectorRuntime.ConnectorRegistry([rejectingAdapter()]);
  return new connectorRuntime.ConnectorSyncOrchestrator(
    billing.port,
    registry,
    {
      getRuntimeToken: async () => "token",
    } as unknown as InstanceType<
      typeof connectorRuntime.ConnectorOAuthService
    >,
    async (actor: { ownerUserId: string | null }) => actor.ownerUserId,
  );
}

test("a rejected credential during a sync marks the account reauth_required and fails the run", async () => {
  const { teamId, workspaceId, connectorId, accountId } = await seed();
  const orchestrator = orchestratorFor();

  const run = await connectorRepo.createSyncRunRecord({
    teamId,
    workspaceId,
    connectorId,
    triggerType: "manual",
    status: "queued",
  });

  await assert.rejects(
    orchestrator.run({
      teamId,
      workspaceId,
      connectorId,
      runId: run.id,
      userId: "trigger",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "WEBDAV_REAUTH_REQUIRED");
      return true;
    },
  );

  // The connector's own account row is now reauth_required, so the web
  // reconnect banner shows (credentialConfigured turns false).
  const [account] = await schema.db
    .select()
    .from(schema.connectorOAuthAccounts)
    .where(eq(schema.connectorOAuthAccounts.id, accountId));
  assert.equal(account?.status, "reauth_required");
  assert.ok(account?.lastError);

  // The run failed with the adapter's specific diagnostic code.
  const [runRow] = await schema.db
    .select()
    .from(schema.connectorSyncRuns)
    .where(eq(schema.connectorSyncRuns.id, run.id));
  assert.equal(runRow?.status, "failed");
  assert.equal(runRow?.errorCode, "WEBDAV_REAUTH_REQUIRED");

  // And the connector is left in error, not disabled.
  const [connectorRow] = await schema.db
    .select()
    .from(schema.sourceConnectors)
    .where(eq(schema.sourceConnectors.id, connectorId));
  assert.equal(connectorRow?.status, "error");
});
