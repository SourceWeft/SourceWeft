import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

/**
 * Seam check for the Ghost connector on the generic platform: `credential`
 * auth with `scheme: "api_key"` AND a declared selection.
 *
 * - The connector is created together with its credential (the Content API
 *   key) and saved with an empty `items` list; an empty selection means
 *   "every published post and page", so it is ready (never `selection_required`).
 * - The stored account identity is `sha256("ghost\n" + site base)`: the key is
 *   never part of it, so rotating the key keeps it and another site changes it.
 *   The same site cannot be attached twice in one workspace (409).
 *
 * The backend never imports a capability package, so the manifest below is a
 * LOCAL COPY of what `toBackendGhostManifest()` produces (same `configSchema`,
 * `selection`, `auth` and actions), and the adapter is a SYNTHETIC double. The
 * real {@link ConnectorService} and {@link ConnectorSyncOrchestrator} run over
 * an in-memory repository, in the mock lane.
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

import { ConnectorService } from "./service";
import { ConnectorSyncOrchestrator } from "./sync-orchestrator";

const TYPE = "ghost";
const SITE = "https://blog.example.com";
const SUBFOLDER_SITE = "https://blog.example.com/news";
const OTHER_SITE = "https://other.example.org";
const OTHER_ORIGIN = "https://evil.example.org";
const KEY = "0123456789abcdef0123456789";
const ROTATED_KEY = "fedcba9876543210fedcba9876";
// The platform's credential form carries a username that means nothing to Ghost.
const USERNAME = "content-api";

const TAG_ID = "5f1c0a8e9b3d4a0001a2b3c4";
const TAG = { id: `tag:${TAG_ID}`, kind: "tag" };
const POST_TYPE = { id: "type:post", kind: "type" };

// ---- Local copy of the package manifest ------------------------------------

const GHOST_SITE_URL_PATTERN =
  "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$";
const GHOST_ID_PATTERN =
  "^(type:(post|page)|tag:[0-9a-f]{24}|(post|page):[0-9a-f]{24})$";

const actionBase = {
  capabilities: ["connector_read"],
  riskLevel: "low",
  requiresApproval: false,
  visibility: "internal",
};

const ghostManifest = {
  type: TYPE,
  displayName: "Ghost",
  auth: { kind: "credential", scheme: "api_key" },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 60,
    resources: [
      {
        type: "ghost_content",
        displayName: "Post or page",
        supportsDeleteDetection: true,
      },
    ],
  },
  actions: [
    {
      ...actionBase,
      type: "ghost.browse",
      displayName: "Browse Ghost",
      description: "List the content types and tags of a Ghost site.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          containerId: { type: "null" },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      ...actionBase,
      type: "ghost.search",
      displayName: "Search Ghost",
      description: "Search the posts and pages of a Ghost site by title.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 200 },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      ...actionBase,
      type: "ghost.describe",
      displayName: "Describe Ghost items",
      description: "Describe the selected Ghost content.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ids"],
        properties: {
          ids: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "string", pattern: GHOST_ID_PATTERN },
          },
        },
      },
    },
  ],
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["siteUrl"],
    properties: {
      siteUrl: { type: "string", pattern: GHOST_SITE_URL_PATTERN },
      items: {
        type: "array",
        default: [],
        maxItems: 500,
        uniqueItems: true,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: { type: "string", pattern: GHOST_ID_PATTERN },
            kind: { type: "string", enum: ["type", "tag", "post", "page"] },
          },
        },
      },
    },
  },
  selection: {
    actions: {
      browse: "ghost.browse",
      search: "ghost.search",
      describe: "ghost.describe",
    },
    kinds: ["type", "tag", "post", "page"],
    maxItems: 500,
  },
} as unknown as ConnectorManifest;

// ---- Adapter double --------------------------------------------------------

/** Mirrors `ghostCredentialIdentity`: a hash of the normalised site base
 * (trailing slash trimmed), never of the key or the username. */
function identityOf(
  config: Record<string, unknown>,
  _credential: { username: string; secret: string },
) {
  const base = String(config.siteUrl).replace(/\/+$/, "");
  return createHash("sha256").update(`ghost\n${base}`).digest("hex");
}

const credentialIdentity = vi.fn(identityOf);
const checkReadiness = vi.fn();

const ghostAdapter = {
  getManifest: () => ghostManifest,
  credentialIdentity,
  checkSyncReadiness: checkReadiness,
  async *discover() {},
  extract: async ({ item }: { item: unknown }) => ({ item }),
  executeAction: async () => ({ result: {} }),
} as unknown as ConnectorAdapter;

const registry = new ConnectorRegistry([ghostAdapter]);
const service = new ConnectorService(registry);

// ---- In-memory persistence -------------------------------------------------

const encrypt = (plain: string) =>
  `enc:${Buffer.from(plain).toString("base64")}`;
const decrypt = (stored: string) =>
  Buffer.from(stored.replace(/^enc:/, ""), "base64").toString("utf8");

type ConnectorRow = Record<string, unknown> & {
  id: string;
  configJson: Record<string, unknown>;
};

let accounts: Map<string, Record<string, unknown>>;
let connectors: Map<string, ConnectorRow>;
let sequence: number;

function connectorRow(
  id: string,
  connectorType: string,
  accountId: string | null,
  name: string,
  configJson: Record<string, unknown>,
): ConnectorRow {
  return {
    id,
    teamId: "team",
    workspaceId: "workspace",
    connectorType,
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
  repo.listSourceConnectorRecords.mockImplementation(async () => [
    ...connectors.values(),
  ]);
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
  repo.createSourceConnectorRecord.mockImplementation(
    async (input: {
      connectorType: string;
      name: string;
      configJson: Record<string, unknown>;
    }) => {
      sequence += 1;
      const row = connectorRow(
        `conn_${sequence}`,
        input.connectorType,
        null,
        input.name,
        input.configJson,
      );
      connectors.set(row.id, row);
      return row;
    },
  );
  repo.createCredentialConnectorRecord.mockImplementation(
    async (input: {
      connectorType: string;
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
        connectorType: input.connectorType,
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
        input.connectorType,
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
  repo.createSyncRunRecord.mockResolvedValue({ id: "run-skipped" });
  repo.updateSyncRunRecord.mockResolvedValue({ id: "run-1" });
  repo.createSyncRunRecordIfNoActiveRun.mockResolvedValue({
    run: { id: "run-queued" },
    existing: false,
  });
  repo.touchConnectorAfterSync.mockResolvedValue(undefined);
  repo.completeScheduleOccurrence.mockResolvedValue(undefined);
}

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

function scheduledRun(
  enqueue = vi.fn(async (): Promise<{ id?: string | number } | null> => null),
) {
  return {
    enqueue,
    result: orchestrator().enqueueScheduledRun({
      teamId: "team",
      workspaceId: "workspace",
      connectorId: "conn_1",
      userId: "system",
      enqueue,
    }),
  };
}
function createGhost(
  configJson: Record<string, unknown>,
  overrides: Partial<Parameters<ConnectorService["createConnector"]>[0]> = {},
) {
  return service.createConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorType: TYPE,
    name: "Ghost blog",
    configJson,
    credential: { username: USERNAME, secret: KEY },
    ...overrides,
  });
}

function patch(connectorId: string, configJson: Record<string, unknown>) {
  return service.updateConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorId,
    configJson,
  });
}

function rotate(secret = ROTATED_KEY, connectorId = "conn_1") {
  return service.rotateConnectorCredential({
    workspaceId: "workspace",
    userId: "user",
    connectorId,
    credential: { username: USERNAME, secret },
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

const REAUTH_READINESS = {
  ready: false,
  reason: "reauth_required",
  message: "Reconnect the connector.",
};

beforeEach(() => {
  vi.clearAllMocks();
  accounts = new Map();
  connectors = new Map();
  sequence = 0;
  installRepository();
  checkReadiness.mockResolvedValue({ ready: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- (a) api_key credential with a selection: empty selection is valid -----

describe("the Ghost connector (api_key credential) with an empty selection", () => {
  test("is created together with its credential and saved with items: [], and the readiness check saw the entered key", async () => {
    const config = { siteUrl: SITE, items: [] };

    const created = await createGhost(config);

    assert.deepEqual(created.connector.configJson, config);
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 1);
    assert.equal(repo.createSourceConnectorRecord.mock.calls.length, 0);
    assert.equal(created.connector.credentialConfigured, true);
    assert.equal(created.connector.credentialDisplayName, USERNAME);
    assert.equal(checkReadiness.mock.calls.length, 1);
    const readiness = checkReadiness.mock.calls[0]?.[0];
    assert.deepEqual(readiness.config, config);
    assert.equal(
      readiness.accessToken,
      JSON.stringify({ username: USERNAME, secret: KEY }),
    );
    assert.deepEqual(connectors.get("conn_1")?.configJson, config);
  });

  test("stores the key encrypted and only as the account credential: the identity and the config never contain it", async () => {
    const config = { siteUrl: SITE, items: [] };

    await createGhost(config);

    const persisted = repo.createCredentialConnectorRecord.mock.calls[0]?.[0];
    assert.equal(
      persisted.providerAccountId,
      identityOf(config, { username: USERNAME, secret: KEY }),
    );
    assert.ok(!persisted.providerAccountId.includes(KEY));
    assert.ok(!JSON.stringify(persisted.configJson).includes(KEY));
    assert.ok(!persisted.accessTokenEncrypted.includes(KEY));
    assert.deepEqual(JSON.parse(decrypt(persisted.accessTokenEncrypted)), {
      username: USERNAME,
      secret: KEY,
    });
  });

  test("is created with the items key omitted as well", async () => {
    const created = await createGhost({ siteUrl: SITE });
    assert.deepEqual(created.connector.configJson, { siteUrl: SITE });
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 1);
  });

  test("is ready: the readiness endpoint reports ready, not selection_required", async () => {
    const result = await service.checkConfigReadiness({
      workspaceId: "workspace",
      userId: "user",
      connectorType: TYPE,
      configJson: { siteUrl: SITE, items: [] },
      credential: { username: USERNAME, secret: KEY },
    });
    assert.deepEqual(result, { ready: true });
  });

  test("a scheduled sync of an empty selection is not skipped: it is queued", async () => {
    await createGhost({ siteUrl: SITE, items: [] });
    repo.createSyncRunRecord.mockClear();

    const { enqueue, result } = scheduledRun(
      vi.fn(async () => ({ id: "job-1" })),
    );
    const outcome = await result;

    assert.equal(outcome.skipped, undefined);
    assert.equal(enqueue.mock.calls.length, 1);
    assert.equal(repo.createSyncRunRecord.mock.calls.length, 0);
  });

  test("can be created with a selection of every item kind", async () => {
    const items = [
      POST_TYPE,
      { id: "type:page", kind: "type" },
      TAG,
      { id: "post:5f1c0a8e9b3d4a0001a2b3c5", kind: "post" },
      { id: "page:5f1c0a8e9b3d4a0001a2b3c6", kind: "page" },
    ];
    const created = await createGhost({ siteUrl: SITE, items });
    assert.deepEqual(created.connector.configJson, { siteUrl: SITE, items });
  });

  test("creating it without a credential is refused and persists nothing", async () => {
    const error = await rejection(
      createGhost({ siteUrl: SITE, items: [] }, { credential: undefined }),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_REQUIRED");
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("a site the adapter reports not ready is refused at create, persisting nothing", async () => {
    checkReadiness.mockResolvedValue(REAUTH_READINESS);
    const error = await rejection(createGhost({ siteUrl: SITE, items: [] }));
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CONFIG_NOT_READY");
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("the schema still rejects a malformed selection item, a duplicate item, an http site and a stray key", async () => {
    const bad: Array<Record<string, unknown>> = [
      { siteUrl: SITE, items: [{ id: "type:tag", kind: "type" }] },
      { siteUrl: SITE, items: [{ id: "post:123", kind: "post" }] },
      {
        siteUrl: SITE,
        items: [{ id: `tag:${TAG_ID.toUpperCase()}`, kind: "tag" }],
      },
      { siteUrl: SITE, items: [{ id: TAG.id }] },
      { siteUrl: SITE, items: [TAG, { ...TAG }] },
      { siteUrl: "http://blog.example.com", items: [] },
      { siteUrl: SITE, items: [], extra: true },
    ];
    for (const config of bad) {
      const error = await rejection(createGhost(config));
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "CONNECTOR_SCHEMA_VALIDATION_FAILED");
    }
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 0);
  });
});

// ---- (b) identity, PATCH of the selection and of the site ------------------

describe("the Ghost connector's credential identity and edits", () => {
  test("a second connector for the same site is a 409, even with another key or username; another site is accepted", async () => {
    await createGhost({ siteUrl: SITE, items: [] }, { name: "First" });

    const sameKey = await rejection(
      createGhost({ siteUrl: SITE, items: [TAG] }, { name: "Second" }),
    );
    assert.equal(sameKey.statusCode, 409);
    assert.equal(sameKey.code, "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS");

    const otherKey = await rejection(
      createGhost(
        { siteUrl: `${SITE}/`, items: [] },
        {
          name: "Third",
          credential: { username: "someone", secret: ROTATED_KEY },
        },
      ),
    );
    assert.equal(otherKey.statusCode, 409);
    assert.equal(otherKey.code, "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS");
    assert.equal(connectors.size, 1);

    await createGhost({ siteUrl: OTHER_SITE, items: [] }, { name: "Fourth" });
    await createGhost(
      { siteUrl: SUBFOLDER_SITE, items: [] },
      { name: "Fifth" },
    );
    assert.equal(connectors.size, 3);
    assert.equal(
      new Set([...accounts.values()].map((a) => a.providerAccountId)).size,
      3,
    );
  });

  test("a PATCH of the selection alone keeps the account, the identity and the credential, and the connector stays ready", async () => {
    await createGhost({ siteUrl: SITE, items: [TAG, POST_TYPE] });
    const identityBefore = accounts.get("acc_1")?.providerAccountId;
    const tokenBefore = accounts.get("acc_1")?.accessTokenEncrypted;
    const next = { siteUrl: SITE, items: [] };

    const updated = await patch("conn_1", next);

    assert.deepEqual(updated.connector.configJson, next);
    assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 1);
    assert.equal(updated.connector.credentialConfigured, true);
    assert.equal(accounts.get("acc_1")?.providerAccountId, identityBefore);
    assert.equal(accounts.get("acc_1")?.accessTokenEncrypted, tokenBefore);
    assert.equal(accounts.get("acc_1")?.status, "active");

    // Selecting again afterwards is just as accepted.
    const again = { siteUrl: SITE, items: [TAG] };
    const reselected = await patch("conn_1", again);
    assert.deepEqual(reselected.connector.configJson, again);

    // A sync after the edits is queued, not skipped.
    const { enqueue, result } = scheduledRun(
      vi.fn(async () => ({ id: "job-1" })),
    );
    const outcome = await result;
    assert.equal(outcome.skipped, undefined);
    assert.equal(enqueue.mock.calls.length, 1);
  });

  test("rotating only the key keeps the identity; the readiness check is not re-run", async () => {
    await createGhost({ siteUrl: SITE, items: [TAG] });
    const identityBefore = accounts.get("acc_1")?.providerAccountId;
    checkReadiness.mockClear();

    await rotate();

    assert.equal(accounts.get("acc_1")?.providerAccountId, identityBefore);
    assert.equal(
      decrypt(String(accounts.get("acc_1")?.accessTokenEncrypted)),
      JSON.stringify({ username: USERNAME, secret: ROTATED_KEY }),
    );
    assert.equal(checkReadiness.mock.calls.length, 0);
  });

  test("a PATCH that re-points siteUrl to another origin is refused by the endpoint lock and persists nothing", async () => {
    await createGhost({ siteUrl: SITE, items: [TAG] });

    const error = await rejection(
      patch("conn_1", { siteUrl: OTHER_ORIGIN, items: [TAG] }),
    );

    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_ENDPOINT_LOCKED");
    assert.ok(!error.message.includes("evil.example.org"));
    assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 0);
    assert.equal(connectors.get("conn_1")?.configJson.siteUrl, SITE);
  });

  // The platform does NOT compare credential identities on a PATCH: the account
  // keeps the identity it was created with. The reconnect signal for a
  // same-origin site change (a subfolder) comes from the ADAPTER: its readiness
  // check runs the stored key against the new site base and reports
  // reauth_required when that site rejects it, which marks the account.
  // Rotating the key then re-derives the identity from the new config and
  // returns the account to active.
  test("a same-origin siteUrl change is accepted, the adapter's reauth_required marks the account, and a rotate recovers it with the identity of the new site", async () => {
    const original = { siteUrl: SITE, items: [TAG] };
    await createGhost(original);
    const identityBefore = String(accounts.get("acc_1")?.providerAccountId);
    assert.equal(
      identityBefore,
      identityOf(original, { username: USERNAME, secret: KEY }),
    );
    const next = { siteUrl: SUBFOLDER_SITE, items: [TAG] };

    const updated = await patch("conn_1", next);

    assert.deepEqual(updated.connector.configJson, next);
    assert.equal(accounts.get("acc_1")?.providerAccountId, identityBefore);
    assert.equal(accounts.get("acc_1")?.status, "active");

    // The new site rejects the stored key.
    checkReadiness.mockClear();
    checkReadiness.mockResolvedValue(REAUTH_READINESS);
    const skipped = await scheduledRun().result;

    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "reauth_required");
    const readiness = checkReadiness.mock.calls[0]?.[0];
    assert.deepEqual(readiness.config, next);
    assert.equal(
      readiness.accessToken,
      JSON.stringify({ username: USERNAME, secret: KEY }),
    );
    assert.equal(accounts.get("acc_1")?.status, "reauth_required");

    // Rotating re-derives the identity from the connector's CURRENT config.
    await rotate();

    const account = accounts.get("acc_1");
    assert.equal(account?.status, "active");
    assert.equal(
      account?.providerAccountId,
      identityOf(next, { username: USERNAME, secret: ROTATED_KEY }),
    );
    assert.notEqual(account?.providerAccountId, identityBefore);
  });

  test("a PATCH of the selection alone never marks the account for reconnect, even when the next sync is ready", async () => {
    await createGhost({ siteUrl: SITE, items: [] });
    await patch("conn_1", { siteUrl: SITE, items: [POST_TYPE] });

    const { result } = scheduledRun(vi.fn(async () => ({ id: "job-1" })));
    const outcome = await result;

    assert.equal(outcome.skipped, undefined);
    assert.equal(accounts.get("acc_1")?.status, "active");
  });

  test("the identity changes with the site but not with the key or the username", () => {
    const base = identityOf(
      { siteUrl: SITE },
      { username: USERNAME, secret: KEY },
    );
    assert.equal(
      base,
      identityOf({ siteUrl: SITE }, { username: "other", secret: ROTATED_KEY }),
    );
    assert.equal(
      base,
      identityOf({ siteUrl: `${SITE}/` }, { username: USERNAME, secret: KEY }),
    );
    assert.notEqual(
      base,
      identityOf(
        { siteUrl: SUBFOLDER_SITE },
        { username: USERNAME, secret: KEY },
      ),
    );
    assert.notEqual(
      base,
      identityOf({ siteUrl: OTHER_SITE }, { username: USERNAME, secret: KEY }),
    );
  });
});
