import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { logger } from "../../shared/logger";
import type {
  ConnectorActionRunRecord,
  ConnectorAdapter,
  ConnectorManifest,
  SourceConnectorRecord,
} from "./types";

const mocks = vi.hoisted(() => ({
  createActionRunRecord: vi.fn(),
  createSyncRunRecord: vi.fn(),
  enqueueConnectorSyncJob: vi.fn(),
  findActionRunRecord: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
  listActionRunRecords: vi.fn(),
  requireConnectorWorkspace: vi.fn(),
  updateActionRunRecord: vi.fn(),
}));

vi.mock("./permissions", () => ({
  requireConnectorWorkspace: mocks.requireConnectorWorkspace,
}));

vi.mock("./repository", () => ({
  createActionRunRecord: mocks.createActionRunRecord,
  createSyncRunRecord: mocks.createSyncRunRecord,
  findActionRunRecord: mocks.findActionRunRecord,
  findSourceConnectorRecord: mocks.findSourceConnectorRecord,
  listActionRunRecords: mocks.listActionRunRecords,
  updateActionRunRecord: mocks.updateActionRunRecord,
}));

vi.mock("../content/queue", () => ({
  enqueueConnectorSyncJob: mocks.enqueueConnectorSyncJob,
}));

import { ConnectorActionRunner } from "./action-runner";

function registry() {
  const manifest: ConnectorManifest = {
    type: "fake",
    displayName: "Fake",
    auth: {
      kind: "oauth2",
      authorizationUrl: "https://fake.example/oauth",
      tokenUrl: "https://fake.example/token",
      scopes: [],
    },
    sync: {
      supportsIncremental: false,
      defaultFrequencyMinutes: 60,
      resources: [],
    },
    actions: [
      {
        type: "fake.item.create",
        displayName: "Create fake item",
        riskLevel: "medium",
        requiresApproval: true,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
          },
        },
        agentToolName: "create_fake_item",
        visibility: "agent",
      },
    ],
    configSchema: {},
  };
  return {
    getAdapter: vi.fn(),
    getManifest: vi.fn(() => manifest),
  };
}

function action(
  input: Partial<ConnectorActionRunRecord> = {},
): ConnectorActionRunRecord {
  return {
    id: "action_1",
    teamId: "team_1",
    workspaceId: "workspace_1",
    connectorId: "connector_1",
    connectorType: "fake",
    actionType: "fake.item.create",
    agentToolName: "create_fake_item",
    riskLevel: "medium",
    status: "approved",
    requestJson: { title: "Demo" },
    requestPreview: "Create fake item: Demo",
    resultJson: {},
    externalId: null,
    idempotencyKey: "key_1",
    approvedBy: "user_1",
    executedBy: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function connector(
  input: Partial<SourceConnectorRecord> = {},
): SourceConnectorRecord {
  return {
    id: "connector_1",
    teamId: "team_1",
    workspaceId: "workspace_1",
    connectorType: "fake",
    name: "Fake",
    configJson: {},
    oauthAccountId: "account_1",
    status: "active",
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: null,
    lastIndexedAt: null,
    nextScheduledAt: null,
    lastError: null,
    createdBy: "user_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

test("ConnectorActionRunner logs raw adapter responses on approved execution", async () => {
  const approvedAction = action();
  const rawResponseJson = {
    id: "provider_item_1",
    title: "Demo",
    nested: { ok: true },
  };
  const adapter = {
    executeAction: vi.fn().mockResolvedValue({
      externalId: "provider_item_1",
      rawResponseJson,
      result: { providerItemId: "provider_item_1" },
    }),
  } as unknown as ConnectorAdapter;
  const registry = {
    getAdapter: vi.fn(() => adapter),
  };
  const oauthService = {
    getRuntimeToken: vi.fn().mockResolvedValue("runtime-token"),
  };
  const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);

  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  });
  mocks.findActionRunRecord.mockResolvedValue(approvedAction);
  mocks.findSourceConnectorRecord.mockResolvedValue(connector());
  mocks.updateActionRunRecord.mockImplementation(async (input) =>
    action({
      status: input.status ?? "succeeded",
      resultJson: input.resultJson ?? {},
      externalId: input.externalId ?? null,
      executedBy: input.executedBy ?? null,
    }),
  );

  try {
    const result = await new ConnectorActionRunner(
      registry as never,
      oauthService as never,
    ).execute({
      workspaceId: "workspace_1",
      connectorId: "connector_1",
      actionRunId: "action_1",
      userId: "user_1",
    });

    assert.equal(result.action.status, "succeeded");
    const successLog = debug.mock.calls.find(
      ([message]) => message === "Connector action adapter execution succeeded",
    );
    assert.ok(successLog);
    assert.deepEqual(
      (successLog[1] as Record<string, unknown>).rawResponseJson,
      rawResponseJson,
    );
  } finally {
    debug.mockRestore();
    vi.clearAllMocks();
  }
});

test("ConnectorActionRunner rejects approved execution when resumed args do not match", async () => {
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  });
  mocks.findActionRunRecord.mockResolvedValue(
    action({
      actionType: "fake.item.delete",
      agentToolName: "delete_fake_item",
      requestJson: { title: "Wrong" },
    }),
  );

  await assert.rejects(
    () =>
      new ConnectorActionRunner(registry() as never, {} as never).execute({
        workspaceId: "workspace_1",
        connectorId: "connector_1",
        actionRunId: "action_1",
        expected: {
          actionType: "fake.item.create",
          agentToolName: "create_fake_item",
          requestJson: { title: "Demo" },
        },
        userId: "user_1",
      }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CONNECTOR_ACTION_APPROVAL_MISMATCH",
  );
  assert.equal(mocks.updateActionRunRecord.mock.calls.length, 0);
  vi.clearAllMocks();
});

test("ConnectorActionRunner accepts resumed args with undefined optional fields", async () => {
  const adapter = {
    executeAction: vi.fn().mockResolvedValue({
      externalId: "external_1",
      rawResponseJson: {},
      result: { ok: true },
      shouldResync: false,
    }),
  } satisfies Partial<ConnectorAdapter>;
  const testRegistry = registry();
  testRegistry.getAdapter.mockReturnValue(
    adapter as unknown as ConnectorAdapter,
  );
  const oauthService = {
    getRuntimeToken: vi.fn().mockResolvedValue("runtime-token"),
  };

  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  });
  mocks.findActionRunRecord.mockResolvedValue(
    action({
      requestJson: {
        content: "Body",
        parentPageId: "parent_page",
        title: "Demo",
      },
    }),
  );
  mocks.findSourceConnectorRecord.mockResolvedValue(connector());
  mocks.updateActionRunRecord.mockImplementation(async (input) =>
    action({
      status: input.status ?? "succeeded",
      resultJson: input.resultJson ?? {},
      externalId: input.externalId ?? null,
      executedBy: input.executedBy ?? null,
    }),
  );

  const result = await new ConnectorActionRunner(
    testRegistry as never,
    oauthService as never,
  ).execute({
    workspaceId: "workspace_1",
    connectorId: "connector_1",
    actionRunId: "action_1",
    expected: {
      actionType: "fake.item.create",
      agentToolName: "create_fake_item",
      requestJson: {
        content: "Body",
        parentPageId: "parent_page",
        pageId: undefined,
        title: "Demo",
      },
    },
    userId: "user_1",
  });

  assert.equal(result.action.status, "succeeded");
  assert.equal(adapter.executeAction.mock.calls.length, 1);
  vi.clearAllMocks();
});

test("ConnectorActionRunner propose reuses an existing proposed action", async () => {
  const proposedAction = action({
    approvedBy: null,
    id: "action_proposed",
    status: "proposed",
  });
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector());
  mocks.findActionRunRecord.mockResolvedValue(proposedAction);

  try {
    const result = await new ConnectorActionRunner(
      registry() as never,
      {} as never,
    ).propose({
      workspaceId: "workspace_1",
      userId: "user_1",
      connectorId: "connector_1",
      actionType: "fake.item.create",
      requestJson: { title: "Demo" },
      idempotencyKey: "proposal-key",
    });

    assert.equal(result.action.id, "action_proposed");
    assert.equal(result.action.status, "proposed");
    assert.equal(mocks.createActionRunRecord.mock.calls.length, 0);
  } finally {
    vi.clearAllMocks();
  }
});

test("ConnectorActionRunner propose does not reuse a proposed action with different args", async () => {
  const oldProposal = action({
    approvedBy: null,
    id: "action_old",
    requestJson: { title: "Old" },
    status: "proposed",
  });
  const freshProposal = action({
    approvedBy: null,
    id: "action_fresh",
    idempotencyKey: "proposal-key:proposal-2",
    requestJson: { title: "New" },
    status: "proposed",
  });
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector());
  mocks.findActionRunRecord
    .mockResolvedValueOnce(oldProposal)
    .mockResolvedValueOnce(null);
  mocks.createActionRunRecord.mockResolvedValue(freshProposal);

  try {
    const result = await new ConnectorActionRunner(
      registry() as never,
      {} as never,
    ).propose({
      workspaceId: "workspace_1",
      userId: "user_1",
      connectorId: "connector_1",
      actionType: "fake.item.create",
      requestJson: { title: "New" },
      idempotencyKey: "proposal-key",
    });

    assert.equal(result.action.id, "action_fresh");
    assert.deepEqual(
      mocks.findActionRunRecord.mock.calls.map(
        ([input]) => input.idempotencyKey,
      ),
      ["proposal-key", "proposal-key:proposal-2"],
    );
    assert.equal(
      mocks.createActionRunRecord.mock.calls[0]?.[0].idempotencyKey,
      "proposal-key:proposal-2",
    );
  } finally {
    vi.clearAllMocks();
  }
});

test("ConnectorActionRunner propose creates a fresh proposal after a terminal idempotency hit", async () => {
  const failedAction = action({
    errorCode: "PROVIDER_FAILED",
    errorMessage: "Provider failed.",
    id: "action_failed",
    status: "failed",
  });
  const freshProposal = action({
    approvedBy: null,
    id: "action_fresh",
    idempotencyKey: "proposal-key:proposal-2",
    status: "proposed",
  });
  mocks.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace_1", organizationId: "team_1" },
  });
  mocks.findSourceConnectorRecord.mockResolvedValue(connector());
  mocks.findActionRunRecord
    .mockResolvedValueOnce(failedAction)
    .mockResolvedValueOnce(null);
  mocks.createActionRunRecord.mockResolvedValue(freshProposal);

  try {
    const result = await new ConnectorActionRunner(
      registry() as never,
      {} as never,
    ).propose({
      workspaceId: "workspace_1",
      userId: "user_1",
      connectorId: "connector_1",
      actionType: "fake.item.create",
      requestJson: { title: "Demo" },
      idempotencyKey: "proposal-key",
    });

    assert.equal(result.action.id, "action_fresh");
    assert.equal(result.action.status, "proposed");
    assert.deepEqual(
      mocks.findActionRunRecord.mock.calls.map(
        ([input]) => input.idempotencyKey,
      ),
      ["proposal-key", "proposal-key:proposal-2"],
    );
    assert.equal(
      mocks.createActionRunRecord.mock.calls[0]?.[0].idempotencyKey,
      "proposal-key:proposal-2",
    );
  } finally {
    vi.clearAllMocks();
  }
});
