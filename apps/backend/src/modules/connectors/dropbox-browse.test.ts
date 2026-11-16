import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ConnectorError } from "./errors";
import { runDropboxBrowseAction } from "./dropbox-browse";
import type { ConnectorOAuthService } from "./oauth-service";
import type { ConnectorAdapter, SourceConnectorRecord } from "./types";

function connector(
  overrides: Partial<SourceConnectorRecord> = {},
): SourceConnectorRecord {
  return {
    id: "connector_1",
    teamId: "team_1",
    workspaceId: "workspace_1",
    connectorType: "dropbox",
    name: "Dropbox",
    configJson: { items: [] },
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
    ...overrides,
  };
}

function deps(options: {
  getRuntimeToken?: ReturnType<typeof vi.fn>;
  executeAction?: ReturnType<typeof vi.fn>;
}) {
  const getRuntimeToken =
    options.getRuntimeToken ?? vi.fn().mockResolvedValue("tok");
  const executeAction =
    options.executeAction ??
    vi.fn().mockResolvedValue({
      result: { entries: [], cursor: "", hasMore: false },
    });
  const adapter = { executeAction } as unknown as ConnectorAdapter;
  return {
    getRuntimeToken:
      getRuntimeToken as unknown as ConnectorOAuthService["getRuntimeToken"],
    getAdapter: vi.fn().mockReturnValue(adapter) as unknown as (
      type: string,
    ) => ConnectorAdapter,
    executeAction,
    getRuntimeTokenMock: getRuntimeToken,
  };
}

test("runs the matching action with the runtime token", async () => {
  const d = deps({});

  const result = await runDropboxBrowseAction({
    connector: connector(),
    teamId: "team_1",
    workspaceId: "workspace_1",
    action: "search",
    request: { query: "report" },
    deps: d,
  });

  assert.deepEqual(result, { entries: [], cursor: "", hasMore: false });
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 1);
  assert.equal(
    d.getRuntimeTokenMock.mock.calls[0]?.[0].connectorType,
    "dropbox",
  );
  const call = d.executeAction.mock.calls[0]?.[0];
  assert.equal(call.actionType, "dropbox.search");
  assert.equal(call.idempotencyKey, "dropbox.search");
  assert.equal(call.accessToken, "tok");
  assert.deepEqual(call.request, { query: "report" });
  assert.equal(call.connectorId, "connector_1");
  assert.equal(call.connectorType, "dropbox");
});

test("paused connector is not found", async () => {
  const d = deps({});

  await assert.rejects(
    runDropboxBrowseAction({
      connector: connector({ status: "paused" }),
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "browse",
      request: {},
      deps: d,
    }),
    { statusCode: 404, code: "DROPBOX_CONNECTOR_NOT_FOUND" },
  );
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
});

test("drive connector is not found", async () => {
  const d = deps({});

  await assert.rejects(
    runDropboxBrowseAction({
      connector: connector({ connectorType: "google_drive" }),
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "browse",
      request: {},
      deps: d,
    }),
    { statusCode: 404, code: "DROPBOX_CONNECTOR_NOT_FOUND" },
  );
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
});

test("a missing connector is not found", async () => {
  const d = deps({});

  await assert.rejects(
    runDropboxBrowseAction({
      connector: null,
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "describe",
      request: { ids: ["id:abc"] },
      deps: d,
    }),
    { statusCode: 404, code: "DROPBOX_CONNECTOR_NOT_FOUND" },
  );
});

test("a connector whose last sync failed still runs the action", async () => {
  const d = deps({});

  const result = await runDropboxBrowseAction({
    connector: connector({
      status: "error",
      lastError: "6 connector items failed; the page will be replayed",
    }),
    teamId: "team_1",
    workspaceId: "workspace_1",
    action: "browse",
    request: {},
    deps: d,
  });

  assert.deepEqual(result, { entries: [], cursor: "", hasMore: false });
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 1);
});

test("adapter 401 becomes a ConnectorError with DROPBOX_REAUTH_REQUIRED", async () => {
  // Capability packages throw their own error class, not ConnectorError.
  class PackageError extends Error {
    constructor(
      readonly statusCode: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  const d = deps({
    executeAction: vi
      .fn()
      .mockRejectedValue(
        new PackageError(
          401,
          "DROPBOX_REAUTH_REQUIRED",
          "Dropbox request failed (401)",
        ),
      ),
  });

  await assert.rejects(
    runDropboxBrowseAction({
      connector: connector(),
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "browse",
      request: {},
      deps: d,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.statusCode === 401 &&
      error.code === "DROPBOX_REAUTH_REQUIRED",
  );
});
