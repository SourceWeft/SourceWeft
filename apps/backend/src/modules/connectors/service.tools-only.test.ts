vi.mock("../preview", () => ({
  previewAccessService: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ConnectorRegistry } from "./registry";

const mocks = vi.hoisted(() => ({
  createSourceConnectorRecord: vi.fn(),
  findOAuthAccountRecord: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
  findSourceConnectorRecordByName: vi.fn(),
  getConnectorScheduleStatus: vi.fn(),
  requireConnectorWorkspace: vi.fn(),
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
}));

import { ConnectorService } from "./service";

// A tools-only connector (nothing is indexed): `sync.resources: []`, no
// configSchema constraints. Models the platform rule that creating such a
// connector with `periodicIndexingEnabled: true` is refused.
function service() {
  return new ConnectorService({
    getManifest: () => ({
      type: "tools-only-test",
      displayName: "Tools Only Test",
      configSchema: { type: "object" },
      sync: {
        supportsIncremental: false,
        defaultFrequencyMinutes: 60,
        resources: [],
      },
    }),
  } as unknown as ConnectorRegistry);
}

test("creating a connector without sync resources refuses periodic indexing", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecordByName.mockResolvedValue(null);

  await assert.rejects(
    service().createConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorType: "tools-only-test",
      name: "Tools Only",
      periodicIndexingEnabled: true,
    }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 400);
      assert.equal(
        (error as { code?: string }).code,
        "CONNECTOR_PERIODIC_SYNC_UNSUPPORTED",
      );
      return true;
    },
  );
  assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 0);
});

test("creating a tools-only connector without periodic indexing succeeds", async () => {
  vi.clearAllMocks();
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
  });
  mocks.findSourceConnectorRecordByName.mockResolvedValue(null);
  const createdConnector = {
    id: "tools-only-connector",
    teamId: "team",
    workspaceId: "workspace",
    connectorType: "tools-only-test",
    name: "Tools Only",
    configJson: {},
    oauthAccountId: null,
    status: "active",
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: null,
  };
  mocks.createSourceConnectorRecord.mockResolvedValue(createdConnector);
  mocks.findSourceConnectorRecord.mockResolvedValue(createdConnector);
  mocks.getConnectorScheduleStatus.mockResolvedValue(null);

  const result = await service().createConnector({
    workspaceId: "workspace",
    userId: "user",
    connectorType: "tools-only-test",
    name: "Tools Only",
    periodicIndexingEnabled: false,
  });

  assert.equal(result.connector.id, "tools-only-connector");
  assert.equal(mocks.createSourceConnectorRecord.mock.calls.length, 1);
  assert.equal(
    mocks.createSourceConnectorRecord.mock.calls[0]?.[0]
      .periodicIndexingEnabled,
    false,
  );
});
