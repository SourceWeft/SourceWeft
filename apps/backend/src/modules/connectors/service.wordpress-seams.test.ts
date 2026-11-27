import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

/**
 * Seam check for the two WordPress connectors on the generic platform:
 *
 * - `wordpress`: `none` auth with a declared selection. An empty selection
 *   means "everything", so it is created, saved and ready with `items: []`.
 * - `wordpress_login`: `credential` (`basic`) auth with a declared selection and
 *   `includeUnpublished`. Created together with its credential; the stored
 *   account identity is derived by the adapter from site and username, never
 *   from the secret.
 *
 * The backend never imports a capability package, so the manifests below are
 * LOCAL COPIES of what `toBackendWordPressManifest()` and
 * `toBackendWordPressLoginManifest()` produce (same `configSchema`, `selection`
 * and `auth`), and the adapters are SYNTHETIC doubles. The real
 * {@link ConnectorService} and {@link ConnectorSyncOrchestrator} run over an
 * in-memory repository, in the mock lane.
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

const PUBLIC_TYPE = "wordpress";
const LOGIN_TYPE = "wordpress_login";
const SITE = "https://blog.example.com";
const SUBFOLDER_SITE = "https://blog.example.com/news";
const OTHER_ORIGIN = "https://evil.example.org";
const USERNAME = "editor";
const SECRET = "wp-app-password-SHHH-7c1d9e44";
const ROTATED_SECRET = "wp-app-password-ROTATED-2b6f03a8";

const CATEGORY = { id: "category:3", kind: "category" };
const POST_TYPE = { id: "type:post", kind: "type" };

// ---- Local copies of the package manifests ---------------------------------

const WORDPRESS_SITE_URL_PATTERN =
  "^https://[A-Za-z0-9.-]{1,253}(/[A-Za-z0-9._~/-]{0,300})?$";
const WORDPRESS_ID_PATTERN =
  "^(type:(post|page)|(category|post|page):[1-9][0-9]{0,9})$";
const WORDPRESS_CATEGORY_ID_PATTERN = "^category:[1-9][0-9]{0,9}$";

const itemsSchema = {
  type: "array",
  default: [],
  maxItems: 500,
  uniqueItems: true,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "kind"],
    properties: {
      id: { type: "string", pattern: WORDPRESS_ID_PATTERN },
      kind: { type: "string", enum: ["type", "category", "post", "page"] },
    },
  },
};

const siteUrlSchema = { type: "string", pattern: WORDPRESS_SITE_URL_PATTERN };

function actionsFor(id: string) {
  const base = {
    capabilities: ["connector_read"],
    riskLevel: "low",
    requiresApproval: false,
    visibility: "internal",
  };
  return [
    {
      ...base,
      type: `${id}.browse`,
      displayName: "Browse WordPress",
      description: "List the content types and categories of a site.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          containerId: {
            type: ["string", "null"],
            pattern: WORDPRESS_CATEGORY_ID_PATTERN,
          },
          cursor: { type: "string", maxLength: 4096 },
        },
      },
    },
    {
      ...base,
      type: `${id}.search`,
      displayName: "Search WordPress",
      description: "Search the posts and pages of a site.",
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
      ...base,
      type: `${id}.describe`,
      displayName: "Describe WordPress items",
      description: "Describe the selected content.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ids"],
        properties: {
          ids: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "string", pattern: WORDPRESS_ID_PATTERN },
          },
        },
      },
    },
  ];
}

function selectionFor(id: string) {
  return {
    actions: {
      browse: `${id}.browse`,
      search: `${id}.search`,
      describe: `${id}.describe`,
    },
    kinds: ["type", "category", "post", "page"],
    maxItems: 500,
  };
}

const syncFor = {
  supportsIncremental: false,
  defaultFrequencyMinutes: 360,
  minFrequencyMinutes: 60,
  resources: [
    {
      type: "wordpress_content",
      displayName: "Post or page",
      supportsDeleteDetection: true,
    },
  ],
};

const publicManifest = {
  type: PUBLIC_TYPE,
  displayName: "WordPress site",
  auth: { kind: "none" },
  sync: syncFor,
  actions: actionsFor(PUBLIC_TYPE),
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["siteUrl"],
    properties: { siteUrl: siteUrlSchema, items: itemsSchema },
  },
  selection: selectionFor(PUBLIC_TYPE),
} as unknown as ConnectorManifest;

const loginManifest = {
  type: LOGIN_TYPE,
  displayName: "WordPress site (login)",
  auth: { kind: "credential", scheme: "basic" },
  sync: syncFor,
  actions: actionsFor(LOGIN_TYPE),
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["siteUrl"],
    properties: {
      siteUrl: siteUrlSchema,
      items: itemsSchema,
      includeUnpublished: { type: "boolean", default: false },
    },
  },
  selection: selectionFor(LOGIN_TYPE),
} as unknown as ConnectorManifest;

// ---- Adapter doubles -------------------------------------------------------

/** Mirrors `wordPressCredentialIdentity`: a hash of the normalised site base
 * (trailing slash trimmed) and the username, never of the secret. */
function identityOf(
  config: Record<string, unknown>,
  credential: { username: string; secret: string },
) {
  const base = String(config.siteUrl).replace(/\/+$/, "");
  return createHash("sha256")
    .update(`${base}\n${credential.username}`)
    .digest("hex");
}

const credentialIdentity = vi.fn(identityOf);
const checkPublicReadiness = vi.fn();
const checkLoginReadiness = vi.fn();

const publicAdapter = {
  getManifest: () => publicManifest,
  checkSyncReadiness: checkPublicReadiness,
  async *discover() {},
  extract: async ({ item }: { item: unknown }) => ({ item }),
  executeAction: async () => ({ result: {} }),
} as unknown as ConnectorAdapter;

const loginAdapter = {
  getManifest: () => loginManifest,
  credentialIdentity,
  checkSyncReadiness: checkLoginReadiness,
  async *discover() {},
  extract: async ({ item }: { item: unknown }) => ({ item }),
  executeAction: async () => ({ result: {} }),
} as unknown as ConnectorAdapter;

const registry = new ConnectorRegistry([publicAdapter, loginAdapter]);
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

function createPublic(configJson: Record<string, unknown>, name = "Blog") {
  return service.createConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorType: PUBLIC_TYPE,
    name,
    configJson,
  });
}

function createLogin(
  configJson: Record<string, unknown>,
  overrides: Partial<Parameters<ConnectorService["createConnector"]>[0]> = {},
) {
  return service.createConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorType: LOGIN_TYPE,
    name: "Blog (login)",
    configJson,
    credential: { username: USERNAME, secret: SECRET },
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

function rotate(secret = ROTATED_SECRET, connectorId = "conn_1") {
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
  checkPublicReadiness.mockResolvedValue({ ready: true });
  checkLoginReadiness.mockResolvedValue({ ready: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- (a) none auth with a selection: empty selection is valid --------------

describe("the public WordPress connector (none auth) with an empty selection", () => {
  test("is created with items: [] and the readiness check ran with that config and no token", async () => {
    const config = { siteUrl: SITE, items: [] };

    const created = await createPublic(config);

    assert.deepEqual(created.connector.configJson, config);
    assert.equal(repo.createSourceConnectorRecord.mock.calls.length, 1);
    const readiness = checkPublicReadiness.mock.calls[0]?.[0];
    assert.deepEqual(readiness.config, config);
    assert.equal(readiness.accessToken, "");
  });

  test("is created with the items key omitted as well", async () => {
    const created = await createPublic({ siteUrl: SITE });
    assert.deepEqual(created.connector.configJson, { siteUrl: SITE });
  });

  test("is ready: the readiness endpoint reports ready, not selection_required", async () => {
    const result = await service.checkConfigReadiness({
      workspaceId: "workspace",
      userId: "user",
      connectorType: PUBLIC_TYPE,
      configJson: { siteUrl: SITE, items: [] },
    });
    assert.deepEqual(result, { ready: true });
  });

  test("can have its selection cleared to items: [] by a PATCH, which persists and re-checks readiness", async () => {
    await createPublic({ siteUrl: SITE, items: [CATEGORY, POST_TYPE] });
    checkPublicReadiness.mockClear();

    const updated = await patch("conn_1", { siteUrl: SITE, items: [] });

    assert.deepEqual(updated.connector.configJson, {
      siteUrl: SITE,
      items: [],
    });
    assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 1);
    assert.deepEqual(checkPublicReadiness.mock.calls.at(-1)?.[0].config, {
      siteUrl: SITE,
      items: [],
    });
  });

  test("a scheduled sync of an empty selection is not skipped: it is queued", async () => {
    await createPublic({ siteUrl: SITE, items: [] });
    repo.createSyncRunRecord.mockClear();

    const { enqueue, result } = scheduledRun(
      vi.fn(async () => ({ id: "job-1" })),
    );
    const outcome = await result;

    assert.equal(outcome.skipped, undefined);
    assert.equal(enqueue.mock.calls.length, 1);
    assert.equal(repo.createSyncRunRecord.mock.calls.length, 0);
  });

  test("the schema still rejects a malformed selection item, a duplicate item and a stray key", async () => {
    const bad: Array<Record<string, unknown>> = [
      { siteUrl: SITE, items: [{ id: "category:0", kind: "category" }] },
      { siteUrl: SITE, items: [{ id: "category:3" }] },
      { siteUrl: SITE, items: [CATEGORY, { ...CATEGORY }] },
      { siteUrl: "http://blog.example.com", items: [] },
      { siteUrl: SITE, items: [], extra: true },
    ];
    for (const config of bad) {
      const error = await rejection(createPublic(config));
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "CONNECTOR_SCHEMA_VALIDATION_FAILED");
    }
    assert.equal(repo.createSourceConnectorRecord.mock.calls.length, 0);
  });
});

// ---- (b) credential auth with a selection ----------------------------------

describe("the login WordPress connector (credential auth) with a selection", () => {
  test("is created together with its credential, with a selection, and the readiness check saw the entered credential", async () => {
    const config = {
      siteUrl: SITE,
      items: [CATEGORY],
      includeUnpublished: false,
    };

    const created = await createLogin(config);

    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 1);
    assert.deepEqual(created.connector.configJson, config);
    assert.equal(created.connector.credentialConfigured, true);
    assert.equal(created.connector.credentialDisplayName, USERNAME);
    assert.equal(
      checkLoginReadiness.mock.calls[0]?.[0].accessToken,
      JSON.stringify({ username: USERNAME, secret: SECRET }),
    );
    const persisted = repo.createCredentialConnectorRecord.mock.calls[0]?.[0];
    assert.equal(
      persisted.providerAccountId,
      identityOf(config, { username: USERNAME, secret: SECRET }),
    );
    assert.ok(!persisted.providerAccountId.includes(SECRET));
    assert.ok(!JSON.stringify(persisted.configJson).includes(SECRET));
    assert.deepEqual(JSON.parse(decrypt(persisted.accessTokenEncrypted)), {
      username: USERNAME,
      secret: SECRET,
    });
  });

  test("can be created with an empty selection (the adapter reports ready: an empty selection means everything)", async () => {
    const created = await createLogin({ siteUrl: SITE, items: [] });
    assert.deepEqual(created.connector.configJson, {
      siteUrl: SITE,
      items: [],
    });
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 1);
  });

  test("requires a credential: creating it without one is refused", async () => {
    const error = await rejection(
      createLogin({ siteUrl: SITE, items: [] }, { credential: undefined }),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_REQUIRED");
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("a second connector for the same site and username is a 409; another username is allowed", async () => {
    await createLogin({ siteUrl: SITE, items: [] }, { name: "First" });

    const error = await rejection(
      createLogin({ siteUrl: SITE, items: [CATEGORY] }, { name: "Second" }),
    );
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS");

    await createLogin(
      { siteUrl: SITE, items: [] },
      { name: "Third", credential: { username: "other", secret: SECRET } },
    );
    assert.equal(connectors.size, 2);
  });

  test("rotating only the secret keeps the identity; the readiness check is not re-run", async () => {
    await createLogin({ siteUrl: SITE, items: [CATEGORY] });
    const identityBefore = accounts.get("acc_1")?.providerAccountId;
    checkLoginReadiness.mockClear();

    await rotate();

    assert.equal(accounts.get("acc_1")?.providerAccountId, identityBefore);
    assert.equal(
      decrypt(String(accounts.get("acc_1")?.accessTokenEncrypted)),
      JSON.stringify({ username: USERNAME, secret: ROTATED_SECRET }),
    );
    assert.equal(checkLoginReadiness.mock.calls.length, 0);
  });

  test("a PATCH of the selection alone keeps the account, the identity and the credential", async () => {
    await createLogin({ siteUrl: SITE, items: [CATEGORY] });
    const identityBefore = accounts.get("acc_1")?.providerAccountId;
    const next = { siteUrl: SITE, items: [], includeUnpublished: false };

    const updated = await patch("conn_1", next);

    assert.deepEqual(updated.connector.configJson, next);
    assert.equal(updated.connector.credentialConfigured, true);
    assert.equal(accounts.get("acc_1")?.providerAccountId, identityBefore);
  });

  test("a PATCH that re-points siteUrl to another origin is refused by the endpoint lock and persists nothing", async () => {
    await createLogin({ siteUrl: SITE, items: [CATEGORY] });

    const error = await rejection(
      patch("conn_1", { siteUrl: OTHER_ORIGIN, items: [CATEGORY] }),
    );

    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_ENDPOINT_LOCKED");
    assert.ok(!error.message.includes("evil.example.org"));
    assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 0);
    assert.equal(connectors.get("conn_1")?.configJson.siteUrl, SITE);
  });

  // The platform does NOT compare credential identities on a PATCH: the account
  // keeps the identity it was created with (the Zotero and WebDAV tests pin the
  // same behaviour). The reconnect signal for a same-origin subfolder change
  // comes from the ADAPTER: its readiness check runs the stored credential
  // against the new site base and reports reauth_required when the site rejects
  // it, which marks the account. Rotating the credential then re-derives the
  // identity from the new config and returns the account to active.
  test("a same-origin siteUrl change is accepted, the adapter's reauth_required marks the account, and a rotate recovers it with the new identity", async () => {
    const original = { siteUrl: SITE, items: [CATEGORY] };
    await createLogin(original);
    const identityBefore = String(accounts.get("acc_1")?.providerAccountId);
    assert.equal(
      identityBefore,
      identityOf(original, { username: USERNAME, secret: SECRET }),
    );
    const next = { siteUrl: SUBFOLDER_SITE, items: [CATEGORY] };

    const updated = await patch("conn_1", next);

    assert.deepEqual(updated.connector.configJson, next);
    assert.equal(accounts.get("acc_1")?.providerAccountId, identityBefore);
    assert.equal(accounts.get("acc_1")?.status, "active");

    // The new site rejects the stored credential.
    checkLoginReadiness.mockClear();
    checkLoginReadiness.mockResolvedValue(REAUTH_READINESS);
    const skipped = await scheduledRun().result;

    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "reauth_required");
    const readiness = checkLoginReadiness.mock.calls[0]?.[0];
    assert.deepEqual(readiness.config, next);
    assert.equal(
      readiness.accessToken,
      JSON.stringify({ username: USERNAME, secret: SECRET }),
    );
    assert.equal(accounts.get("acc_1")?.status, "reauth_required");

    // Rotating re-derives the identity from the connector's CURRENT config.
    await rotate();

    const account = accounts.get("acc_1");
    assert.equal(account?.status, "active");
    assert.equal(
      account?.providerAccountId,
      identityOf(next, { username: USERNAME, secret: ROTATED_SECRET }),
    );
    assert.notEqual(account?.providerAccountId, identityBefore);
  });

  test("the identity changes with the site and the username but not with the secret", () => {
    const base = identityOf(
      { siteUrl: SITE },
      { username: USERNAME, secret: SECRET },
    );
    assert.equal(
      base,
      identityOf({ siteUrl: SITE }, { username: USERNAME, secret: "x" }),
    );
    assert.equal(
      base,
      identityOf({ siteUrl: `${SITE}/` }, { username: USERNAME, secret: "x" }),
    );
    assert.notEqual(
      base,
      identityOf(
        { siteUrl: SUBFOLDER_SITE },
        { username: USERNAME, secret: SECRET },
      ),
    );
    assert.notEqual(
      base,
      identityOf({ siteUrl: SITE }, { username: "other", secret: SECRET }),
    );
  });
});

// ---- (c) includeUnpublished ------------------------------------------------

describe("includeUnpublished", () => {
  test("round-trips through create and PATCH on the login connector", async () => {
    const created = await createLogin({
      siteUrl: SITE,
      items: [CATEGORY],
      includeUnpublished: true,
    });
    assert.equal(created.connector.configJson.includeUnpublished, true);
    assert.equal(
      checkLoginReadiness.mock.calls[0]?.[0].config.includeUnpublished,
      true,
    );
    assert.equal(connectors.get("conn_1")?.configJson.includeUnpublished, true);

    checkLoginReadiness.mockClear();
    const off = await patch("conn_1", {
      siteUrl: SITE,
      items: [CATEGORY],
      includeUnpublished: false,
    });
    assert.equal(off.connector.configJson.includeUnpublished, false);
    assert.equal(
      connectors.get("conn_1")?.configJson.includeUnpublished,
      false,
    );

    const on = await patch("conn_1", {
      siteUrl: SITE,
      items: [CATEGORY],
      includeUnpublished: true,
    });
    assert.equal(on.connector.configJson.includeUnpublished, true);
    assert.equal(connectors.get("conn_1")?.configJson.includeUnpublished, true);
  });

  test("a non-boolean value is rejected on the login connector", async () => {
    const error = await rejection(
      createLogin({ siteUrl: SITE, items: [], includeUnpublished: "yes" }),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_SCHEMA_VALIDATION_FAILED");
    assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("is rejected by the schema on the public connector, on create and on PATCH, persisting nothing", async () => {
    const createError = await rejection(
      createPublic({ siteUrl: SITE, items: [], includeUnpublished: true }),
    );
    assert.equal(createError.statusCode, 400);
    assert.equal(createError.code, "CONNECTOR_SCHEMA_VALIDATION_FAILED");
    assert.equal(repo.createSourceConnectorRecord.mock.calls.length, 0);

    await createPublic({ siteUrl: SITE, items: [] });
    const patchError = await rejection(
      patch("conn_1", { siteUrl: SITE, items: [], includeUnpublished: true }),
    );
    assert.equal(patchError.statusCode, 400);
    assert.equal(patchError.code, "CONNECTOR_SCHEMA_VALIDATION_FAILED");
    assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 0);
    assert.deepEqual(connectors.get("conn_1")?.configJson, {
      siteUrl: SITE,
      items: [],
    });
  });
});
