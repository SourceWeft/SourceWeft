import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import {
  pollCredentialFlowResponseSchema,
  startCredentialFlowResponseSchema,
} from "@sourceweft/contracts";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

const mocks = vi.hoisted(() => ({
  requireConnectorWorkspace: vi.fn(),
  encryptTeamSecret: vi.fn(),
  decryptTeamSecret: vi.fn(),
  getTeamSecretCipher: vi.fn(),
  // repository
  countLiveCredentialFlowRecords: vi.fn(),
  deleteExpiredCredentialFlowRecords: vi.fn(),
  createOAuthStateRecord: vi.fn(),
  findOAuthStateRecord: vi.fn(),
  claimCredentialFlowRecord: vi.fn(),
  deleteCredentialFlowRecord: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
  findSourceConnectorRecordByName: vi.fn(),
  findOAuthAccountByProviderAccountInWorkspace: vi.fn(),
  createCredentialConnectorRecord: vi.fn(),
  getConnectorScheduleStatus: vi.fn(),
  findOAuthAccountRecord: vi.fn(),
  updateOAuthAccountCredentialRecord: vi.fn(),
  updateSourceConnectorRecord: vi.fn(),
  hasOtherSourceConnectorOAuthAccountReferences: vi.fn(),
  hardDeleteSourceConnectorRecord: vi.fn(),
}));

vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.requireConnectorWorkspace,
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: mocks.encryptTeamSecret,
  decryptTeamSecret: mocks.decryptTeamSecret,
  getTeamSecretCipher: mocks.getTeamSecretCipher,
}));
vi.mock("./repository", () => ({
  countLiveCredentialFlowRecords: mocks.countLiveCredentialFlowRecords,
  deleteExpiredCredentialFlowRecords: mocks.deleteExpiredCredentialFlowRecords,
  createOAuthStateRecord: mocks.createOAuthStateRecord,
  findOAuthStateRecord: mocks.findOAuthStateRecord,
  claimCredentialFlowRecord: mocks.claimCredentialFlowRecord,
  deleteCredentialFlowRecord: mocks.deleteCredentialFlowRecord,
  findSourceConnectorRecord: mocks.findSourceConnectorRecord,
  findSourceConnectorRecordByName: mocks.findSourceConnectorRecordByName,
  findOAuthAccountByProviderAccountInWorkspace:
    mocks.findOAuthAccountByProviderAccountInWorkspace,
  createCredentialConnectorRecord: mocks.createCredentialConnectorRecord,
  getConnectorScheduleStatus: mocks.getConnectorScheduleStatus,
  findOAuthAccountRecord: mocks.findOAuthAccountRecord,
  updateOAuthAccountCredentialRecord: mocks.updateOAuthAccountCredentialRecord,
  updateSourceConnectorRecord: mocks.updateSourceConnectorRecord,
  hasOtherSourceConnectorOAuthAccountReferences:
    mocks.hasOtherSourceConnectorOAuthAccountReferences,
  hardDeleteSourceConnectorRecord: mocks.hardDeleteSourceConnectorRecord,
}));

import { logger } from "../../shared/logger";
import { ConnectorCredentialFlowService } from "./credential-flow";
import { ConnectorService } from "./service";

const SECRET = "nc-app-password-DO-NOT-LOG-5a7c";
const POLL_TOKEN = "poll-token-SECRET-9f3a2b";
const LOGIN_NAME = "nc-user";
const SERVER = "https://cloud.example.com";
const ENDPOINT = "https://cloud.example.com/remote.php/dav/files/nc-user/";
const CONNECTOR_TYPE = "nextcloud";
const LOGIN_URL = "https://cloud.example.com/index.php/login/v2/flow/abc";
const ADAPTER_CONFIG = {
  server: SERVER,
  endpoint: ENDPOINT,
  userId: LOGIN_NAME,
};

const flowStart = vi.fn();
const flowPoll = vi.fn();
const flowDiscard = vi.fn();
const credentialIdentity = vi.fn();

function loginFlowManifest(): ConnectorManifest {
  return {
    type: CONNECTOR_TYPE,
    displayName: "Nextcloud",
    auth: { kind: "credential", scheme: "basic", flow: "login_flow" },
    sync: {
      supportsIncremental: true,
      defaultFrequencyMinutes: 360,
      resources: [],
    },
    actions: [],
    configSchema: { type: "object" },
  } as ConnectorManifest;
}

function loginFlowAdapter(): ConnectorAdapter {
  const m = loginFlowManifest();
  return {
    getManifest: () => m,
    credentialIdentity,
    credentialFlow: { start: flowStart, poll: flowPoll, discard: flowDiscard },
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item, contentText: "" }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

/** A credential adapter WITHOUT a login flow — unsupported by these routes. */
function plainCredentialAdapter(): ConnectorAdapter {
  const m = loginFlowManifest();
  m.auth = { kind: "credential", scheme: "basic" };
  return {
    getManifest: () => m,
    credentialIdentity,
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item, contentText: "" }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

const CONNECTOR = {
  id: "conn_nc",
  teamId: "team",
  workspaceId: "workspace",
  connectorType: CONNECTOR_TYPE,
  name: "My Nextcloud",
  configJson: {
    server: SERVER,
    endpoint: ENDPOINT,
    userId: LOGIN_NAME,
    roots: ["/"],
  },
  oauthAccountId: "acc_nc",
  status: "active" as const,
  periodicIndexingEnabled: false,
  indexingFrequencyMinutes: null,
  lastIndexedAt: null,
  nextScheduledAt: null,
  lastError: null,
  createdBy: "user_1",
  createdAt: "2026-11-26T00:00:00.000Z",
  updatedAt: "2026-11-26T00:00:00.000Z",
};

const ACCOUNT = {
  id: "acc_nc",
  teamId: "team",
  workspaceId: "workspace",
  connectorType: CONNECTOR_TYPE,
  providerAccountId: `pid:${ENDPOINT}#${LOGIN_NAME}`,
  providerAccountEmail: null,
  displayName: LOGIN_NAME,
  scopes: [] as string[],
  status: "active" as const,
  expiresAt: null,
  lastRefreshAt: null,
  lastError: null,
  createdBy: "user_1",
  createdAt: "2026-11-26T00:00:00.000Z",
  updatedAt: "2026-11-26T00:00:00.000Z",
  accessTokenEncrypted: `enc:${JSON.stringify({ username: LOGIN_NAME, secret: SECRET })}`,
  refreshTokenEncrypted: null,
};

function services(adapter: ConnectorAdapter = loginFlowAdapter()) {
  const registry = new ConnectorRegistry([adapter]);
  const service = new ConnectorService(registry);
  const flow = new ConnectorCredentialFlowService(service, registry);
  return { registry, service, flow, adapter };
}

function storedBlob(overrides: Record<string, unknown> = {}) {
  const blob = {
    pending: {
      pollEndpoint: `${SERVER}/index.php/login/v2/poll`,
      pollToken: POLL_TOKEN,
      serverUrl: SERVER,
    },
    name: "My Nextcloud",
    roots: ["/"],
    periodicIndexingEnabled: false,
    ...overrides,
  };
  return `enc:${JSON.stringify(blob)}`;
}

function stateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "state_1",
    stateHash: "hash",
    teamId: "team",
    workspaceId: "workspace",
    userId: "user_1",
    connectorType: CONNECTOR_TYPE,
    redirectAfter: null,
    expiresAt: new Date(Date.now() + 600_000),
    consumedAt: null,
    attemptRef: storedBlob(),
    createdAt: new Date(),
    ...overrides,
  };
}

const AUTHORIZED = {
  status: "authorized" as const,
  credential: { username: LOGIN_NAME, secret: SECRET },
  config: ADAPTER_CONFIG,
};

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace",
    userId: "user_1",
    connectorType: CONNECTOR_TYPE,
    serverUrl: SERVER,
    name: "My Nextcloud",
    roots: ["/Docs/"],
    periodicIndexingEnabled: true,
    ...overrides,
  };
}

function pollInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace",
    userId: "user_1",
    connectorType: CONNECTOR_TYPE,
    flowId: "flow-id-0123456789abcdef",
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode?: number; code?: string; message: string };
  }
  throw new Error("expected the promise to reject");
}

function loggedText(...spies: Array<ReturnType<typeof vi.spyOn>>) {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.encryptTeamSecret.mockImplementation(
    async (plain: string) => `enc:${plain}`,
  );
  mocks.decryptTeamSecret.mockImplementation(async (cipher: string | null) =>
    typeof cipher === "string" && cipher.startsWith("enc:")
      ? cipher.slice(4)
      : "",
  );
  mocks.deleteExpiredCredentialFlowRecords.mockResolvedValue(0);
  mocks.countLiveCredentialFlowRecords.mockResolvedValue(0);
  mocks.createOAuthStateRecord.mockResolvedValue({ id: "state_1" });
  mocks.claimCredentialFlowRecord.mockResolvedValue(true);
  mocks.deleteCredentialFlowRecord.mockResolvedValue(true);
  mocks.findSourceConnectorRecordByName.mockResolvedValue(null);
  mocks.findOAuthAccountByProviderAccountInWorkspace.mockResolvedValue(null);
  mocks.createCredentialConnectorRecord.mockResolvedValue({
    connector: CONNECTOR,
    accountId: "acc_nc",
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(CONNECTOR);
  mocks.getConnectorScheduleStatus.mockResolvedValue(null);
  mocks.findOAuthAccountRecord.mockResolvedValue(ACCOUNT);
  mocks.updateOAuthAccountCredentialRecord.mockResolvedValue(ACCOUNT);
  mocks.updateSourceConnectorRecord.mockResolvedValue(CONNECTOR);
  mocks.hasOtherSourceConnectorOAuthAccountReferences.mockResolvedValue(false);
  mocks.hardDeleteSourceConnectorRecord.mockResolvedValue({
    connectorDeleted: true,
    sourcesDeleted: 0,
    documentsDeleted: 0,
    authorizationDeleted: true,
  });
  credentialIdentity.mockImplementation(
    (
      config: Record<string, unknown>,
      credential: { username: string; secret: string },
    ) => `pid:${String(config.endpoint)}#${credential.username}`,
  );
  flowStart.mockResolvedValue({
    loginUrl: LOGIN_URL,
    pending: {
      pollEndpoint: `${SERVER}/index.php/login/v2/poll`,
      pollToken: POLL_TOKEN,
      serverUrl: SERVER,
    },
  });
  flowPoll.mockResolvedValue({ status: "pending" });
  flowDiscard.mockResolvedValue(undefined);
});

describe("start", () => {
  test("stores an encrypted pending blob and returns only flowId and loginUrl", async () => {
    const { flow } = services();
    const result = await flow.start(startInput());

    assert.doesNotThrow(() => startCredentialFlowResponseSchema.parse(result));
    assert.ok(result.flowId.length >= 16);
    assert.equal(result.loginUrl, LOGIN_URL);
    // The response carries neither the poll token nor any secret.
    assert.ok(!JSON.stringify(result).includes(POLL_TOKEN));
    assert.ok(!JSON.stringify(result).includes(SECRET));

    // The blob handed to encryption carries the pending poll token, and that
    // ciphertext (not the plaintext) is what the row stores.
    const encryptArg = mocks.encryptTeamSecret.mock.calls[0]?.[0] as string;
    const blob = JSON.parse(encryptArg);
    assert.equal(blob.pending.pollToken, POLL_TOKEN);
    assert.equal(blob.name, "My Nextcloud");
    assert.deepEqual(blob.roots, ["/Docs/"]);
    assert.equal(blob.periodicIndexingEnabled, true);

    const stored = mocks.createOAuthStateRecord.mock.calls[0]?.[0];
    assert.equal(stored.attemptRef, `enc:${encryptArg}`);
    assert.equal(stored.connectorType, CONNECTOR_TYPE);
    assert.equal(stored.userId, "user_1");
    assert.equal(stored.teamId, "team");
    // Only the hash of the flow id is stored, never the id itself.
    assert.notEqual(stored.stateHash, result.flowId);
    assert.match(stored.stateHash, /^[0-9a-f]{64}$/);
    assert.ok(stored.expiresAt instanceof Date);
  });

  test("rejects an unregistered connector type with a fixed 400", async () => {
    const { flow } = services();
    const error = await rejection(
      flow.start(startInput({ connectorType: "not-registered" })),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_FLOW_UNSUPPORTED");
    assert.equal(mocks.createOAuthStateRecord.mock.calls.length, 0);
    assert.equal(flowStart.mock.calls.length, 0);
  });

  test("rejects a credential connector that declares no login flow", async () => {
    const { flow } = services(plainCredentialAdapter());
    const error = await rejection(flow.start(startInput()));
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_FLOW_UNSUPPORTED");
    assert.equal(mocks.createOAuthStateRecord.mock.calls.length, 0);
  });

  test("rejects once the user already has the maximum live flows (429)", async () => {
    mocks.countLiveCredentialFlowRecords.mockResolvedValue(5);
    const { flow } = services();
    const error = await rejection(flow.start(startInput()));
    assert.equal(error.statusCode, 429);
    assert.equal(error.code, "CONNECTOR_CREDENTIAL_FLOW_LIMIT");
    // Never reaches the provider and persists nothing.
    assert.equal(flowStart.mock.calls.length, 0);
    assert.equal(mocks.createOAuthStateRecord.mock.calls.length, 0);
  });

  test("cleans up this type's expired flow rows before starting", async () => {
    const { flow } = services();
    await flow.start(startInput());
    assert.equal(mocks.deleteExpiredCredentialFlowRecords.mock.calls.length, 1);
    assert.equal(
      mocks.deleteExpiredCredentialFlowRecords.mock.calls[0]?.[0].connectorType,
      CONNECTOR_TYPE,
    );
  });

  test("reconnect rejects a connectorId that is not a connector of this type", async () => {
    mocks.findSourceConnectorRecord.mockResolvedValue(null);
    const { flow } = services();
    const error = await rejection(
      flow.start(startInput({ connectorId: "conn_missing" })),
    );
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "CONNECTOR_NOT_FOUND");
    assert.equal(flowStart.mock.calls.length, 0);
    assert.equal(mocks.createOAuthStateRecord.mock.calls.length, 0);
  });
});

describe("poll", () => {
  test("returns pending while the provider has not authorized", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(stateRow());
    flowPoll.mockResolvedValue({ status: "pending" });
    const { flow } = services();

    const result = await flow.poll(pollInput());

    assert.deepEqual(result, { status: "pending" });
    assert.equal(flowPoll.mock.calls.length, 1);
    assert.equal(mocks.claimCredentialFlowRecord.mock.calls.length, 0);
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("an unknown flow id returns expired with no upstream poll", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(null);
    const { flow } = services();

    const result = await flow.poll(pollInput());

    assert.deepEqual(result, { status: "expired" });
    assert.equal(flowPoll.mock.calls.length, 0);
  });

  test("another user's flow returns the same expired answer", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(
      stateRow({ userId: "user_2" }),
    );
    const { flow } = services();

    const result = await flow.poll(pollInput());

    assert.deepEqual(result, { status: "expired" });
    assert.equal(flowPoll.mock.calls.length, 0);
  });

  test("a flow in another workspace returns expired", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(
      stateRow({ workspaceId: "workspace_other" }),
    );
    const { flow } = services();

    const result = await flow.poll(pollInput());

    assert.deepEqual(result, { status: "expired" });
    assert.equal(flowPoll.mock.calls.length, 0);
  });

  test("throttles upstream polls to one per second per flow", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(stateRow());
    flowPoll.mockResolvedValue({ status: "pending" });
    const { flow } = services();

    const first = await flow.poll(pollInput());
    const second = await flow.poll(pollInput());

    assert.deepEqual(first, { status: "pending" });
    assert.deepEqual(second, { status: "pending" });
    // The second poll is throttled: the provider is polled only once.
    assert.equal(flowPoll.mock.calls.length, 1);
  });

  test("authorized claims the row before creating the connector, and the response carries no secret", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(stateRow());
    flowPoll.mockResolvedValue(AUTHORIZED);
    const { flow } = services();

    const result = await flow.poll(pollInput());

    assert.equal(result.status, "connected");
    assert.doesNotThrow(() => pollCredentialFlowResponseSchema.parse(result));
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.ok(!JSON.stringify(result).includes(POLL_TOKEN));

    // Exactly one connector is created, with the adapter config plus the stored
    // roots and no secret in the config.
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 1);
    const persisted = mocks.createCredentialConnectorRecord.mock.calls[0]?.[0];
    assert.equal(persisted.configJson.endpoint, ENDPOINT);
    assert.deepEqual(persisted.configJson.roots, ["/"]);
    assert.ok(!JSON.stringify(persisted.configJson).includes(SECRET));

    // The row is claimed BEFORE the authorized credential is used. Both calls
    // happened (asserted above via their call counts), so each has a first
    // invocation order; `!` narrows away the `number | undefined` index access.
    assert.ok(
      mocks.claimCredentialFlowRecord.mock.invocationCallOrder[0]! <
        mocks.createCredentialConnectorRecord.mock.invocationCallOrder[0]!,
    );
  });

  test("a second poll after success returns expired and creates no second connector", async () => {
    mocks.findOAuthStateRecord
      .mockResolvedValueOnce(stateRow())
      .mockResolvedValue(null);
    flowPoll.mockResolvedValueOnce(AUTHORIZED);
    mocks.claimCredentialFlowRecord.mockResolvedValueOnce(true);
    const { flow } = services();

    const first = await flow.poll(pollInput());
    const second = await flow.poll(pollInput());

    assert.equal(first.status, "connected");
    assert.deepEqual(second, { status: "expired" });
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 1);
  });

  test("a completion that loses the claim discards the password and returns expired", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(stateRow());
    flowPoll.mockResolvedValue(AUTHORIZED);
    mocks.claimCredentialFlowRecord.mockResolvedValue(false);
    const { flow } = services();

    const result = await flow.poll(pollInput());

    assert.deepEqual(result, { status: "expired" });
    assert.equal(flowDiscard.mock.calls.length, 1);
    assert.deepEqual(flowDiscard.mock.calls[0]?.[0], {
      config: ADAPTER_CONFIG,
      credential: { username: LOGIN_NAME, secret: SECRET },
    });
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("a creation failure after authorization discards the password once and throws a fixed error", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(stateRow());
    flowPoll.mockResolvedValue(AUTHORIZED);
    mocks.createCredentialConnectorRecord.mockRejectedValue(
      new Error("db exploded carrying " + SECRET),
    );
    const { flow } = services();

    const error = await rejection(flow.poll(pollInput()));

    assert.equal(error.code, "CONNECTOR_CREDENTIAL_FLOW_FAILED");
    // The underlying message (which could carry input) is not surfaced.
    assert.ok(!error.message.includes(SECRET));
    assert.equal(flowDiscard.mock.calls.length, 1);
  });

  test("a fixed-code creation error is surfaced after discarding", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(stateRow());
    flowPoll.mockResolvedValue(AUTHORIZED);
    // An account for this endpoint/user already exists -> createConnector throws
    // CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS, a fixed enumerated code.
    mocks.findOAuthAccountByProviderAccountInWorkspace.mockResolvedValue(
      ACCOUNT,
    );
    const { flow } = services();

    const error = await rejection(flow.poll(pollInput()));

    assert.equal(error.code, "CONNECTOR_CREDENTIAL_ACCOUNT_EXISTS");
    assert.equal(flowDiscard.mock.calls.length, 1);
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
  });

  test("reconnect rotates the credential in place when server and user match", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(
      stateRow({ attemptRef: storedBlob({ connectorId: "conn_nc" }) }),
    );
    flowPoll.mockResolvedValue(AUTHORIZED);
    const { flow } = services();

    const result = await flow.poll(pollInput());

    assert.equal(result.status, "connected");
    assert.equal(mocks.updateOAuthAccountCredentialRecord.mock.calls.length, 1);
    // No new connector/account is created on a reconnect.
    assert.equal(mocks.createCredentialConnectorRecord.mock.calls.length, 0);
    assert.equal(flowDiscard.mock.calls.length, 0);
  });

  test("reconnect rejects a different server origin and discards", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(
      stateRow({ attemptRef: storedBlob({ connectorId: "conn_nc" }) }),
    );
    flowPoll.mockResolvedValue({
      ...AUTHORIZED,
      config: { ...ADAPTER_CONFIG, endpoint: "https://evil.example.com/dav/" },
    });
    const { flow } = services();

    const error = await rejection(flow.poll(pollInput()));

    assert.equal(error.code, "CONNECTOR_CREDENTIAL_FLOW_MISMATCH");
    assert.ok(!error.message.includes("evil.example.com"));
    assert.equal(flowDiscard.mock.calls.length, 1);
    assert.equal(mocks.updateOAuthAccountCredentialRecord.mock.calls.length, 0);
  });

  test("reconnect rejects a different login name and discards", async () => {
    mocks.findOAuthStateRecord.mockResolvedValue(
      stateRow({ attemptRef: storedBlob({ connectorId: "conn_nc" }) }),
    );
    flowPoll.mockResolvedValue({
      ...AUTHORIZED,
      credential: { username: "someone-else", secret: SECRET },
    });
    const { flow } = services();

    const error = await rejection(flow.poll(pollInput()));

    assert.equal(error.code, "CONNECTOR_CREDENTIAL_FLOW_MISMATCH");
    assert.equal(flowDiscard.mock.calls.length, 1);
    assert.equal(mocks.updateOAuthAccountCredentialRecord.mock.calls.length, 0);
  });
});

describe("cancel", () => {
  test("deletes the owner's flow and reports canceled", async () => {
    const { flow } = services();
    const result = await flow.cancel({
      workspaceId: "workspace",
      userId: "user_1",
      connectorType: CONNECTOR_TYPE,
      flowId: "flow-id-0123456789abcdef",
    });
    assert.deepEqual(result, { canceled: true });
    const call = mocks.deleteCredentialFlowRecord.mock.calls[0]?.[0];
    assert.equal(call.userId, "user_1");
    assert.equal(call.workspaceId, "workspace");
    assert.equal(call.connectorType, CONNECTOR_TYPE);
  });

  test("a non-owner cancel affects nothing but returns the same answer", async () => {
    mocks.deleteCredentialFlowRecord.mockResolvedValue(false);
    const { flow } = services();
    const result = await flow.cancel({
      workspaceId: "workspace",
      userId: "user_2",
      connectorType: CONNECTOR_TYPE,
      flowId: "flow-id-0123456789abcdef",
    });
    assert.deepEqual(result, { canceled: true });
  });
});

describe("delete revokes the credential best-effort", () => {
  test("deleteConnector discards the credential and still hard-deletes when discard throws", async () => {
    flowDiscard.mockRejectedValue(new Error("nextcloud unreachable"));
    const { service } = services();

    const result = await service.deleteConnector({
      workspaceId: "workspace",
      userId: "user_1",
      connectorId: "conn_nc",
    });

    assert.equal(result.hardDeleted, true);
    // The adapter was asked to discard the decrypted credential, once.
    assert.equal(flowDiscard.mock.calls.length, 1);
    assert.deepEqual(flowDiscard.mock.calls[0]?.[0].credential, {
      username: LOGIN_NAME,
      secret: SECRET,
    });
    // A discard failure never blocks the delete.
    assert.equal(mocks.hardDeleteSourceConnectorRecord.mock.calls.length, 1);
  });
});

describe("the credential-flow service never logs a secret", () => {
  test("start, poll and a reconnect mismatch emit no log line carrying the secret", async () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    const error = vi.spyOn(logger, "error");
    const debug = vi.spyOn(logger, "debug");

    const { flow } = services();
    await flow.start(startInput());

    mocks.findOAuthStateRecord.mockResolvedValue(
      stateRow({ attemptRef: storedBlob({ connectorId: "conn_nc" }) }),
    );
    flowPoll.mockResolvedValue({
      ...AUTHORIZED,
      config: { ...ADAPTER_CONFIG, endpoint: "https://evil.example.com/dav/" },
    });
    flowDiscard.mockRejectedValue(new Error("discard failed"));
    await rejection(flow.poll(pollInput()));

    const text = loggedText(info, warn, error, debug);
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes(POLL_TOKEN));
    assert.ok(!text.includes(LOGIN_NAME));

    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    debug.mockRestore();
  });
});
