import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

/**
 * Seam check for the generic `credential` auth kind with `scheme: "api_key"`.
 *
 * The backend must stay scheme-agnostic: a connector (such as Zotero) that
 * authenticates with an API key rides the same create / rotate / readiness /
 * reauth path as the `basic` connectors. The backend never imports a capability
 * package, so this file drives the real {@link ConnectorService} and
 * {@link ConnectorSyncOrchestrator} with a SYNTHETIC adapter whose identity is a
 * library-derived hash, over an in-memory repository.
 */

const repo = vi.hoisted(() => ({
  // service
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
  putConnectorSchedule: vi.fn(),
  archiveConnectorSources: vi.fn(),
  // orchestrator
  createSyncRunRecord: vi.fn(),
  createSyncRunRecordIfNoActiveRun: vi.fn(),
  attachScheduleOccurrenceRun: vi.fn(),
  completeScheduleOccurrence: vi.fn(),
  commitConnectorSyncPage: vi.fn(),
  archiveConnectorSourcesNotSeenInRun: vi.fn(),
  findSyncRunRecord: vi.fn(),
  getOrResetConnectorSyncState: vi.fn(),
  resetConnectorSyncState: vi.fn(),
  isConnectorScheduleEnabled: vi.fn(),
  skipScheduleOccurrenceByRunId: vi.fn(),
  tryAcquireConnectorSyncLock: vi.fn(),
  hardDeleteSourceConnectorRecord: vi.fn(),
  incrementSyncRunCounts: vi.fn(),
  listSyncRunRecords: vi.fn(),
  listWorkspaceSyncRunRecords: vi.fn(),
  markConnectorSyncBlockChecked: vi.fn(),
  markOAuthAccountReauthRequiredRecord: vi.fn(),
  touchConnectorAfterSync: vi.fn(),
  updateSyncRunRecord: vi.fn(),
}));

const secrets = vi.hoisted(() => ({
  requireConnectorWorkspace: vi.fn(),
  encryptTeamSecret: vi.fn(),
}));

vi.mock("./permissions", () => ({
  requireConnectorWorkspace: secrets.requireConnectorWorkspace,
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: secrets.encryptTeamSecret,
}));
vi.mock("./repository", () => repo);
vi.mock("../sources", () => ({
  SourceIndexingService: class {},
  createSourceRecord: vi.fn(),
  createSourceRevisionRecord: vi.fn(),
  estimateIngestionPages: vi.fn(() => null),
  findSourceRecordByConnectorExternalId: vi.fn(),
  updateSourceRecord: vi.fn(),
}));
vi.mock("../../billing-host/bindings", () => ({
  getBillingDeploymentCapabilities: () => ({ billing: { available: false } }),
}));
vi.mock("../workspace", () => ({
  workspaceService: { getOrganizationMembership: vi.fn() },
}));
vi.mock("./extracted-file", () => ({
  resolveExtractedFile: vi.fn(),
}));
vi.mock("./oauth-service", () => ({
  ConnectorOAuthService: class {},
}));
vi.mock("./ingestion-budget", () => ({
  IngestionPageBudget: class {
    async admit() {
      return { outcome: "admit" as const };
    }
    consumed() {}
  },
  isPagesLimitExceeded: () => false,
}));

import { logger } from "../../shared/logger";
import { ConnectorService } from "./service";
import { ConnectorSyncOrchestrator } from "./sync-orchestrator";

const SECRET = "zotero-api-key-SHHH-4d9e1c07";
const ROTATED_SECRET = "zotero-api-key-ROTATED-b82f6a35";
const USERNAME = "users/123";
const CONFIG = { libraryType: "user", libraryId: "123" };
const CONNECTOR_TYPE = "synthetic-library";

const configSchema = {
  type: "object",
  required: ["libraryType", "libraryId"],
  properties: {
    libraryType: { type: "string" },
    libraryId: { type: "string" },
  },
  additionalProperties: false,
};

/** Non-secret, library-derived identity: a hash of the library the config
 * names, never of the secret. */
function identityOf(config: Record<string, unknown>) {
  const digest = createHash("sha256")
    .update(`${String(config.libraryType)}/${String(config.libraryId)}`)
    .digest("hex")
    .slice(0, 32);
  return `library:${digest}`;
}

const credentialIdentity = vi.fn(
  (
    config: Record<string, unknown>,
    _credential: { username: string; secret: string },
  ) => identityOf(config),
);
const checkSyncReadiness = vi.fn();

const syntheticManifest = {
  type: CONNECTOR_TYPE,
  displayName: "Synthetic library",
  auth: { kind: "credential", scheme: "api_key" },
  sync: {
    supportsIncremental: true,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 30,
    resources: [],
  },
  actions: [],
  configSchema,
} as unknown as ConnectorManifest;

const syntheticAdapter = {
  getManifest: () => syntheticManifest,
  credentialIdentity,
  checkSyncReadiness,
  async *discover() {},
  extract: async ({ item }: { item: unknown }) => ({ item }),
  executeAction: async () => ({ result: {} }),
} as unknown as ConnectorAdapter;

const registry = new ConnectorRegistry([syntheticAdapter]);
const service = new ConnectorService(registry);

// Reversible stand-in for team-secret encryption so a test can prove what the
// stored account decrypts to.
const encrypt = (plain: string) =>
  `enc:${Buffer.from(plain).toString("base64")}`;
const decrypt = (stored: string) =>
  Buffer.from(stored.replace(/^enc:/, ""), "base64").toString("utf8");

type ConnectorRow = Record<string, unknown> & {
  id: string;
  configJson: Record<string, unknown>;
};

/** In-memory persistence the repository doubles read and write. */
let accounts: Map<string, Record<string, unknown>>;
let connectors: Map<string, ConnectorRow>;
let sequence: number;

function seedState() {
  accounts = new Map();
  connectors = new Map();
  sequence = 0;
}

function connectorRow(
  id: string,
  accountId: string | null,
  name: string,
  configJson: Record<string, unknown>,
): ConnectorRow {
  return {
    id,
    teamId: "team",
    workspaceId: "workspace",
    connectorType: CONNECTOR_TYPE,
    name,
    configJson,
    oauthAccountId: accountId,
    status: "active",
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: null,
    lastIndexedAt: null,
    nextScheduledAt: null,
    lastError: null,
    syncBlock: null,
    createdBy: "user",
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
  };
}

function installRepository() {
  secrets.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  secrets.encryptTeamSecret.mockImplementation(async (plain: string) =>
    encrypt(plain),
  );

  repo.findSourceConnectorRecordByName.mockResolvedValue(null);
  repo.listSourceConnectorRecords.mockResolvedValue([]);
  repo.listConnectorScheduleStatuses.mockResolvedValue(new Map());
  repo.getConnectorScheduleStatus.mockResolvedValue(null);
  repo.putConnectorSchedule.mockResolvedValue(undefined);
  repo.archiveConnectorSources.mockResolvedValue(undefined);

  repo.findOAuthAccountByProviderAccountInWorkspace.mockImplementation(
    async (input: { providerAccountId: string }) =>
      [...accounts.values()].find(
        (account) => account.providerAccountId === input.providerAccountId,
      ) ?? null,
  );
  repo.findOAuthAccountRecord.mockImplementation(
    async (input: { accountId: string }) =>
      accounts.get(input.accountId) ?? null,
  );
  repo.findSourceConnectorRecord.mockImplementation(
    async (input: { connectorId: string }) =>
      connectors.get(input.connectorId) ?? null,
  );
  repo.createCredentialConnectorRecord.mockImplementation(
    async (input: {
      name: string;
      configJson: Record<string, unknown>;
      providerAccountId: string;
      displayName: string;
      accessTokenEncrypted: string;
    }) => {
      sequence += 1;
      const accountId = `acc_${sequence}`;
      accounts.set(accountId, {
        id: accountId,
        teamId: "team",
        workspaceId: "workspace",
        connectorType: CONNECTOR_TYPE,
        providerAccountId: input.providerAccountId,
        providerAccountEmail: null,
        displayName: input.displayName,
        scopes: [],
        status: "active",
        expiresAt: null,
        lastRefreshAt: null,
        lastError: null,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: null,
      });
      const connector = connectorRow(
        `conn_${sequence}`,
        accountId,
        input.name,
        input.configJson,
      );
      connectors.set(connector.id, connector);
      return { connector, accountId };
    },
  );
  repo.updateOAuthAccountCredentialRecord.mockImplementation(
    async (input: {
      accountId: string;
      displayName: string;
      providerAccountId: string;
      accessTokenEncrypted: string;
    }) => {
      const account = accounts.get(input.accountId);
      if (!account) return null;
      Object.assign(account, {
        displayName: input.displayName,
        providerAccountId: input.providerAccountId,
        accessTokenEncrypted: input.accessTokenEncrypted,
        status: "active",
        lastError: null,
      });
      return account;
    },
  );
  repo.updateSourceConnectorRecord.mockImplementation(
    async (input: { connectorId: string } & Record<string, unknown>) => {
      const connector = connectors.get(input.connectorId);
      if (!connector) return null;
      const { connectorId: _id, teamId: _t, workspaceId: _w, ...patch } = input;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) connector[key] = value;
      }
      return connector;
    },
  );
  repo.markOAuthAccountReauthRequiredRecord.mockImplementation(
    async (input: { accountId: string; lastError: string }) => {
      const account = accounts.get(input.accountId);
      if (!account || account.status !== "active") return false;
      account.status = "reauth_required";
      account.lastError = input.lastError;
      return true;
    },
  );
  repo.createSyncRunRecord.mockResolvedValue({ id: "run-1" });
  repo.updateSyncRunRecord.mockResolvedValue({ id: "run-1" });
}

/** The orchestrator resolves the credential through the OAuth service's
 * runtime-token seam; the double does what the real one does for a credential
 * account: decrypt the stored value. */
function orchestrator() {
  return new ConnectorSyncOrchestrator(
    {} as never,
    registry as never,
    {
      getRuntimeToken: vi.fn(async (input: { accountId: string | null }) => {
        const account = input.accountId ? accounts.get(input.accountId) : null;
        assert.ok(account, "the connector's account must exist");
        return decrypt(String(account.accessTokenEncrypted));
      }),
    } as never,
    async () => "billing-user",
  );
}

function create(
  overrides: Partial<Parameters<ConnectorService["createConnector"]>[0]> = {},
) {
  return service.createConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorType: CONNECTOR_TYPE,
    name: "Library",
    configJson: CONFIG,
    credential: { username: USERNAME, secret: SECRET },
    ...overrides,
  });
}

function rotate(secret = ROTATED_SECRET, connectorId = "conn_1") {
  return service.rotateConnectorCredential({
    workspaceId: "workspace",
    userId: "user",
    connectorId,
    credential: { username: USERNAME, secret },
  });
}

function scheduledRun() {
  return orchestrator().enqueueScheduledRun({
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "conn_1",
    userId: "system",
    enqueue: async () => null,
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

const spies = () => ({
  info: vi.spyOn(logger, "info"),
  warn: vi.spyOn(logger, "warn"),
  error: vi.spyOn(logger, "error"),
  debug: vi.spyOn(logger, "debug"),
});

/** Every argument handed to the spied logger, serialized. */
function loggedText(logs: ReturnType<typeof spies>) {
  return Object.values(logs)
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  seedState();
  installRepository();
  checkSyncReadiness.mockResolvedValue({ ready: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an api_key credential connector: create", () => {
  test("creates with the library credential after a passing readiness check", async () => {
    const result = await create();

    // Readiness ran with the entered credential JSON, before anything persisted.
    assert.equal(
      checkSyncReadiness.mock.calls[0]?.[0].accessToken,
      JSON.stringify({ username: USERNAME, secret: SECRET }),
    );
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 1);
    assert.equal(result.connector.credentialConfigured, true);
    assert.equal(result.connector.credentialDisplayName, USERNAME);
  });

  test("the stored account decrypts to exactly the username and secret JSON", async () => {
    await create();

    const persisted = repo.createCredentialConnectorRecord.mock.calls[0]?.[0];
    // The identity the adapter derived from the library is what is stored.
    assert.equal(persisted.providerAccountId, identityOf(CONFIG));
    assert.equal(persisted.displayName, USERNAME);
    assert.equal(
      decrypt(persisted.accessTokenEncrypted),
      JSON.stringify({ username: USERNAME, secret: SECRET }),
    );
    assert.deepEqual(JSON.parse(decrypt(persisted.accessTokenEncrypted)), {
      username: USERNAME,
      secret: SECRET,
    });
    // Neither the stored identity nor the config carries the secret.
    assert.ok(!persisted.providerAccountId.includes(SECRET));
    assert.ok(!JSON.stringify(persisted.configJson).includes(SECRET));
  });

  test("a second connector for the same library identity in one workspace is a 409", async () => {
    await create({ name: "First" });
    const writes = repo.createCredentialConnectorRecord.mock.calls.length;
    const encrypted = secrets.encryptTeamSecret.mock.calls.length;

    const error = await rejection(create({ name: "Second" }));

    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS");
    // Nothing further was written or encrypted for the rejected create.
    assert.equal(
      repo.createCredentialConnectorRecord.mock.calls.length,
      writes,
    );
    assert.equal(secrets.encryptTeamSecret.mock.calls.length, encrypted);
    assert.equal(connectors.size, 1);
  });

  test("a different library is a different identity and is allowed", async () => {
    await create({ name: "First" });
    await create({
      name: "Second",
      configJson: { libraryType: "user", libraryId: "456" },
    });
    assert.equal(connectors.size, 2);
  });
});

describe("an api_key credential connector: rotate", () => {
  test("rotating the secret keeps the account identity and replaces the stored JSON", async () => {
    await create();
    const before = accounts.get("acc_1");
    assert.ok(before);
    const identityBefore = before.providerAccountId;
    assert.equal(identityBefore, identityOf(CONFIG));

    const status = await rotate();

    assert.deepEqual(status, {
      credentialConfigured: true,
      displayName: USERNAME,
    });
    const after = accounts.get("acc_1");
    assert.ok(after);
    // Same account row, same library-derived identity.
    assert.equal(after.providerAccountId, identityBefore);
    assert.equal(accounts.size, 1);
    // The stored value is the new credential, decrypting to exactly that JSON.
    assert.equal(
      decrypt(String(after.accessTokenEncrypted)),
      JSON.stringify({ username: USERNAME, secret: ROTATED_SECRET }),
    );
    // The identity is derived from the connector's config, not the credential.
    assert.equal(credentialIdentity.mock.calls.at(-1)?.[0], CONFIG);
  });

  test("rotate does not run a readiness check", async () => {
    await create();
    checkSyncReadiness.mockClear();
    await rotate();
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
  });
});

describe("an api_key credential connector: readiness on sync", () => {
  test("a reauth_required readiness result marks the account reauth_required", async () => {
    await create();
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "reauth_required",
      message: "Reconnect the connector.",
    });

    const result = await scheduledRun();

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "reauth_required");
    assert.equal(
      repo.markOAuthAccountReauthRequiredRecord.mock.calls.length,
      1,
    );
    assert.deepEqual(
      repo.markOAuthAccountReauthRequiredRecord.mock.calls[0]?.[0],
      {
        teamId: "team",
        workspaceId: "workspace",
        accountId: "acc_1",
        lastError:
          "The stored credential was rejected. Reconnect the connector.",
      },
    );
    assert.equal(accounts.get("acc_1")?.status, "reauth_required");
  });

  test("rotating the credential returns the account to active", async () => {
    await create();
    accounts.get("acc_1")!.status = "reauth_required";
    await rotate();
    assert.equal(accounts.get("acc_1")?.status, "active");
  });

  test("the readiness check is handed the decrypted credential JSON and a non-reauth miss marks nothing", async () => {
    await create();
    checkSyncReadiness.mockClear();
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "library_not_accessible",
      message: "The key cannot read this library.",
    });
    await scheduledRun();
    assert.equal(
      checkSyncReadiness.mock.calls[0]?.[0].accessToken,
      JSON.stringify({ username: USERNAME, secret: SECRET }),
    );
    assert.equal(
      repo.markOAuthAccountReauthRequiredRecord.mock.calls.length,
      0,
    );
  });
});

describe("an api_key credential connector: configuration edits", () => {
  // This pins CURRENT behaviour deliberately. The credential endpoint lock in
  // updateConnector covers only URL-valued config keys (so a stored secret
  // cannot be re-pointed at another origin). `libraryId` is not URL-valued, so
  // changing it is accepted, and the next readiness check receives the new
  // config together with the unchanged stored credential. If the platform later
  // binds the credential to the library (for example by re-deriving or checking
  // the identity on PATCH), this test must change deliberately with it.
  test("a PATCH that changes configJson.libraryId is accepted and the next readiness sees the new config", async () => {
    await create();
    const nextConfig = { libraryType: "user", libraryId: "999" };

    const updated = await service.updateConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "conn_1",
      configJson: nextConfig,
    });

    assert.deepEqual(updated.connector.configJson, nextConfig);
    assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 1);
    // The account keeps its original identity: the platform does not re-derive.
    assert.equal(accounts.get("acc_1")?.providerAccountId, identityOf(CONFIG));

    checkSyncReadiness.mockClear();
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "library_not_accessible",
      message: "The key cannot read this library.",
    });
    await scheduledRun();
    const readinessInput = checkSyncReadiness.mock.calls[0]?.[0];
    assert.deepEqual(readinessInput.config, nextConfig);
    assert.equal(
      readinessInput.accessToken,
      JSON.stringify({ username: USERNAME, secret: SECRET }),
    );
  });
});

describe("an api_key credential connector never leaks the secret", () => {
  test("responses and log lines carry neither the secret nor the rotated secret", async () => {
    const logs = spies();
    const responses: unknown[] = [];

    responses.push(await create());
    responses.push(
      await service.checkConfigReadiness({
        workspaceId: "workspace",
        userId: "user",
        connectorType: CONNECTOR_TYPE,
        configJson: CONFIG,
        credential: { username: USERNAME, secret: SECRET },
      }),
    );
    responses.push(await rotate());
    responses.push(
      await service.getConnector({
        workspaceId: "workspace",
        userId: "user",
        connectorId: "conn_1",
      }),
    );
    // A rejected duplicate and a reauth-marked sync must not leak either.
    const duplicate = await rejection(create({ name: "Duplicate" }));
    responses.push({ code: duplicate.code, message: duplicate.message });
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "reauth_required",
      message: "Reconnect the connector.",
    });
    responses.push(await scheduledRun());

    const everything = JSON.stringify(responses) + loggedText(logs);
    assert.ok(!everything.includes(SECRET));
    assert.ok(!everything.includes(ROTATED_SECRET));
    // Sanity: the logger was actually exercised by the reauth path.
    assert.ok(
      loggedText(logs).includes("connector_credential_account_reauth_required"),
    );
  });
});
