import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ConnectorRegistry } from "./registry";

const mocks = vi.hoisted(() => ({
  archiveConnectorSources: vi.fn(),
  deleteOAuthAccountRecord: vi.fn(),
  findOAuthAccountRecord: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
  getConnectorScheduleStatus: vi.fn(),
  hardDeleteSourceConnectorRecord: vi.fn(),
  hasOtherSourceConnectorOAuthAccountReferences: vi.fn(),
  listWorkspaceSourceConnectorRecordsByOAuthAccount: vi.fn(),
  putConnectorSchedule: vi.fn(),
  requireConnectorWorkspace: vi.fn(),
  revokeStoredAuthorization: vi.fn(),
  updateSourceConnectorRecord: vi.fn(),
}));

vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.requireConnectorWorkspace,
}));

vi.mock("./repository", () => ({
  archiveConnectorSources: mocks.archiveConnectorSources,
  deleteOAuthAccountRecord: mocks.deleteOAuthAccountRecord,
  findOAuthAccountRecord: mocks.findOAuthAccountRecord,
  findSourceConnectorRecord: mocks.findSourceConnectorRecord,
  getConnectorScheduleStatus: mocks.getConnectorScheduleStatus,
  hardDeleteSourceConnectorRecord: mocks.hardDeleteSourceConnectorRecord,
  hasOtherSourceConnectorOAuthAccountReferences:
    mocks.hasOtherSourceConnectorOAuthAccountReferences,
  listWorkspaceSourceConnectorRecordsByOAuthAccount:
    mocks.listWorkspaceSourceConnectorRecordsByOAuthAccount,
  putConnectorSchedule: mocks.putConnectorSchedule,
  updateSourceConnectorRecord: mocks.updateSourceConnectorRecord,
}));

import { ConnectorOAuthService } from "./oauth-service";
import { ConnectorService } from "./service";

const connector = {
  id: "connector",
  createdBy: "user",
  teamId: "team",
  workspaceId: "workspace",
  connectorType: "gmail",
  name: "Gmail",
  oauthAccountId: "old-account",
  configJson: { liveSearchEnabled: true, indexingEnabled: false },
  status: "active",
  periodicIndexingEnabled: false,
  indexingFrequencyMinutes: null,
};

// Gmail's configSchema has always declared labelIds with maxItems: 20; it
// is added here so F1's tests can exercise the stricter validator's
// maxItems enforcement against a stored config (see
// .superpowers/sdd/2026-11-12-google-drive-connector/final-review-pr2-fixes.md).
const gmailConfigSchema = {
  type: "object",
  properties: {
    labelIds: {
      type: "array",
      maxItems: 20,
      items: { type: "string" },
    },
  },
};

function service() {
  return new ConnectorService(
    {
      getManifest: () => ({
        type: "gmail",
        displayName: "Gmail",
        configSchema: gmailConfigSchema,
        sync: {
          supportsIncremental: true,
          defaultFrequencyMinutes: 360,
          minFrequencyMinutes: 60,
          resources: [
            {
              type: "gmail_message",
              displayName: "Gmail message",
              supportsDeleteDetection: true,
            },
          ],
        },
      }),
    } as unknown as ConnectorRegistry,
    {
      revokeStoredAuthorization: mocks.revokeStoredAuthorization,
    } as unknown as ConnectorOAuthService,
  );
}

test("Gmail reconnect binds only the same provider identity in the workspace", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord
    .mockResolvedValueOnce(connector)
    .mockResolvedValueOnce({ ...connector, oauthAccountId: "new-account" });
  mocks.findOAuthAccountRecord.mockImplementation(async ({ accountId }) =>
    accountId === "old-account"
      ? { id: "old-account", providerAccountId: "reader@example.com" }
      : {
          id: "new-account",
          createdBy: "user",
          status: "active",
          connectorType: "gmail",
          providerAccountId: "reader@example.com",
        },
  );
  mocks.updateSourceConnectorRecord.mockResolvedValue({
    ...connector,
    oauthAccountId: "new-account",
  });
  mocks.getConnectorScheduleStatus.mockResolvedValue(null);
  const result = await service().updateConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorId: "connector",
    oauthAccountId: "new-account",
  });
  assert.equal(result.connector.oauthAccountId, "new-account");
  assert.equal(
    mocks.updateSourceConnectorRecord.mock.calls[0]?.[0].oauthAccountId,
    "new-account",
  );
  assert.deepEqual(mocks.findOAuthAccountRecord.mock.calls[0]?.[0], {
    teamId: "team",
    workspaceId: "workspace",
    accountId: "new-account",
  });
});

test("Gmail reconnect rejects a different mailbox before changing the connector", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector);
  mocks.findOAuthAccountRecord.mockImplementation(async ({ accountId }) =>
    accountId === "old-account"
      ? { id: "old-account", providerAccountId: "reader@example.com" }
      : {
          id: "new-account",
          createdBy: "user",
          status: "active",
          connectorType: "gmail",
          providerAccountId: "other@example.com",
        },
  );
  await assert.rejects(
    service().updateConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "connector",
      oauthAccountId: "new-account",
    }),
    { code: "CONNECTOR_OAUTH_ACCOUNT_MISMATCH" },
  );
  assert.equal(mocks.updateSourceConnectorRecord.mock.calls.length, 0);
});

test("disabling Gmail indexing archives retained sources after the config change", async () => {
  vi.clearAllMocks();
  const indexedConnector = {
    ...connector,
    configJson: { liveSearchEnabled: true, indexingEnabled: true },
  };
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord
    .mockResolvedValueOnce(indexedConnector)
    .mockResolvedValueOnce({
      ...indexedConnector,
      configJson: { liveSearchEnabled: true, indexingEnabled: false },
    });
  mocks.updateSourceConnectorRecord.mockResolvedValue({
    ...indexedConnector,
    configJson: { liveSearchEnabled: true, indexingEnabled: false },
  });
  mocks.getConnectorScheduleStatus.mockResolvedValue(null);
  await service().updateConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorId: "connector",
    configJson: { liveSearchEnabled: true, indexingEnabled: false },
    periodicIndexingEnabled: false,
  });
  assert.equal(mocks.archiveConnectorSources.mock.calls.length, 1);
  assert.deepEqual(mocks.archiveConnectorSources.mock.calls[0]?.[0], {
    teamId: "team",
    workspaceId: "workspace",
    connectorId: "connector",
  });
});

function labelIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `label_${index}`);
}

test("updates a connector without re-validating an untouched stored config", async () => {
  vi.clearAllMocks();
  const storedConnector = {
    ...connector,
    configJson: {
      liveSearchEnabled: true,
      indexingEnabled: false,
      labelIds: labelIds(21),
    },
  };
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord
    .mockResolvedValueOnce(storedConnector)
    .mockResolvedValueOnce({ ...storedConnector, name: "Renamed" });
  mocks.updateSourceConnectorRecord.mockResolvedValue({
    ...storedConnector,
    name: "Renamed",
  });
  mocks.getConnectorScheduleStatus.mockResolvedValue(null);

  const result = await service().updateConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorId: "connector",
    name: "Renamed",
  });

  assert.equal(result.connector.name, "Renamed");
  assert.equal(mocks.updateSourceConnectorRecord.mock.calls.length, 1);
});

test("rejects a config update that exceeds a declared array limit", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector);

  await assert.rejects(
    service().updateConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "connector",
      configJson: {
        liveSearchEnabled: true,
        indexingEnabled: false,
        labelIds: labelIds(21),
      },
    }),
    { code: "CONNECTOR_SCHEMA_VALIDATION_FAILED" },
  );
  assert.equal(mocks.updateSourceConnectorRecord.mock.calls.length, 0);
});

test("accepts a config update within the declared limits", async () => {
  vi.clearAllMocks();
  const nextConfig = {
    liveSearchEnabled: true,
    indexingEnabled: false,
    labelIds: labelIds(20),
  };
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord
    .mockResolvedValueOnce(connector)
    .mockResolvedValueOnce({ ...connector, configJson: nextConfig });
  mocks.updateSourceConnectorRecord.mockResolvedValue({
    ...connector,
    configJson: nextConfig,
  });
  mocks.getConnectorScheduleStatus.mockResolvedValue(null);

  const result = await service().updateConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorId: "connector",
    configJson: nextConfig,
  });

  assert.deepEqual(result.connector.configJson, nextConfig);
});

const accountSecret = {
  id: "old-account",
  teamId: "team",
  workspaceId: "workspace",
  connectorType: "gmail",
  accessTokenEncrypted: "enc(broker-credential)",
  refreshTokenEncrypted: null,
};

test("hard delete revokes the stored authorization before any local row is removed", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector);
  mocks.hasOtherSourceConnectorOAuthAccountReferences.mockResolvedValue(false);
  mocks.findOAuthAccountRecord.mockResolvedValue(accountSecret);
  const callOrder: string[] = [];
  mocks.revokeStoredAuthorization.mockImplementation(async () => {
    callOrder.push("revoke");
  });
  mocks.hardDeleteSourceConnectorRecord.mockImplementation(async () => {
    callOrder.push("delete");
    return {
      connectorDeleted: true,
      sourcesDeleted: 2,
      documentsDeleted: 5,
      authorizationDeleted: true,
    };
  });

  const result = await service().deleteConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorId: "connector",
  });

  assert.deepEqual(callOrder, ["revoke", "delete"]);
  assert.deepEqual(
    mocks.revokeStoredAuthorization.mock.calls[0]?.[0],
    accountSecret,
  );
  assert.equal(result.hardDeleted, true);
});

test("hard delete aborts and keeps the connector, its sources and the account when the provider revoke fails", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector);
  mocks.hasOtherSourceConnectorOAuthAccountReferences.mockResolvedValue(false);
  mocks.findOAuthAccountRecord.mockResolvedValue(accountSecret);
  mocks.revokeStoredAuthorization.mockRejectedValue(
    Object.assign(new Error("provider is down"), {
      statusCode: 502,
      code: "CONNECTOR_AUTHORIZATION_REVOKE_FAILED",
    }),
  );

  await assert.rejects(
    service().deleteConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "connector",
    }),
    { code: "CONNECTOR_AUTHORIZATION_REVOKE_FAILED" },
  );
  assert.equal(mocks.hardDeleteSourceConnectorRecord.mock.calls.length, 0);
});

test("deleteOAuthAccount revokes the stored authorization before deleting the account row", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findOAuthAccountRecord.mockResolvedValue(accountSecret);
  mocks.listWorkspaceSourceConnectorRecordsByOAuthAccount.mockResolvedValue([]);
  const callOrder: string[] = [];
  mocks.revokeStoredAuthorization.mockImplementation(async () => {
    callOrder.push("revoke");
  });
  mocks.deleteOAuthAccountRecord.mockImplementation(async () => {
    callOrder.push("delete");
    return true;
  });

  const result = await service().deleteOAuthAccount({
    workspaceId: "workspace",
    userId: "user",
    accountId: "old-account",
  });

  assert.deepEqual(callOrder, ["revoke", "delete"]);
  assert.deepEqual(
    mocks.revokeStoredAuthorization.mock.calls[0]?.[0],
    accountSecret,
  );
  assert.equal(result.deleted, true);
});

test("deleteOAuthAccount aborts and keeps the account row when the provider revoke fails", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findOAuthAccountRecord.mockResolvedValue(accountSecret);
  mocks.listWorkspaceSourceConnectorRecordsByOAuthAccount.mockResolvedValue([]);
  mocks.revokeStoredAuthorization.mockRejectedValue(
    Object.assign(new Error("provider is down"), {
      statusCode: 502,
      code: "CONNECTOR_AUTHORIZATION_REVOKE_FAILED",
    }),
  );

  await assert.rejects(
    service().deleteOAuthAccount({
      workspaceId: "workspace",
      userId: "user",
      accountId: "old-account",
    }),
    { code: "CONNECTOR_AUTHORIZATION_REVOKE_FAILED" },
  );
  assert.equal(mocks.deleteOAuthAccountRecord.mock.calls.length, 0);
});

test("disabling a connector never revokes the stored authorization", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector);
  mocks.updateSourceConnectorRecord.mockResolvedValue({
    ...connector,
    status: "disabled",
  });
  mocks.putConnectorSchedule.mockResolvedValue(undefined);

  const result = await service().deleteConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorId: "connector",
    disable: true,
  });

  assert.equal(result.disabled, true);
  assert.equal(mocks.revokeStoredAuthorization.mock.calls.length, 0);
  assert.equal(mocks.findOAuthAccountRecord.mock.calls.length, 0);
});

test("hard delete still removes the connector locally when its adapter is switched off at deployment level", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector);
  mocks.hasOtherSourceConnectorOAuthAccountReferences.mockResolvedValue(false);
  mocks.findOAuthAccountRecord.mockResolvedValue(accountSecret);
  mocks.hardDeleteSourceConnectorRecord.mockResolvedValue({
    connectorDeleted: true,
    sourcesDeleted: 2,
    documentsDeleted: 5,
    authorizationDeleted: true,
  });

  // A real oauth service whose registry has no adapter for this connector
  // type (the operator set GMAIL_CONNECTOR_ENABLED=false), with the real
  // revokeStoredAuthorization — not the mock — so the unregistered-adapter
  // path is actually exercised and must not block the local delete.
  const switchedOff = new ConnectorService(
    {
      getManifest: () => ({ type: "gmail", displayName: "Gmail" }),
    } as unknown as ConnectorRegistry,
    new ConnectorOAuthService(new ConnectorRegistry()),
  );

  const result = await switchedOff.deleteConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorId: "connector",
  });

  assert.equal(result.hardDeleted, true);
  assert.equal(mocks.hardDeleteSourceConnectorRecord.mock.calls.length, 1);
});

test("Gmail is listed with every other registered connector, for any user", () => {
  // Gmail used to be hidden behind a per-user preview flag; registration
  // alone now decides whether a connector is offered.
  const manifests = [
    { type: "gmail", displayName: "Gmail" },
    { type: "notion", displayName: "Notion" },
  ];
  const listed = new ConnectorService({
    listManifests: () => manifests,
  } as unknown as ConnectorRegistry).listManifests();
  assert.deepEqual(listed, { items: manifests });
});
