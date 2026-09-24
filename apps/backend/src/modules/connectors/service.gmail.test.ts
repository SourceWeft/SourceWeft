import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ConnectorRegistry } from "./registry";

const mocks = vi.hoisted(() => ({
  findOAuthAccountRecord: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
  getConnectorScheduleStatus: vi.fn(),
  putConnectorSchedule: vi.fn(),
  requireConnectorWorkspace: vi.fn(),
  updateSourceConnectorRecord: vi.fn(),
}));

vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.requireConnectorWorkspace,
}));

vi.mock("./repository", () => ({
  findOAuthAccountRecord: mocks.findOAuthAccountRecord,
  findSourceConnectorRecord: mocks.findSourceConnectorRecord,
  getConnectorScheduleStatus: mocks.getConnectorScheduleStatus,
  putConnectorSchedule: mocks.putConnectorSchedule,
  updateSourceConnectorRecord: mocks.updateSourceConnectorRecord,
}));

import { ConnectorService } from "./service";

const connector = {
  id: "connector",
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

function service() {
  return new ConnectorService({
    getManifest: () => ({
      type: "gmail",
      displayName: "Gmail",
      configSchema: { type: "object" },
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
  } as unknown as ConnectorRegistry);
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
