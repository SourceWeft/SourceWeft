import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOAuthAccountRecord: vi.fn(),
  listOAuthAccountsDueForKeepAlive: vi.fn(),
  decryptTeamSecret: vi.fn(),
  encryptTeamSecret: vi.fn(),
  getTeamSecretCipher: vi.fn(),
}));

vi.mock("../../shared/config", () => ({
  config: { auth: { baseUrl: "https://api.sourceweft.test" } },
}));
vi.mock("../../shared/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: mocks.encryptTeamSecret,
  decryptTeamSecret: mocks.decryptTeamSecret,
  getTeamSecretCipher: mocks.getTeamSecretCipher,
}));
vi.mock("./repository", () => ({
  findOAuthAccountRecord: mocks.findOAuthAccountRecord,
  listOAuthAccountsDueForKeepAlive: mocks.listOAuthAccountsDueForKeepAlive,
}));

import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

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
      resources: [],
    },
    actions: [],
    configSchema: { type: "object" },
  } as ConnectorManifest;
}

function credentialAdapter(): ConnectorAdapter {
  return {
    getManifest: () => manifest("webdav", { kind: "credential", scheme: "basic" }),
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item, contentText: "" }),
    executeAction: async () => ({ result: {} }),
    credentialIdentity: () => "pid",
  } as unknown as ConnectorAdapter;
}

function oauth2Adapter(): ConnectorAdapter {
  return {
    getManifest: () =>
      manifest("gmail", {
        kind: "oauth2",
        authorizationUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        scopes: [],
      }),
    exchangeOAuthCode: vi.fn(),
    refreshOAuthToken: vi.fn(),
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item, contentText: "" }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getRuntimeToken for a credential account", () => {
  test("returns the decrypted username/secret JSON unchanged", async () => {
    const json = JSON.stringify({ username: "dav-user", secret: "s3cr3t" });
    mocks.findOAuthAccountRecord.mockResolvedValue({
      id: "acc",
      teamId: "team",
      workspaceId: "workspace",
      connectorType: "webdav",
      status: "active",
      expiresAt: null,
      accessTokenEncrypted: "enc:value",
      refreshTokenEncrypted: null,
    });
    mocks.decryptTeamSecret.mockResolvedValue(json);

    const service = new ConnectorOAuthService(
      new ConnectorRegistry([credentialAdapter()]),
    );
    const token = await service.getRuntimeToken({
      teamId: "team",
      workspaceId: "workspace",
      accountId: "acc",
      connectorType: "webdav",
    });

    assert.equal(token, json);
    assert.deepEqual(mocks.decryptTeamSecret.mock.calls[0], ["enc:value", "team"]);
  });
});

describe("refreshIdleAccounts never sweeps credential accounts", () => {
  test("excludes credential connector types from the keep-alive candidates", async () => {
    mocks.listOAuthAccountsDueForKeepAlive.mockResolvedValue([]);
    const service = new ConnectorOAuthService(
      new ConnectorRegistry([oauth2Adapter(), credentialAdapter()]),
    );

    await service.refreshIdleAccounts({ now: new Date("2026-11-24T00:00:00Z") });

    const query = mocks.listOAuthAccountsDueForKeepAlive.mock.calls[0]?.[0];
    assert.ok(query.connectorTypes.includes("gmail"));
    assert.ok(!query.connectorTypes.includes("webdav"));
  });
});
