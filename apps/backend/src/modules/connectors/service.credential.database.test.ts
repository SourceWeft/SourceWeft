import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

/**
 * Database-backed coverage for the credential account lifecycle at the
 * repository and OAuth-service seams — the behaviour that cannot be proven with
 * mocks: the account + connector write in one transaction (and its rollback),
 * the secret round-tripping through real team-secret encryption, the in-place
 * rotate, the keep-alive skip, and hard delete removing the account.
 *
 * Runs only under the database lane (`pnpm test:database`), which provisions a
 * migrated template; it needs a reachable PostgreSQL plus
 * MODEL_GATEWAY_ENCRYPTION_SECRET for team-secret encryption.
 */

let schema: typeof import("@sourceweft/db");
let connectorRepo: typeof import("./repository");
let teamSecrets: typeof import("../../shared/team-secrets");
let oauthServiceModule: typeof import("./oauth-service");
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("connector_cred");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  connectorRepo = await import("./repository");
  teamSecrets = await import("../../shared/team-secrets");
  oauthServiceModule = await import("./oauth-service");
}, 120_000);

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

const CONNECTOR_TYPE = "webdav";

function manifest(): ConnectorManifest {
  return {
    type: CONNECTOR_TYPE,
    displayName: "WebDAV",
    auth: { kind: "credential", scheme: "basic" },
    sync: {
      supportsIncremental: true,
      defaultFrequencyMinutes: 360,
      resources: [],
    },
    actions: [],
    configSchema: { type: "object" },
  } as ConnectorManifest;
}

function credentialAdapter(): ConnectorAdapter {
  return {
    getManifest: manifest,
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item, contentText: "" }),
    executeAction: async () => ({ result: {} }),
    credentialIdentity: (
      config: Record<string, unknown>,
      credential: { username: string; secret: string },
    ) => `pid:${String(config.endpoint)}#${credential.username}`,
  } as unknown as ConnectorAdapter;
}

async function workspace() {
  const teamId = randomUUID();
  const workspaceId = randomUUID();
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Credential test",
    slug: workspaceId,
  });
  return { teamId, workspaceId };
}

function credentialJson(username: string, secret: string) {
  return JSON.stringify({ username, secret });
}

async function createConnector(input: {
  teamId: string;
  workspaceId: string;
  name: string;
  username: string;
  secret: string;
  providerAccountId?: string;
}) {
  const accessTokenEncrypted = await teamSecrets.encryptTeamSecret(
    credentialJson(input.username, input.secret),
    input.teamId,
  );
  return connectorRepo.createCredentialConnectorRecord({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
    connectorType: CONNECTOR_TYPE,
    name: input.name,
    configJson: { endpoint: "https://dav.example.com/" },
    providerAccountId:
      input.providerAccountId ?? `pid:https://dav.example.com/#${input.username}`,
    displayName: input.username,
    accessTokenEncrypted,
    createdBy: "user-1",
  });
}

async function accountRow(accountId: string) {
  const [row] = await schema.db
    .select()
    .from(schema.connectorOAuthAccounts)
    .where(eq(schema.connectorOAuthAccounts.id, accountId));
  return row;
}

test("create writes the account and connector together, with the secret encrypted at rest", async () => {
  const scope = await workspace();
  const { connector, accountId } = await createConnector({
    ...scope,
    name: "dav-a",
    username: "dav-user",
    secret: "s3cr3t-value",
  });

  const account = await accountRow(accountId);
  assert.ok(account);
  assert.equal(account.connectorType, CONNECTOR_TYPE);
  assert.equal(account.status, "active");
  assert.equal(account.displayName, "dav-user");
  assert.deepEqual(account.scopes, []);
  assert.equal(account.refreshTokenEncrypted, null);
  assert.equal(account.expiresAt, null);
  assert.equal(
    account.providerAccountId,
    "pid:https://dav.example.com/#dav-user",
  );
  // Encrypted at rest: the raw column is not the plaintext.
  assert.ok(!account.accessTokenEncrypted.includes("s3cr3t-value"));
  // And it decrypts back to the exact credential JSON.
  assert.equal(
    await teamSecrets.decryptTeamSecret(
      account.accessTokenEncrypted,
      scope.teamId,
    ),
    credentialJson("dav-user", "s3cr3t-value"),
  );

  // The connector points at the account and its stored config holds no secret.
  const [connectorRow] = await schema.db
    .select()
    .from(schema.sourceConnectors)
    .where(eq(schema.sourceConnectors.id, connector.id));
  assert.equal(connectorRow?.oauthAccountId, accountId);
  assert.ok(!JSON.stringify(connectorRow?.configJson).includes("s3cr3t-value"));
});

test("a connector insert failure rolls the account back, leaving no orphan", async () => {
  const scope = await workspace();
  await createConnector({
    ...scope,
    name: "dupe",
    username: "user-a",
    secret: "secret-a",
    providerAccountId: "pid:a",
  });

  // Same workspace/type/name violates the unique index, so the second create
  // must abort; its freshly inserted account must not survive.
  await assert.rejects(
    createConnector({
      ...scope,
      name: "dupe",
      username: "user-b",
      secret: "secret-b",
      providerAccountId: "pid:b",
    }),
  );

  const rows = await schema.db
    .select()
    .from(schema.connectorOAuthAccounts)
    .where(
      and(
        eq(schema.connectorOAuthAccounts.workspaceId, scope.workspaceId),
        eq(schema.connectorOAuthAccounts.providerAccountId, "pid:b"),
      ),
    );
  assert.equal(rows.length, 0);
});

test("findOAuthAccountByProviderAccountInWorkspace isolates by workspace", async () => {
  const scope = await workspace();
  const other = await workspace();
  await createConnector({
    ...scope,
    name: "iso",
    username: "shared",
    secret: "x",
    providerAccountId: "pid:shared",
  });

  assert.ok(
    await connectorRepo.findOAuthAccountByProviderAccountInWorkspace({
      teamId: scope.teamId,
      workspaceId: scope.workspaceId,
      connectorType: CONNECTOR_TYPE,
      providerAccountId: "pid:shared",
    }),
  );
  assert.equal(
    await connectorRepo.findOAuthAccountByProviderAccountInWorkspace({
      teamId: other.teamId,
      workspaceId: other.workspaceId,
      connectorType: CONNECTOR_TYPE,
      providerAccountId: "pid:shared",
    }),
    null,
  );
});

test("getRuntimeToken returns the decrypted credential JSON", async () => {
  const scope = await workspace();
  const { accountId } = await createConnector({
    ...scope,
    name: "runtime",
    username: "dav-user",
    secret: "runtime-secret",
  });

  const service = new oauthServiceModule.ConnectorOAuthService(
    new ConnectorRegistry([credentialAdapter()]),
  );
  const token = await service.getRuntimeToken({
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    accountId,
    connectorType: CONNECTOR_TYPE,
  });
  assert.equal(token, credentialJson("dav-user", "runtime-secret"));
});

test("rotate replaces the stored secret in place and clears reauth_required", async () => {
  const scope = await workspace();
  const { accountId } = await createConnector({
    ...scope,
    name: "rotate",
    username: "dav-user",
    secret: "old-secret",
  });
  await schema.db
    .update(schema.connectorOAuthAccounts)
    .set({ status: "reauth_required", lastError: "rejected" })
    .where(eq(schema.connectorOAuthAccounts.id, accountId));

  const accessTokenEncrypted = await teamSecrets.encryptTeamSecret(
    credentialJson("dav-user", "new-secret"),
    scope.teamId,
  );
  const updated = await connectorRepo.updateOAuthAccountCredentialRecord({
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    accountId,
    displayName: "dav-user",
    providerAccountId: "pid:https://dav.example.com/#dav-user",
    accessTokenEncrypted,
  });

  assert.equal(updated?.id, accountId);
  assert.equal(updated?.status, "active");
  assert.equal(updated?.lastError, null);
  const account = await accountRow(accountId);
  assert.equal(
    await teamSecrets.decryptTeamSecret(
      account!.accessTokenEncrypted,
      scope.teamId,
    ),
    credentialJson("dav-user", "new-secret"),
  );
});

test("refreshIdleAccounts never sweeps a credential account", async () => {
  const scope = await workspace();
  await createConnector({
    ...scope,
    name: "keepalive",
    username: "dav-user",
    secret: "secret",
  });

  const service = new oauthServiceModule.ConnectorOAuthService(
    new ConnectorRegistry([credentialAdapter()]),
  );
  const counts = await service.refreshIdleAccounts({
    now: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  assert.equal(counts.checked, 0);
  assert.equal(counts.refreshed, 0);
});

test("hard delete removes the credential account", async () => {
  const scope = await workspace();
  const { connector, accountId } = await createConnector({
    ...scope,
    name: "delete",
    username: "dav-user",
    secret: "secret",
  });

  const result = await connectorRepo.hardDeleteSourceConnectorRecord({
    teamId: scope.teamId,
    workspaceId: scope.workspaceId,
    connectorId: connector.id,
    oauthAccountId: accountId,
  });
  assert.equal(result.connectorDeleted, true);
  assert.equal(result.authorizationDeleted, true);
  assert.equal(await accountRow(accountId), undefined);
});
