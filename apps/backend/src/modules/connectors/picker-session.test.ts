import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ConnectorError } from "./errors";
import type { ConnectorOAuthService } from "./oauth-service";
import { createGoogleDrivePickerSession } from "./picker-session";
import type { ConnectorAdapter, SourceConnectorRecord } from "./types";

function connector(
  overrides: Partial<SourceConnectorRecord> = {},
): SourceConnectorRecord {
  return {
    id: "connector_1",
    teamId: "team_1",
    workspaceId: "workspace_1",
    connectorType: "google_drive",
    name: "Google Drive",
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
      result: {
        appId: "123",
        mimeTypes: ["application/pdf"],
      },
    });
  const adapter = { executeAction } as unknown as ConnectorAdapter;
  return {
    getRuntimeToken: getRuntimeToken as unknown as ConnectorOAuthService["getRuntimeToken"],
    getAdapter: vi.fn().mockReturnValue(adapter) as unknown as (
      type: string,
    ) => ConnectorAdapter,
    executeAction,
    getRuntimeTokenMock: getRuntimeToken,
  };
}

test("returns the token with the adapter's picker config", async () => {
  const d = deps({});

  const result = await createGoogleDrivePickerSession({
    connector: connector(),
    teamId: "team_1",
    workspaceId: "workspace_1",
    deps: d,
  });

  assert.deepEqual(result, {
    accessToken: "tok",
    appId: "123",
    mimeTypes: ["application/pdf"],
  });
  assert.equal(
    d.executeAction.mock.calls[0]?.[0].actionType,
    "google_drive.picker.config",
  );
});

test("rejects a missing connector", async () => {
  const d = deps({});

  await assert.rejects(
    createGoogleDrivePickerSession({
      connector: null,
      teamId: "team_1",
      workspaceId: "workspace_1",
      deps: d,
    }),
    { statusCode: 404, code: "GOOGLE_DRIVE_CONNECTOR_NOT_FOUND" },
  );
});

test("rejects a connector of another type", async () => {
  const d = deps({});

  await assert.rejects(
    createGoogleDrivePickerSession({
      connector: connector({ connectorType: "gmail" }),
      teamId: "team_1",
      workspaceId: "workspace_1",
      deps: d,
    }),
    { statusCode: 404, code: "GOOGLE_DRIVE_CONNECTOR_NOT_FOUND" },
  );
});

test("rejects a paused connector", async () => {
  const d = deps({});

  await assert.rejects(
    createGoogleDrivePickerSession({
      connector: connector({ status: "paused" }),
      teamId: "team_1",
      workspaceId: "workspace_1",
      deps: d,
    }),
    { statusCode: 404, code: "GOOGLE_DRIVE_CONNECTOR_NOT_FOUND" },
  );
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
});

test("rejects a disabled connector", async () => {
  const d = deps({});

  await assert.rejects(
    createGoogleDrivePickerSession({
      connector: connector({ status: "disabled" }),
      teamId: "team_1",
      workspaceId: "workspace_1",
      deps: d,
    }),
    { statusCode: 404, code: "GOOGLE_DRIVE_CONNECTOR_NOT_FOUND" },
  );
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
});

test("issues a session for a connector whose last sync failed", async () => {
  const d = deps({});

  const result = await createGoogleDrivePickerSession({
    connector: connector({
      status: "error",
      lastError: "6 connector items failed; the page will be replayed",
    }),
    teamId: "team_1",
    workspaceId: "workspace_1",
    deps: d,
  });

  assert.equal(result.accessToken, "tok");
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 1);
});

test("passes through an account that needs reauthorization", async () => {
  const d = deps({
    getRuntimeToken: vi.fn().mockRejectedValue(
      new ConnectorError(
        409,
        "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE",
        "Connector OAuth account is not active",
      ),
    ),
  });

  await assert.rejects(
    createGoogleDrivePickerSession({
      connector: connector(),
      teamId: "team_1",
      workspaceId: "workspace_1",
      deps: d,
    }),
    { statusCode: 409, code: "CONNECTOR_OAUTH_ACCOUNT_UNAVAILABLE" },
  );
});

test("rejects a null picker config from the adapter", async () => {
  const d = deps({
    executeAction: vi.fn().mockResolvedValue({ result: null }),
  });

  await assert.rejects(
    createGoogleDrivePickerSession({
      connector: connector(),
      teamId: "team_1",
      workspaceId: "workspace_1",
      deps: d,
    }),
    { statusCode: 502, code: "GOOGLE_DRIVE_PICKER_CONFIG_INVALID" },
  );
});

test("rejects a malformed picker config from the adapter", async () => {
  const d = deps({
    executeAction: vi.fn().mockResolvedValue({
      result: { appId: "", mimeTypes: ["text/plain"] },
    }),
  });

  await assert.rejects(
    createGoogleDrivePickerSession({
      connector: connector(),
      teamId: "team_1",
      workspaceId: "workspace_1",
      deps: d,
    }),
    { statusCode: 502, code: "GOOGLE_DRIVE_PICKER_CONFIG_INVALID" },
  );
});
