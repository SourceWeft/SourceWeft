import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import { ConnectorRegistry } from "./registry";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

const mocks = vi.hoisted(() => ({
  createSourceConnectorRecord: vi.fn(),
  findOAuthAccountRecord: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
  findSourceConnectorRecordByName: vi.fn(),
  getConnectorScheduleStatus: vi.fn(),
  hardDeleteSourceConnectorRecord: vi.fn(),
  hasOtherSourceConnectorOAuthAccountReferences: vi.fn(),
  listSourceConnectorRecords: vi.fn(),
  putConnectorSchedule: vi.fn(),
  requireConnectorWorkspace: vi.fn(),
  revokeStoredAuthorization: vi.fn(),
  updateSourceConnectorRecord: vi.fn(),
}));

vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.requireConnectorWorkspace,
}));

vi.mock("./repository", () => ({
  createSourceConnectorRecord: mocks.createSourceConnectorRecord,
  findOAuthAccountRecord: mocks.findOAuthAccountRecord,
  findSourceConnectorRecord: mocks.findSourceConnectorRecord,
  findSourceConnectorRecordByName: mocks.findSourceConnectorRecordByName,
  getConnectorScheduleStatus: mocks.getConnectorScheduleStatus,
  hardDeleteSourceConnectorRecord: mocks.hardDeleteSourceConnectorRecord,
  hasOtherSourceConnectorOAuthAccountReferences:
    mocks.hasOtherSourceConnectorOAuthAccountReferences,
  listSourceConnectorRecords: mocks.listSourceConnectorRecords,
  putConnectorSchedule: mocks.putConnectorSchedule,
  updateSourceConnectorRecord: mocks.updateSourceConnectorRecord,
}));

import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorService } from "./service";

const configSchema = {
  type: "object",
  required: ["feedUrl"],
  properties: { feedUrl: { type: "string" } },
  additionalProperties: false,
};

type TestAuth = { kind: "none" | "oauth2" } | undefined;

function manifest(type: string, auth: TestAuth): ConnectorManifest {
  return {
    type,
    displayName: type,
    ...(auth ? { auth } : {}),
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

const checkSyncReadiness = vi.fn();

function adapter(
  type: string,
  auth: TestAuth,
  withReadiness = true,
): ConnectorAdapter {
  const m = manifest(type, auth);
  return {
    getManifest: () => m,
    ...(auth?.kind === "none"
      ? {}
      : { exchangeOAuthCode: vi.fn(), refreshOAuthToken: vi.fn() }),
    ...(withReadiness ? { checkSyncReadiness } : {}),
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

function registryFor(...adapters: ConnectorAdapter[]) {
  // A manifest without `auth` (existing test doubles) cannot pass the real
  // registry's shape check, so such adapters are served by a stub.
  if (adapters.some((item) => item.getManifest().auth === undefined)) {
    const byType = new Map(
      adapters.map((item) => [item.getManifest().type, item]),
    );
    return {
      getAdapter: (type: string) => byType.get(type),
      getManifest: (type: string) => byType.get(type)?.getManifest(),
      listManifests: () => adapters.map((item) => item.getManifest()),
    } as unknown as ConnectorRegistry;
  }
  return new ConnectorRegistry(adapters);
}

function service(registry: ConnectorRegistry) {
  return new ConnectorService(registry);
}

const noneRegistry = () =>
  registryFor(
    adapter("public-feed", { kind: "none" }),
    adapter("other-feed", { kind: "none" }),
  );

const FEED = { feedUrl: "https://example.com/feed.xml" };

const createdConnector = {
  id: "created",
  teamId: "team",
  workspaceId: "workspace",
  connectorType: "public-feed",
  name: "Feed",
  configJson: FEED,
  oauthAccountId: null,
  status: "active",
  periodicIndexingEnabled: false,
  indexingFrequencyMinutes: null,
};

function create(
  svc: ConnectorService,
  overrides: Partial<Parameters<ConnectorService["createConnector"]>[0]> = {},
) {
  return svc.createConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorType: "public-feed",
    name: "Feed",
    configJson: FEED,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecordByName.mockResolvedValue(null);
  mocks.listSourceConnectorRecords.mockResolvedValue([]);
  mocks.createSourceConnectorRecord.mockResolvedValue(createdConnector);
  mocks.findSourceConnectorRecord.mockResolvedValue(createdConnector);
  mocks.getConnectorScheduleStatus.mockResolvedValue(null);
  checkSyncReadiness.mockResolvedValue({ ready: true });
});

describe("createConnector for a none connector", () => {
  test("rejects an OAuth account and persists nothing", async () => {
    const error = await rejection(
      create(service(noneRegistry()), { oauthAccountId: "account" }),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_OAUTH_ACCOUNT_NOT_ALLOWED");
    assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 0);
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
  });

  test("persists a ready connector with oauthAccountId null", async () => {
    const result = await create(service(noneRegistry()));

    assert.equal(result.connector.id, "created");
    assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 1);
    const persisted = mocks.createSourceConnectorRecord.mock.calls[0]?.[0];
    assert.equal(persisted.oauthAccountId, null);
    assert.deepEqual(persisted.configJson, FEED);
    assert.equal(mocks.findOAuthAccountRecord.mock.calls.length, 0);
    assert.deepEqual(checkSyncReadiness.mock.calls[0]?.[0], {
      teamId: "team",
      workspaceId: "workspace",
      connectorId: "pending",
      connectorType: "public-feed",
      connectorName: "Feed",
      config: FEED,
      accessToken: "",
    });
  });

  test("a connector whose adapter has no readiness check persists", async () => {
    const registry = registryFor(
      adapter("public-feed", { kind: "none" }, false),
    );
    await create(service(registry));
    assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 1);
  });

  test("a not-ready config is rejected with the reason and nothing persisted", async () => {
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "feed_timeout",
      message: "The feed did not respond in time.",
    });

    const error = await rejection(create(service(noneRegistry())));
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CONFIG_NOT_READY");
    assert.equal(error.message, "The feed did not respond in time.");
    assert.equal(error.details?.reason, "feed_timeout");
    assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 0);
  });

  test("an invalid config is rejected before readiness runs", async () => {
    const error = await rejection(
      create(service(noneRegistry()), { configJson: {} }),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
    assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 0);
  });

  test("a name conflict is rejected before readiness runs", async () => {
    mocks.findSourceConnectorRecordByName.mockResolvedValue({
      id: "same-name",
      status: "active",
    });
    const error = await rejection(create(service(noneRegistry())));
    assert.equal(error.code, "CONNECTOR_ALREADY_EXISTS");
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
  });

  describe("duplicate configuration in the workspace", () => {
    function existing(overrides: Record<string, unknown> = {}) {
      return {
        id: "existing",
        connectorType: "public-feed",
        name: "Other name",
        status: "active",
        configJson: { feedUrl: "https://example.com/feed.xml" },
        ...overrides,
      };
    }

    test("identical config is rejected, nothing persisted, readiness not called", async () => {
      mocks.listSourceConnectorRecords.mockResolvedValue([existing()]);

      const error = await rejection(create(service(noneRegistry())));
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "CONNECTOR_ALREADY_EXISTS");
      assert.match(error.message, /same configuration/);
      assert.equal(error.details?.connectorId, "existing");
      assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 0);
      assert.equal(checkSyncReadiness.mock.calls.length, 0);
      assert.deepEqual(mocks.listSourceConnectorRecords.mock.calls[0]?.[0], {
        teamId: "team",
        workspaceId: "workspace",
        includeDisabled: true,
      });
    });

    test("a different config is allowed", async () => {
      mocks.listSourceConnectorRecords.mockResolvedValue([
        existing({ configJson: { feedUrl: "https://example.com/other.xml" } }),
      ]);
      await create(service(noneRegistry()));
      assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 1);
    });

    test("the same config under a different connector type is allowed", async () => {
      mocks.listSourceConnectorRecords.mockResolvedValue([
        existing({ connectorType: "other-feed" }),
      ]);
      await create(service(noneRegistry()));
      assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 1);
    });

    test("a config that is equal after trimming is rejected", async () => {
      mocks.listSourceConnectorRecords.mockResolvedValue([
        existing({
          configJson: { feedUrl: "  https://example.com/feed.xml " },
        }),
      ]);
      const error = await rejection(
        create(service(noneRegistry()), {
          configJson: { feedUrl: "https://example.com/feed.xml  " },
        }),
      );
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "CONNECTOR_ALREADY_EXISTS");
      assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 0);
      assert.equal(checkSyncReadiness.mock.calls.length, 0);
    });
  });
});

describe("oauth2 create keeps its behaviour", () => {
  test("a connector without an account still succeeds and skips readiness", async () => {
    const registry = registryFor(adapter("oauth-test", { kind: "oauth2" }));
    await create(service(registry), { connectorType: "oauth-test" });

    assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 1);
    assert.equal(
      mocks.createSourceConnectorRecord.mock.calls[0]?.[0].oauthAccountId,
      null,
    );
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
    assert.equal(mocks.listSourceConnectorRecords.mock.calls.length, 0);
  });

  test("a manifest without auth is treated as oauth2", async () => {
    const registry = registryFor(adapter("legacy", undefined));
    await create(service(registry), { connectorType: "legacy" });
    assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 1);
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
  });
});

describe("checkConfigReadiness", () => {
  const input = {
    workspaceId: "workspace",
    userId: "user",
    connectorType: "public-feed",
    configJson: FEED,
  };

  test("requires connector.manage and returns the adapter result", async () => {
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "feed_not_a_feed",
      message: "Not a feed",
    });
    const result = await service(noneRegistry()).checkConfigReadiness(input);

    assert.deepEqual(result, {
      ready: false,
      reason: "feed_not_a_feed",
      message: "Not a feed",
    });
    assert.equal(
      mocks.requireConnectorWorkspace.mock.calls[0]?.[0].permission,
      "connector.manage",
    );
    assert.equal(checkSyncReadiness.mock.calls[0]?.[0].connectorId, "pending");
    assert.equal(checkSyncReadiness.mock.calls[0]?.[0].accessToken, "");
    assert.equal(
      checkSyncReadiness.mock.calls[0]?.[0].connectorName,
      undefined,
    );
  });

  test("returns ready when the adapter has no readiness check", async () => {
    const registry = registryFor(
      adapter("public-feed", { kind: "none" }, false),
    );
    assert.deepEqual(await service(registry).checkConfigReadiness(input), {
      ready: true,
    });
  });

  test("rejects an invalid config before calling the adapter", async () => {
    const error = await rejection(
      service(noneRegistry()).checkConfigReadiness({
        ...input,
        configJson: {},
      }),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
  });

  test("rejects an oauth2 connector type as unsupported", async () => {
    const registry = registryFor(adapter("oauth-test", { kind: "oauth2" }));
    const error = await rejection(
      service(registry).checkConfigReadiness({
        ...input,
        connectorType: "oauth-test",
      }),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_CHECK_UNSUPPORTED");
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
  });
});

describe("updateConnector for a none connector", () => {
  const current = {
    ...createdConnector,
    id: "connector",
    name: "Feed",
    createdBy: "user",
  };

  beforeEach(() => {
    mocks.findSourceConnectorRecord.mockResolvedValue(current);
    mocks.updateSourceConnectorRecord.mockResolvedValue(current);
  });

  test("rejects an OAuth account rebind", async () => {
    const error = await rejection(
      service(noneRegistry()).updateConnector({
        workspaceId: "workspace",
        userId: "user",
        connectorId: "connector",
        oauthAccountId: "account",
      }),
    );
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "CONNECTOR_OAUTH_REBIND_UNSUPPORTED");
    assert.equal(mocks.updateSourceConnectorRecord.mock.calls.length, 0);
  });

  test("re-runs readiness when the config changes", async () => {
    const next = { feedUrl: "https://example.com/new.xml" };
    await service(noneRegistry()).updateConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "connector",
      configJson: next,
    });
    assert.deepEqual(checkSyncReadiness.mock.calls[0]?.[0], {
      teamId: "team",
      workspaceId: "workspace",
      connectorId: "connector",
      connectorType: "public-feed",
      connectorName: "Feed",
      config: next,
      accessToken: "",
    });
    assert.equal(mocks.updateSourceConnectorRecord.mock.calls.length, 1);
  });

  test("a not-ready new config is rejected and not persisted", async () => {
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "feed_timeout",
      message: "The feed did not respond in time.",
    });
    const error = await rejection(
      service(noneRegistry()).updateConnector({
        workspaceId: "workspace",
        userId: "user",
        connectorId: "connector",
        configJson: { feedUrl: "https://example.com/new.xml" },
      }),
    );
    assert.equal(error.code, "CONNECTOR_CONFIG_NOT_READY");
    assert.equal(error.details?.reason, "feed_timeout");
    assert.equal(mocks.updateSourceConnectorRecord.mock.calls.length, 0);
  });

  test("a rename does not run readiness", async () => {
    await service(noneRegistry()).updateConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "connector",
      name: "Renamed",
    });
    assert.equal(checkSyncReadiness.mock.calls.length, 0);
    assert.equal(mocks.updateSourceConnectorRecord.mock.calls.length, 1);
  });
});

describe("deleteConnector for a none connector", () => {
  test("hard deletes with a null account and never revokes", async () => {
    mocks.findSourceConnectorRecord.mockResolvedValue({
      ...createdConnector,
      id: "connector",
    });
    mocks.hardDeleteSourceConnectorRecord.mockResolvedValue({
      connectorDeleted: true,
      sourcesDeleted: 0,
      documentsDeleted: 0,
      authorizationDeleted: false,
    });
    const revoke = vi
      .spyOn(ConnectorOAuthService.prototype, "revokeStoredAuthorization")
      .mockImplementation(mocks.revokeStoredAuthorization);

    const result = await service(noneRegistry()).deleteConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "connector",
    });

    assert.equal(result.hardDeleted, true);
    assert.equal(
      mocks.hardDeleteSourceConnectorRecord.mock.calls[0]?.[0].oauthAccountId,
      null,
    );
    assert.equal(mocks.revokeStoredAuthorization.mock.calls.length, 0);
    assert.equal(
      mocks.hasOtherSourceConnectorOAuthAccountReferences.mock.calls.length,
      0,
    );
    revoke.mockRestore();
  });
});
