import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

const mocks = vi.hoisted(() => ({
  requireConnectorWorkspace: vi.fn(),
  encryptTeamSecret: vi.fn(),
  createCredentialConnectorRecord: vi.fn(),
  createSourceConnectorRecord: vi.fn(),
  findOAuthAccountByProviderAccountInWorkspace: vi.fn(),
  findOAuthAccountRecord: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
  findSourceConnectorRecordByName: vi.fn(),
  getConnectorScheduleStatus: vi.fn(),
  listSourceConnectorRecords: vi.fn(),
  listConnectorScheduleStatuses: vi.fn(),
  updateOAuthAccountCredentialRecord: vi.fn(),
  updateSourceConnectorRecord: vi.fn(),
}));

vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.requireConnectorWorkspace,
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: mocks.encryptTeamSecret,
}));
vi.mock("./repository", () => ({
  createCredentialConnectorRecord: mocks.createCredentialConnectorRecord,
  createSourceConnectorRecord: mocks.createSourceConnectorRecord,
  findOAuthAccountByProviderAccountInWorkspace:
    mocks.findOAuthAccountByProviderAccountInWorkspace,
  findOAuthAccountRecord: mocks.findOAuthAccountRecord,
  findSourceConnectorRecord: mocks.findSourceConnectorRecord,
  findSourceConnectorRecordByName: mocks.findSourceConnectorRecordByName,
  getConnectorScheduleStatus: mocks.getConnectorScheduleStatus,
  listSourceConnectorRecords: mocks.listSourceConnectorRecords,
  listConnectorScheduleStatuses: mocks.listConnectorScheduleStatuses,
  updateOAuthAccountCredentialRecord: mocks.updateOAuthAccountCredentialRecord,
  updateSourceConnectorRecord: mocks.updateSourceConnectorRecord,
}));

import { logger } from "../../shared/logger";
import { ConnectorService } from "./service";

const SECRET = "app-password-SHHH-9f3a2b";
const USERNAME = "dav-user";
const ENDPOINT = "https://dav.example.com/";
const CONFIG = { endpoint: ENDPOINT, roots: ["/Docs/"] };

const configSchema = {
  type: "object",
  required: ["endpoint"],
  properties: {
    endpoint: { type: "string" },
    roots: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

/** Deterministic non-secret identity the adapter derives; never embeds the
 * secret. The test asserts the service stores exactly this. */
function identityOf(config: Record<string, unknown>, username: string) {
  return `pid:${String(config.endpoint)}#${username}`;
}

const credentialIdentity = vi.fn(
  (
    config: Record<string, unknown>,
    credential: { username: string; secret: string },
  ) => identityOf(config, credential.username),
);
const checkSyncReadiness = vi.fn();

function manifest(
  type: string,
  auth: ConnectorManifest["auth"],
): ConnectorManifest {
  return {
    type,
    displayName: type,
    auth,
    sync: {
      supportsIncremental: true,
      defaultFrequencyMinutes: 360,
      minFrequencyMinutes: 30,
      resources: [],
    },
    actions: [],
    configSchema,
  } as ConnectorManifest;
}

function credentialAdapter(withIdentity = true): ConnectorAdapter {
  const m = manifest("webdav", { kind: "credential", scheme: "basic" });
  return {
    getManifest: () => m,
    ...(withIdentity ? { credentialIdentity } : {}),
    checkSyncReadiness,
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

function noneAdapter(): ConnectorAdapter {
  const m = manifest("public-feed", { kind: "none" });
  return {
    getManifest: () => m,
    checkSyncReadiness,
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

function service(...adapters: ConnectorAdapter[]) {
  return new ConnectorService(
    new ConnectorRegistry(adapters.length ? adapters : [credentialAdapter()]),
  );
}

const createdConnector = {
  id: "conn_cred",
  teamId: "team",
  workspaceId: "workspace",
  connectorType: "webdav",
  name: "WebDAV",
  configJson: CONFIG,
  oauthAccountId: "acc_cred",
  status: "active",
  periodicIndexingEnabled: false,
  indexingFrequencyMinutes: null,
  lastIndexedAt: null,
  nextScheduledAt: null,
  lastError: null,
  createdBy: "user",
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
};

const credentialAccountRow = {
  id: "acc_cred",
  teamId: "team",
  workspaceId: "workspace",
  connectorType: "webdav",
  providerAccountId: identityOf(CONFIG, USERNAME),
  providerAccountEmail: null,
  displayName: USERNAME,
  scopes: [] as string[],
  status: "active" as const,
  expiresAt: null,
  lastRefreshAt: null,
  lastError: null,
  createdBy: "user",
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  accessTokenEncrypted: "enc:stored",
  refreshTokenEncrypted: null,
};

function create(
  svc: ConnectorService,
  overrides: Partial<Parameters<ConnectorService["createConnector"]>[0]> = {},
) {
  return svc.createConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorType: "webdav",
    name: "WebDAV",
    configJson: CONFIG,
    credential: { username: USERNAME, secret: SECRET },
    ...overrides,
  });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as {
      statusCode?: number;
      code?: string;
      message: string;
      details?: Record<string, unknown>;
    };
  }
  throw new Error("expected the promise to reject");
}

/** Every argument handed to the spied logger, serialized, so a test can assert
 * the secret is nowhere in any log line. */
function loggedText(...spies: Array<ReturnType<typeof vi.spyOn>>) {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecordByName.mockResolvedValue(null);
  mocks.listSourceConnectorRecords.mockResolvedValue([]);
  mocks.listConnectorScheduleStatuses.mockResolvedValue(new Map());
  mocks.findOAuthAccountByProviderAccountInWorkspace.mockResolvedValue(null);
  mocks.findOAuthAccountRecord.mockResolvedValue(credentialAccountRow);
  mocks.findSourceConnectorRecord.mockResolvedValue(createdConnector);
  mocks.getConnectorScheduleStatus.mockResolvedValue(null);
  mocks.createCredentialConnectorRecord.mockResolvedValue({
    connector: createdConnector,
    accountId: "acc_cred",
  });
  mocks.encryptTeamSecret.mockImplementation(async (plain: string) => `enc:${plain}`);
  checkSyncReadiness.mockResolvedValue({ ready: true });
});

describe("createConnector for a credential connector", () => {
  test("rejects an OAuth account and persists nothing", async () => {
    const error = await rejection(create(service(), { oauthAccountId: "acc" }));
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_OAUTH_ACCOUNT_NOT_ALLOWED");
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
    assert.equal(mocks.encryptTeamSecret.mock.calls.length, 0);
  });

  test("requires a credential and persists nothing", async () => {
    const error = await rejection(create(service(), { credential: undefined }));
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_REQUIRED");
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("writes the account and connector together with an encrypted secret", async () => {
    const result = await create(service());

    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 1);
    const persisted = mocks.createCredentialConnectorRecord.mock.calls[0]?.[0];
    // The non-secret identity the adapter derived is what is stored.
    assert.equal(persisted.providerAccountId, identityOf(CONFIG, USERNAME));
    assert.equal(persisted.displayName, USERNAME);
    // The stored value is the encrypted username+secret JSON, never plaintext.
    assert.equal(
      persisted.accessTokenEncrypted,
      `enc:${JSON.stringify({ username: USERNAME, secret: SECRET })}`,
    );
    assert.equal(
      mocks.encryptTeamSecret.mock.calls[0]?.[0],
      JSON.stringify({ username: USERNAME, secret: SECRET }),
    );
    // The secret is never copied into the stored configJson.
    assert.ok(!JSON.stringify(persisted.configJson).includes(SECRET));
    // The response exposes the non-secret status fields and no secret.
    assert.equal(result.connector.credentialConfigured, true);
    assert.equal(result.connector.credentialDisplayName, USERNAME);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });

  test("rejects a duplicate provider account in the same workspace with 409", async () => {
    mocks.findOAuthAccountByProviderAccountInWorkspace.mockResolvedValue(
      credentialAccountRow,
    );
    const error = await rejection(create(service()));
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS");
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
    assert.equal(mocks.encryptTeamSecret.mock.calls.length, 0);
  });

  test("rejects an adapter that cannot derive a credential identity", async () => {
    const error = await rejection(create(service(credentialAdapter(false))));
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_IDENTITY_UNSUPPORTED");
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("a name conflict is rejected before anything is written", async () => {
    mocks.findSourceConnectorRecordByName.mockResolvedValue({
      id: "same",
      status: "active",
    });
    const error = await rejection(create(service()));
    assert.equal(error.code, "CONNECTOR_ALREADY_EXISTS");
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
  });
});

describe("checkConfigReadiness for a credential connector", () => {
  const base = {
    workspaceId: "workspace",
    userId: "user",
    connectorType: "webdav",
    configJson: CONFIG,
  };

  test("passes the credential JSON to the adapter and persists nothing", async () => {
    checkSyncReadiness.mockResolvedValue({ ready: true });
    const result = await service().checkConfigReadiness({
      ...base,
      credential: { username: USERNAME, secret: SECRET },
    });

    assert.deepEqual(result, { ready: true });
    assert.equal(
      checkSyncReadiness.mock.calls[0]?.[0].accessToken,
      JSON.stringify({ username: USERNAME, secret: SECRET }),
    );
    assert.equal(checkSyncReadiness.mock.calls[0]?.[0].connectorId, "pending");
    // Persists nothing: no write repository call was made.
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
    assert.equal(mocks.updateOAuthAccountCredentialRecord.mock.calls.length, 0);
  });

  test("requires a credential for a credential connector", async () => {
    const error = await rejection(service().checkConfigReadiness(base));
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_REQUIRED");
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
  });

  test("a none connector still runs with an empty access token", async () => {
    checkSyncReadiness.mockResolvedValue({ ready: true });
    await service(noneAdapter()).checkConfigReadiness({
      ...base,
      connectorType: "public-feed",
    });
    assert.equal(checkSyncReadiness.mock.calls[0]?.[0].accessToken, "");
  });
});

describe("rotateConnectorCredential", () => {
  const rotate = (
    svc: ConnectorService,
    overrides: Partial<
      Parameters<ConnectorService["rotateConnectorCredential"]>[0]
    > = {},
  ) =>
    svc.rotateConnectorCredential({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "conn_cred",
      credential: { username: USERNAME, secret: "new-secret-7c1d" },
      ...overrides,
    });

  test("replaces the stored value in place and returns active status", async () => {
    mocks.updateOAuthAccountCredentialRecord.mockResolvedValue({
      ...credentialAccountRow,
      status: "active",
    });
    const result = await rotate(service());

    assert.deepEqual(result, {
      credentialConfigured: true,
      displayName: USERNAME,
    });
    // The new username+secret JSON is encrypted and written to the same account.
    assert.equal(
      mocks.encryptTeamSecret.mock.calls[0]?.[0],
      JSON.stringify({ username: USERNAME, secret: "new-secret-7c1d" }),
    );
    const update = mocks.updateOAuthAccountCredentialRecord.mock.calls[0]?.[0];
    assert.equal(update.accountId, "acc_cred");
    assert.equal(
      update.accessTokenEncrypted,
      `enc:${JSON.stringify({ username: USERNAME, secret: "new-secret-7c1d" })}`,
    );
  });

  test("rejects a connector in another workspace (not found)", async () => {
    mocks.findSourceConnectorRecord.mockResolvedValue(null);
    const error = await rejection(rotate(service()));
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "CONNECTOR_NOT_FOUND");
    assert.equal(mocks.updateOAuthAccountCredentialRecord.mock.calls.length, 0);
  });

  test("propagates a missing-permission rejection and writes nothing", async () => {
    mocks.requireConnectorWorkspace.mockRejectedValue(
      Object.assign(new Error("forbidden"), {
        statusCode: 403,
        code: "FORBIDDEN",
      }),
    );
    const error = await rejection(rotate(service()));
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(mocks.updateOAuthAccountCredentialRecord.mock.calls.length, 0);
    assert.equal(mocks.encryptTeamSecret.mock.calls.length, 0);
  });

  test("rejects a non-credential connector", async () => {
    mocks.findSourceConnectorRecord.mockResolvedValue({
      ...createdConnector,
      connectorType: "public-feed",
    });
    const error = await rejection(rotate(service(noneAdapter())));
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_UNSUPPORTED");
  });
});

describe("the service never logs the secret", () => {
  test("create, check and rotate emit no log line carrying the secret", async () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const debug = vi.spyOn(logger, "debug");

    mocks.updateOAuthAccountCredentialRecord.mockResolvedValue(
      credentialAccountRow,
    );
    await create(service());
    await service().checkConfigReadiness({
      workspaceId: "workspace",
      userId: "user",
      connectorType: "webdav",
      configJson: CONFIG,
      credential: { username: USERNAME, secret: SECRET },
    });
    await service().rotateConnectorCredential({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "conn_cred",
      credential: { username: USERNAME, secret: SECRET },
    });

    assert.ok(!loggedText(info, warn, error, debug).includes(SECRET));

    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    debug.mockRestore();
  });
});
