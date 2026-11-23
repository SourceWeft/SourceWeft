import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ConnectorError } from "./errors";
import {
  parseConnectorSelectionAction,
  runConnectorSelectionAction,
} from "./selection";
import type { ConnectorOAuthService } from "./oauth-service";
import type { ConnectorAdapter, ConnectorManifest, SourceConnectorRecord } from "./types";
import { logger } from "../../shared/logger";

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

function manifest(
  overrides: Partial<{
    selection: ConnectorManifest["selection"];
    auth: ConnectorManifest["auth"];
  }> = {},
): ConnectorManifest {
  return {
    type: "dropbox",
    displayName: "Dropbox",
    auth: {
      kind: "oauth2",
      authorizationUrl: "https://example.com/auth",
      tokenUrl: "https://example.com/token",
      scopes: [],
    },
    sync: {
      supportsIncremental: true,
      defaultFrequencyMinutes: 60,
      resources: [],
    },
    actions: [],
    configSchema: {},
    selection: {
      actions: {
        browse: "dropbox.browse",
        search: "dropbox.search",
        describe: "dropbox.describe",
      },
      kinds: ["folder", "file"],
      maxItems: 500,
    },
    ...overrides,
  } as unknown as ConnectorManifest;
}

function deps(options: {
  getRuntimeToken?: ReturnType<typeof vi.fn>;
  executeAction?: ReturnType<typeof vi.fn>;
  manifest?: ConnectorManifest;
}) {
  const getRuntimeToken =
    options.getRuntimeToken ?? vi.fn().mockResolvedValue("tok");
  const executeAction =
    options.executeAction ??
    vi.fn().mockResolvedValue({
      result: { container: null, breadcrumbs: [], entries: [], cursor: "", hasMore: false },
    });
  const adapter = { executeAction } as unknown as ConnectorAdapter;
  const theManifest = options.manifest ?? manifest();
  return {
    getRuntimeToken:
      getRuntimeToken as unknown as ConnectorOAuthService["getRuntimeToken"],
    getAdapter: vi.fn().mockReturnValue(adapter) as unknown as (
      type: string,
    ) => ConnectorAdapter,
    getManifest: vi.fn().mockReturnValue(theManifest) as unknown as (
      type: string,
    ) => ConnectorManifest,
    executeAction,
    getRuntimeTokenMock: getRuntimeToken,
  };
}

test("runs the matching action with the runtime token", async () => {
  const d = deps({
    executeAction: vi.fn().mockResolvedValue({
      result: { entries: [], cursor: "", hasMore: false },
    }),
  });

  const result = await runConnectorSelectionAction({
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
  assert.deepEqual(call.config, { items: [] });
});

test.each(["paused", "disabled"])(
  "a %s connector is not usable",
  async (status) => {
    const d = deps({});

    await assert.rejects(
      runConnectorSelectionAction({
        connector: connector({ status: status as SourceConnectorRecord["status"] }),
        teamId: "team_1",
        workspaceId: "workspace_1",
        action: "browse",
        request: {},
        deps: d,
      }),
      { statusCode: 404, code: "CONNECTOR_SELECTION_NOT_FOUND" },
    );
    assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
    assert.equal(d.executeAction.mock.calls.length, 0);
  },
);

test.each(["active", "error"])(
  "a %s connector runs the action",
  async (status) => {
    const d = deps({});

    const result = await runConnectorSelectionAction({
      connector: connector({ status: status as SourceConnectorRecord["status"] }),
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "browse",
      request: {},
      deps: d,
    });

    assert.deepEqual(result, {
      container: null,
      breadcrumbs: [],
      entries: [],
      cursor: "",
      hasMore: false,
      helpLink: null,
    });
    assert.equal(d.getRuntimeTokenMock.mock.calls.length, 1);
    const call = d.executeAction.mock.calls[0]?.[0];
    assert.equal(call.actionType, "dropbox.browse");
    assert.deepEqual(call.config, { items: [] });
    assert.equal(call.accessToken, "tok");
  },
);

test("a missing connector is not found", async () => {
  const d = deps({});

  await assert.rejects(
    runConnectorSelectionAction({
      connector: null,
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "describe",
      request: { ids: ["id:abc"] },
      deps: d,
    }),
    { statusCode: 404, code: "CONNECTOR_SELECTION_NOT_FOUND" },
  );
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
  assert.equal(d.executeAction.mock.calls.length, 0);
});

test("a type without selection is unsupported", async () => {
  const d = deps({ manifest: manifest({ selection: undefined }) });

  await assert.rejects(
    runConnectorSelectionAction({
      connector: connector(),
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "browse",
      request: {},
      deps: d,
    }),
    { statusCode: 404, code: "CONNECTOR_SELECTION_UNSUPPORTED" },
  );
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
  assert.equal(d.executeAction.mock.calls.length, 0);
});

test("search on a type that declares no search action is unsupported", async () => {
  const d = deps({
    manifest: manifest({
      selection: {
        actions: { browse: "x.browse", describe: "x.describe" },
        kinds: ["file"],
        maxItems: 10,
      },
    }),
  });

  await assert.rejects(
    runConnectorSelectionAction({
      connector: connector(),
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "search",
      request: { query: "a" },
      deps: d,
    }),
    { statusCode: 404, code: "CONNECTOR_SELECTION_UNSUPPORTED" },
  );
  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
  assert.equal(d.executeAction.mock.calls.length, 0);
});

test("parseConnectorSelectionAction accepts the three names only", () => {
  assert.equal(parseConnectorSelectionAction("browse"), "browse");
  assert.equal(parseConnectorSelectionAction("search"), "search");
  assert.equal(parseConnectorSelectionAction("describe"), "describe");
  assert.throws(
    () => parseConnectorSelectionAction("delete"),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.statusCode === 404 &&
      error.code === "CONNECTOR_SELECTION_UNSUPPORTED",
  );
});

test.each([[null], ["text"], [[1]]])(
  "a non-object body %j is rejected before the token is read",
  async (body) => {
    const d = deps({});

    await assert.rejects(
      runConnectorSelectionAction({
        connector: connector(),
        teamId: "team_1",
        workspaceId: "workspace_1",
        action: "browse",
        request: body,
        deps: d,
      }),
      { statusCode: 400, code: "CONNECTOR_SELECTION_INVALID_REQUEST" },
    );
    assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
    assert.equal(d.executeAction.mock.calls.length, 0);
  },
);

class PackageError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

test("the adapter's own input error keeps its status and code", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const d = deps({
      executeAction: vi
        .fn()
        .mockRejectedValue(
          new PackageError(400, "DROPBOX_INVALID_REQUEST", "Invalid request"),
        ),
    });

    await assert.rejects(
      runConnectorSelectionAction({
        connector: connector(),
        teamId: "team_1",
        workspaceId: "workspace_1",
        action: "browse",
        request: {},
        deps: d,
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.statusCode === 400 &&
        error.code === "DROPBOX_INVALID_REQUEST" &&
        // The adapter's own message is replaced and its details dropped.
        error.message === "Connector selection request failed" &&
        error.details === undefined,
    );
  } finally {
    warn.mockRestore();
  }
});

test("a refused token reaches the caller as a reauthorization error", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
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
      runConnectorSelectionAction({
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
        error.code === "DROPBOX_REAUTH_REQUIRED" &&
        error.message === "Connector selection request failed" &&
        error.details === undefined,
    );
  } finally {
    warn.mockRestore();
  }
});

test("an adapter error's message and details do not reach the caller", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const d = deps({
      executeAction: vi.fn().mockRejectedValue(
        new PackageError(429, "DROPBOX_RATE_LIMITED", "secret provider text", {
          rawResponseJson: { body: "secret" },
          retryAfterSeconds: 30,
        }),
      ),
    });

    await assert.rejects(
      runConnectorSelectionAction({
        connector: connector(),
        teamId: "team_1",
        workspaceId: "workspace_1",
        action: "browse",
        request: {},
        deps: d,
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.statusCode === 429 &&
        error.code === "DROPBOX_RATE_LIMITED" &&
        error.message === "Connector selection request failed" &&
        JSON.stringify(error.details) ===
          JSON.stringify({ retryAfterSeconds: 30 }),
    );

    assert.equal(warn.mock.calls.length, 1);
    const [message, meta] = warn.mock.calls[0] ?? [];
    assert.equal(message, "connector_selection_action_failed");
    assert.deepEqual(Object.keys(meta as Record<string, unknown>).sort(), [
      "action",
      "code",
      "connectorType",
      "statusCode",
    ]);
    assert.equal((meta as Record<string, unknown>).code, "DROPBOX_RATE_LIMITED");
    assert.equal((meta as Record<string, unknown>).statusCode, 429);
    // Nothing the provider said reaches the log.
    assert.equal(JSON.stringify(warn.mock.calls).includes("secret"), false);
  } finally {
    warn.mockRestore();
  }
});

test("an unexpected exception becomes CONNECTOR_SELECTION_FAILED without its message", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const d = deps({
      executeAction: vi.fn().mockRejectedValue(new Error("boom secret")),
    });

    await assert.rejects(
      runConnectorSelectionAction({
        connector: connector(),
        teamId: "team_1",
        workspaceId: "workspace_1",
        action: "browse",
        request: {},
        deps: d,
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.statusCode === 502 &&
        error.code === "CONNECTOR_SELECTION_FAILED" &&
        error.message === "Connector selection request failed",
    );

    assert.equal(JSON.stringify(warn.mock.calls).includes("boom secret"), false);
    const [, meta] = warn.mock.calls[0] ?? [];
    assert.equal(
      (meta as Record<string, unknown>).code,
      "CONNECTOR_SELECTION_FAILED",
    );
    assert.equal((meta as Record<string, unknown>).statusCode, 502);
  } finally {
    warn.mockRestore();
  }
});

test("a selectable entry of an unlisted kind is an invalid result; a non-selectable one is allowed", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const entryFields = {
      id: "id:1",
      name: "x",
      detail: null,
      disabledReason: null,
      size: null,
      modifiedAt: null,
    };
    // A selectable entry whose kind is not in the manifest's selection.kinds
    // (["folder", "file"]) is an invalid result.
    const selectableUnlisted = deps({
      executeAction: vi.fn().mockResolvedValue({
        result: {
          container: null,
          breadcrumbs: [],
          entries: [
            { ...entryFields, kind: "page", selectable: true, expandable: false },
          ],
          cursor: "",
          hasMore: false,
        },
      }),
    });

    await assert.rejects(
      runConnectorSelectionAction({
        connector: connector(),
        teamId: "team_1",
        workspaceId: "workspace_1",
        action: "browse",
        request: {},
        deps: selectableUnlisted,
      }),
      { statusCode: 502, code: "CONNECTOR_SELECTION_INVALID_RESULT" },
    );
    const [message, meta] = warn.mock.calls[0] ?? [];
    assert.equal(message, "connector_selection_invalid_result");
    const issues = (meta as { issues: Array<Record<string, unknown>> }).issues;
    assert.ok(issues.length > 0);
    assert.equal(issues[0]?.code, "unlisted_kind");
    for (const issue of issues) {
      assert.deepEqual(Object.keys(issue).sort(), ["code", "path"]);
    }

    // A non-selectable entry of an unlisted kind (for example an account or
    // site) is allowed through.
    const nonSelectableUnlisted = deps({
      executeAction: vi.fn().mockResolvedValue({
        result: {
          container: null,
          breadcrumbs: [],
          entries: [
            {
              ...entryFields,
              kind: "account",
              selectable: false,
              expandable: true,
            },
          ],
          cursor: "",
          hasMore: false,
        },
      }),
    });

    const result = await runConnectorSelectionAction({
      connector: connector(),
      teamId: "team_1",
      workspaceId: "workspace_1",
      action: "browse",
      request: {},
      deps: nonSelectableUnlisted,
    });
    assert.ok("entries" in result);
    assert.equal(
      (result as { entries: unknown[] }).entries.length,
      1,
    );
  } finally {
    warn.mockRestore();
  }
});

test("strips fields the contract does not name", async () => {
  const d = deps({
    executeAction: vi.fn().mockResolvedValue({
      result: {
        container: null,
        breadcrumbs: [],
        entries: [
          {
            id: "id:1",
            kind: "file",
            name: "report.pdf",
            detail: null,
            selectable: true,
            expandable: false,
            disabledReason: null,
            size: 10,
            modifiedAt: null,
            accessToken: "secret",
          },
        ],
        cursor: "",
        hasMore: false,
      },
    }),
  });

  const result = await runConnectorSelectionAction({
    connector: connector(),
    teamId: "team_1",
    workspaceId: "workspace_1",
    action: "browse",
    request: {},
    deps: d,
  });

  assert.ok("entries" in result);
  const entry = (result as { entries: Array<Record<string, unknown>> }).entries[0];
  assert.ok(entry);
  assert.equal("accessToken" in entry, false);
});

test("rejects a result with a non-https help link", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const d = deps({
      executeAction: vi.fn().mockResolvedValue({
        result: {
          container: null,
          breadcrumbs: [],
          entries: [],
          cursor: "",
          hasMore: false,
          helpLink: { code: "needs_reauth", url: "http://example.com/help" },
        },
      }),
    });

    await assert.rejects(
      runConnectorSelectionAction({
        connector: connector(),
        teamId: "team_1",
        workspaceId: "workspace_1",
        action: "browse",
        request: {},
        deps: d,
      }),
      { statusCode: 502, code: "CONNECTOR_SELECTION_INVALID_RESULT" },
    );

    assert.equal(warn.mock.calls.length, 1);
    const [message, meta] = warn.mock.calls[0] ?? [];
    assert.equal(message, "connector_selection_invalid_result");
    assert.deepEqual(Object.keys(meta as Record<string, unknown>).sort(), [
      "action",
      "connectorType",
      "issues",
    ]);
    assert.equal((meta as Record<string, unknown>).connectorType, "dropbox");
    assert.equal((meta as Record<string, unknown>).action, "browse");
    const issues = (meta as { issues: Array<Record<string, unknown>> }).issues;
    assert.ok(issues.length > 0);
    for (const issue of issues) {
      assert.deepEqual(Object.keys(issue).sort(), ["code", "path"]);
    }
  } finally {
    warn.mockRestore();
  }
});

test("validates describe and search results with their own schemas", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  try {
    const d = deps({
      executeAction: vi.fn().mockResolvedValue({
        // A browse-shaped result (has `container`/`breadcrumbs`) returned for
        // a `describe` action, which expects `{ items: [...] }`.
        result: { container: null, breadcrumbs: [], entries: [], cursor: "", hasMore: false },
      }),
    });

    await assert.rejects(
      runConnectorSelectionAction({
        connector: connector(),
        teamId: "team_1",
        workspaceId: "workspace_1",
        action: "describe",
        request: { ids: ["id:1"] },
        deps: d,
      }),
      { statusCode: 502, code: "CONNECTOR_SELECTION_INVALID_RESULT" },
    );
  } finally {
    warn.mockRestore();
  }
});

test("a none connector runs the action with an empty token and never reads an account", async () => {
  const d = deps({
    manifest: manifest({ auth: { kind: "none" } }),
    getRuntimeToken: vi.fn().mockRejectedValue(new Error("must not be called")),
  });

  await runConnectorSelectionAction({
    connector: connector({ oauthAccountId: null }),
    teamId: "team_1",
    workspaceId: "workspace_1",
    action: "browse",
    request: {},
    deps: d,
  });

  assert.equal(d.getRuntimeTokenMock.mock.calls.length, 0);
  assert.equal(d.executeAction.mock.calls[0]?.[0].accessToken, "");
});
