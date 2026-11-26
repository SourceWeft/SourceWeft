import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ConnectorRegistry } from "./registry";
import { runConnectorSelectionAction } from "./selection";
import type {
  ConnectorAdapter,
  ConnectorManifest,
  SourceConnectorRecord,
} from "./types";

/**
 * Seam check for a `none`-auth connector that is driven by a selection
 * (`configJson.items`): an empty selection, the readiness gate, reconciliation
 * of a complete scan or one with nothing to reconcile, the sync scope hash, and the selection
 * actions.
 *
 * The backend never imports a capability package, so this file drives the real
 * {@link ConnectorService}, {@link ConnectorSyncOrchestrator} and
 * {@link runConnectorSelectionAction} with a SYNTHETIC adapter over an
 * in-memory repository. It runs in the mock lane; the SQL behind
 * `archiveConnectorSourcesNotSeenInRun` is covered by the database lane
 * (`repository/schedule.database.test.ts`).
 */

const repo = vi.hoisted(() => ({
  // service
  createCredentialConnectorRecord: vi.fn(),
  createSourceConnectorRecord: vi.fn(),
  findOAuthAccountByProviderAccountInWorkspace: vi.fn(),
  findOAuthAccountRecord: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
  findSourceConnectorRecordByName: vi.fn(),
  getConnectorScheduleStatus: vi.fn(),
  listSourceConnectorRecords: vi.fn(),
  listConnectorScheduleStatuses: vi.fn(),
  updateSourceConnectorRecord: vi.fn(),
  putConnectorSchedule: vi.fn(),
  archiveConnectorSources: vi.fn(),
  // orchestrator
  createSyncRunRecord: vi.fn(),
  createSyncRunRecordIfNoActiveRun: vi.fn(),
  attachScheduleOccurrenceRun: vi.fn(),
  completeScheduleOccurrence: vi.fn(),
  commitConnectorSyncPage: vi.fn(),
  archiveConnectorSourcesNotSeenInRun: vi.fn(),
  findSyncRunRecord: vi.fn(),
  getOrResetConnectorSyncState: vi.fn(),
  resetConnectorSyncState: vi.fn(),
  isConnectorScheduleEnabled: vi.fn(),
  skipScheduleOccurrenceByRunId: vi.fn(),
  tryAcquireConnectorSyncLock: vi.fn(),
  hardDeleteSourceConnectorRecord: vi.fn(),
  incrementSyncRunCounts: vi.fn(),
  listSyncRunRecords: vi.fn(),
  listWorkspaceSyncRunRecords: vi.fn(),
  markConnectorSyncBlockChecked: vi.fn(),
  markOAuthAccountReauthRequiredRecord: vi.fn(),
  touchConnectorAfterSync: vi.fn(),
  updateSyncRunRecord: vi.fn(),
}));

const permissions = vi.hoisted(() => ({
  requireConnectorWorkspace: vi.fn(),
}));

vi.mock("./permissions", () => ({
  requireConnectorWorkspace: permissions.requireConnectorWorkspace,
}));
vi.mock("./repository", () => repo);
vi.mock("../sources", () => ({
  SourceIndexingService: class {},
  createSourceRecord: vi.fn(),
  createSourceRevisionRecord: vi.fn(),
  estimateIngestionPages: vi.fn(() => null),
  findSourceRecordByConnectorExternalId: vi.fn(),
  updateSourceRecord: vi.fn(),
}));
vi.mock("../../billing-host/bindings", () => ({
  getBillingDeploymentCapabilities: () => ({ billing: { available: false } }),
}));
vi.mock("../workspace", () => ({
  workspaceService: { getOrganizationMembership: vi.fn() },
}));
vi.mock("./extracted-file", () => ({
  resolveExtractedFile: vi.fn(),
}));
vi.mock("./oauth-service", () => ({
  ConnectorOAuthService: class {},
}));
vi.mock("./ingestion-budget", () => ({
  IngestionPageBudget: class {
    async admit() {
      return { outcome: "admit" as const };
    }
    consumed() {}
  },
  isPagesLimitExceeded: () => false,
}));

import { ConnectorService } from "./service";
import { ConnectorSyncOrchestrator } from "./sync-orchestrator";

const CONNECTOR_TYPE = "synthetic-forum";
const FORUM = "https://forum.example.com";

const CATEGORY = { id: "category:5", kind: "category" };
const TOPIC = { id: "topic:77", kind: "topic" };
const SELECTED = { forumUrl: FORUM, items: [CATEGORY, TOPIC] };
const EMPTY = { forumUrl: FORUM, items: [] };

/** The reasons a selection-driven forum connector reports. None of them is a
 * reason the platform knows by name. */
const FORUM_READINESS_REASONS = [
  "selection_required",
  "login_required",
  "not_a_discourse_site",
  "forum_unreachable",
  "blocked_endpoint",
  "rate_limited",
  "config_invalid",
] as const;

const configSchema = {
  type: "object",
  required: ["forumUrl"],
  properties: {
    forumUrl: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "kind"],
        properties: { id: { type: "string" }, kind: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const syntheticManifest = {
  type: CONNECTOR_TYPE,
  displayName: "Synthetic forum",
  auth: { kind: "none" },
  sync: {
    supportsIncremental: false,
    defaultFrequencyMinutes: 360,
    minFrequencyMinutes: 30,
    resources: [
      { type: "topic", displayName: "Topic", supportsDeleteDetection: true },
    ],
  },
  actions: [],
  configSchema,
  selection: {
    actions: {
      browse: "synthetic.browse",
      search: "synthetic.search",
      describe: "synthetic.describe",
    },
    kinds: ["category", "topic"],
    maxItems: 50,
  },
} as unknown as ConnectorManifest;

const checkSyncReadiness = vi.fn();
const executeAction = vi.fn();
/** Per test: the pages the synthetic scan yields (or throws). */
const scan = vi.fn();

const syntheticAdapter = {
  getManifest: () => syntheticManifest,
  checkSyncReadiness,
  async *discover() {},
  discoverPages: (input: unknown) => scan(input),
  extract: async ({ item }: { item: unknown }) => ({ item }),
  executeAction,
} as unknown as ConnectorAdapter;

/** The same synthetic forum under other manifests, to prove the
 * `selection_required` exemption is scoped to `none` auth AND a declared
 * selection. */
function variantAdapter(
  type: string,
  auth: Record<string, unknown>,
  withSelection: boolean,
) {
  const manifest = {
    ...syntheticManifest,
    type,
    auth,
    ...(withSelection ? {} : { selection: undefined }),
  } as unknown as ConnectorManifest;
  return {
    getManifest: () => manifest,
    checkSyncReadiness,
    ...(auth.kind === "credential"
      ? { credentialIdentity: () => "identity:forum" }
      : {}),
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item }),
    executeAction,
  } as unknown as ConnectorAdapter;
}

const PLAIN_NONE_TYPE = "synthetic-plain-none";
const CREDENTIAL_SELECTION_TYPE = "synthetic-credential-selection";
const CREDENTIAL_PLAIN_TYPE = "synthetic-credential-plain";

const registry = new ConnectorRegistry([
  syntheticAdapter,
  variantAdapter(PLAIN_NONE_TYPE, { kind: "none" }, false),
  variantAdapter(
    CREDENTIAL_SELECTION_TYPE,
    { kind: "credential", scheme: "api_key" },
    true,
  ),
  variantAdapter(
    CREDENTIAL_PLAIN_TYPE,
    { kind: "credential", scheme: "api_key" },
    false,
  ),
]);
const service = new ConnectorService(registry);

type ConnectorRow = SourceConnectorRecord & {
  configJson: Record<string, unknown>;
};

let connectors: Map<string, ConnectorRow>;
let sequence: number;
const getRuntimeToken = vi.fn(async () => {
  throw new Error("a none connector must never read an account token");
});

function connectorRow(
  id: string,
  configJson: Record<string, unknown>,
  overrides: Partial<ConnectorRow> = {},
): ConnectorRow {
  return {
    id,
    teamId: "team",
    workspaceId: "workspace",
    connectorType: CONNECTOR_TYPE,
    name: "Forum",
    configJson,
    oauthAccountId: null,
    status: "active",
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: null,
    lastIndexedAt: null,
    nextScheduledAt: null,
    lastError: null,
    syncBlock: null,
    createdBy: "owner",
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  } as ConnectorRow;
}

function seedConnector(
  configJson: Record<string, unknown>,
  overrides: Partial<ConnectorRow> = {},
) {
  const row = connectorRow("conn_1", configJson, overrides);
  connectors.set(row.id, row);
  return row;
}

function installRepository() {
  permissions.requireConnectorWorkspace.mockResolvedValue({
    workspace: { id: "workspace", organizationId: "team" },
    membership: { role: "workspace_admin" },
  });
  repo.findSourceConnectorRecordByName.mockResolvedValue(null);
  repo.listSourceConnectorRecords.mockResolvedValue([]);
  repo.listConnectorScheduleStatuses.mockResolvedValue(new Map());
  repo.getConnectorScheduleStatus.mockResolvedValue(null);
  repo.putConnectorSchedule.mockResolvedValue(undefined);
  repo.findSourceConnectorRecord.mockImplementation(
    async (input: { connectorId: string }) =>
      connectors.get(input.connectorId) ?? null,
  );
  repo.createSourceConnectorRecord.mockImplementation(
    async (input: { name: string; configJson: Record<string, unknown> }) => {
      sequence += 1;
      const row = connectorRow(`conn_${sequence}`, input.configJson, {
        name: input.name,
      });
      connectors.set(row.id, row);
      return row;
    },
  );
  repo.updateSourceConnectorRecord.mockImplementation(
    async (input: { connectorId: string } & Record<string, unknown>) => {
      const row = connectors.get(input.connectorId);
      if (!row) return null;
      const { connectorId: _id, teamId: _t, workspaceId: _w, ...patch } = input;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (row as Record<string, unknown>)[key] = value;
      }
      return row;
    },
  );
  repo.createSyncRunRecord.mockResolvedValue({ id: "run-skipped" });
  repo.updateSyncRunRecord.mockResolvedValue({ id: "run-1" });
  repo.createSyncRunRecordIfNoActiveRun.mockResolvedValue({
    run: { id: "run-queued" },
    existing: false,
  });
  repo.findSyncRunRecord.mockResolvedValue({
    id: "run-1",
    triggerType: "manual",
    status: "queued",
    createdBy: "owner",
  });
  repo.tryAcquireConnectorSyncLock.mockResolvedValue(async () => {});
  repo.getOrResetConnectorSyncState.mockImplementation(
    async (input: { scopeHash: string }) => ({
      generation: 0,
      scopeHash: input.scopeHash,
      committedCursorJson: null,
      pageCursorJson: null,
    }),
  );
  repo.commitConnectorSyncPage.mockResolvedValue({ generation: 1 });
  repo.archiveConnectorSourcesNotSeenInRun.mockResolvedValue(0);
  repo.incrementSyncRunCounts.mockResolvedValue(undefined);
  repo.touchConnectorAfterSync.mockResolvedValue(undefined);
  repo.completeScheduleOccurrence.mockResolvedValue(undefined);
}

function orchestrator() {
  return new ConnectorSyncOrchestrator(
    {} as never,
    registry as never,
    { getRuntimeToken } as never,
    async () => "billing-user",
  );
}

const SCHEDULED = {
  teamId: "team",
  workspaceId: "workspace",
  connectorId: "conn_1",
  userId: "system",
};

function scheduledRun(
  enqueue = vi.fn(async (): Promise<{ id?: string | number } | null> => null),
) {
  return {
    enqueue,
    result: orchestrator().enqueueScheduledRun({ ...SCHEDULED, enqueue }),
  };
}

const RUN_INPUT = {
  runId: "run-1",
  teamId: "team",
  workspaceId: "workspace",
  connectorId: "conn_1",
  userId: "trigger",
};

type Page = {
  items: unknown[];
  deletedExternalIds?: string[];
  continuation?: null;
  complete: boolean;
  reconcileMissing: boolean;
  checkpoint: null;
};

/** A scan that yields exactly the given pages. */
function scanYielding(...pages: Page[]) {
  scan.mockImplementation(async function* () {
    for (const page of pages) yield { deletedExternalIds: [], ...page };
  });
}

/** An adapter-boundary error shaped like the capability package's own error
 * class: a numeric status and a string code, but not a platform ConnectorError. */
class AdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AdapterError";
    this.statusCode = statusCode;
    this.code = code;
  }
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

function lastRunPatch(status: string) {
  return repo.updateSyncRunRecord.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((patch) => patch.status === status);
}

function scopeHashes() {
  return repo.getOrResetConnectorSyncState.mock.calls.map(
    (call) => (call[0] as { scopeHash: string }).scopeHash,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  connectors = new Map();
  sequence = 0;
  installRepository();
  checkSyncReadiness.mockResolvedValue({ ready: true });
  scan.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the readiness gate for a selection connector", () => {
  test.each(FORUM_READINESS_REASONS)(
    "a scheduled sync that is not ready with %s is skipped, never archives, and leaves the connector active",
    async (reason) => {
      seedConnector(EMPTY, {
        periodicIndexingEnabled: true,
        indexingFrequencyMinutes: 60,
      });
      checkSyncReadiness.mockResolvedValue({
        ready: false,
        reason,
        message: `Not ready: ${reason}`,
      });

      const { enqueue, result } = scheduledRun();
      const outcome = await result;

      assert.equal(outcome.skipped, true);
      assert.equal(outcome.reason, reason);
      assert.equal(enqueue.mock.calls.length, 0);
      // The adapter's readiness check saw no credential at all.
      assert.equal(
        (checkSyncReadiness.mock.calls[0]?.[0] as { accessToken: string })
          .accessToken,
        "",
      );
      assert.equal(getRuntimeToken.mock.calls.length, 0);
      // The skipped run records the reason and message verbatim.
      const created = repo.createSyncRunRecord.mock.calls[0]?.[0] as {
        status: string;
        triggerType: string;
        metadataJson: Record<string, unknown>;
      };
      assert.equal(created.status, "skipped");
      assert.equal(created.triggerType, "scheduled");
      assert.equal(created.metadataJson.reason, reason);
      assert.equal(created.metadataJson.readinessReason, reason);
      assert.equal(created.metadataJson.message, `Not ready: ${reason}`);
      // The connector is not put in `error`, carries no lastError, and keeps
      // its cadence; the reason is stored in its config for the UI.
      const patch = repo.updateSourceConnectorRecord.mock.calls[0]?.[0] as {
        status: string;
        lastError: string | null;
        nextScheduledAt: Date | null;
        configJson: { syncReadiness: { ready: boolean; reason: string } };
      };
      assert.equal(patch.status, "active");
      assert.equal(patch.lastError, null);
      assert.ok(patch.nextScheduledAt instanceof Date);
      assert.equal(patch.configJson.syncReadiness.ready, false);
      assert.equal(patch.configJson.syncReadiness.reason, reason);
      // Nothing was scanned, committed, archived or marked for reauth.
      assert.equal(scan.mock.calls.length, 0);
      assert.equal(repo.commitConnectorSyncPage.mock.calls.length, 0);
      assert.equal(
        repo.archiveConnectorSourcesNotSeenInRun.mock.calls.length,
        0,
      );
      assert.equal(repo.archiveConnectorSources.mock.calls.length, 0);
      assert.equal(
        repo.markOAuthAccountReauthRequiredRecord.mock.calls.length,
        0,
      );
    },
  );

  test("a manual sync with an empty selection is skipped with selection_required and nothing is queued", async () => {
    seedConnector(EMPTY);
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "selection_required",
      message: "Choose what to index first.",
    });
    const enqueue = vi.fn();

    const outcome = await orchestrator().enqueueManualRun({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "conn_1",
      enqueue,
    });

    assert.equal(outcome.skipped, true);
    assert.equal(outcome.reason, "selection_required");
    assert.equal(outcome.message, "Choose what to index first.");
    assert.equal(enqueue.mock.calls.length, 0);
    assert.equal(repo.createSyncRunRecordIfNoActiveRun.mock.calls.length, 0);
    assert.equal(repo.archiveConnectorSourcesNotSeenInRun.mock.calls.length, 0);
    assert.equal(connectors.get("conn_1")?.status, "active");
    assert.equal(connectors.get("conn_1")?.lastError, null);
  });

  test("a later ready check removes the stored readiness metadata and queues the sync", async () => {
    seedConnector({
      ...SELECTED,
      syncReadiness: {
        ready: false,
        reason: "selection_required",
        message: "Choose what to index first.",
        checkedAt: "2026-11-26T00:00:00.000Z",
      },
    });

    const { enqueue, result } = scheduledRun(
      vi.fn(async () => ({ id: "job-1" })),
    );
    const outcome = await result;

    assert.equal(outcome.skipped, undefined);
    assert.equal(enqueue.mock.calls.length, 1);
    assert.deepEqual(connectors.get("conn_1")?.configJson, SELECTED);
  });
});

describe("a run that starts with an empty selection", () => {
  test("an adapter failure before the first page fails the run, errors the connector, and archives nothing", async () => {
    seedConnector(EMPTY);
    // The capability's own error class, not a platform ConnectorError.
    const failure = new AdapterError(
      400,
      "DISCOURSE_SELECTION_REQUIRED",
      "Choose what to index first.",
    );
    scan.mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(failure) }),
    });

    const error = await rejection(orchestrator().run(RUN_INPUT));

    assert.equal(error.code, "DISCOURSE_SELECTION_REQUIRED");
    const failed = lastRunPatch("failed");
    assert.equal(failed?.errorCode, "DISCOURSE_SELECTION_REQUIRED");
    assert.equal(failed?.errorMessage, "Choose what to index first.");
    const touched = repo.touchConnectorAfterSync.mock.calls[0]?.[0] as {
      status: string;
      lastError: string;
    };
    assert.equal(touched.status, "error");
    assert.equal(touched.lastError, "Choose what to index first.");
    // The schedule sees the adapter's own code: it retries with backoff (at
    // most three attempts), is not treated as a reauthorization, and the
    // schedule itself stays enabled.
    const completed = repo.completeScheduleOccurrence.mock.calls.at(
      -1,
    )?.[0] as {
      succeeded: boolean;
      errorCode: string;
    };
    assert.equal(completed.succeeded, false);
    assert.equal(completed.errorCode, "DISCOURSE_SELECTION_REQUIRED");
    assert.equal(repo.archiveConnectorSourcesNotSeenInRun.mock.calls.length, 0);
    assert.equal(repo.commitConnectorSyncPage.mock.calls.length, 0);
    assert.equal(
      repo.markOAuthAccountReauthRequiredRecord.mock.calls.length,
      0,
    );
    assert.equal(getRuntimeToken.mock.calls.length, 0);
  });
});

describe("reconciliation of a scan", () => {
  test("a complete page with reconcileMissing archives what the run did not see, before it commits the page", async () => {
    seedConnector(SELECTED);
    repo.archiveConnectorSourcesNotSeenInRun.mockResolvedValue(3);
    scanYielding({
      items: [],
      complete: true,
      reconcileMissing: true,
      checkpoint: null,
    });

    const run = await orchestrator().run(RUN_INPUT);

    assert.ok(run);
    assert.equal(repo.archiveConnectorSourcesNotSeenInRun.mock.calls.length, 1);
    assert.deepEqual(
      repo.archiveConnectorSourcesNotSeenInRun.mock.calls[0]?.[0],
      {
        teamId: "team",
        workspaceId: "workspace",
        connectorId: "conn_1",
        runId: "run-1",
      },
    );
    assert.ok(
      repo.archiveConnectorSourcesNotSeenInRun.mock.invocationCallOrder[0]! <
        repo.commitConnectorSyncPage.mock.invocationCallOrder[0]!,
    );
    assert.equal(lastRunPatch("succeeded") !== undefined, true);
  });

  test("a scan with nothing to reconcile (no items, no reconcile, no checkpoint) archives nothing and commits no checkpoint", async () => {
    seedConnector(SELECTED);
    scanYielding({
      items: [],
      complete: true,
      reconcileMissing: false,
      checkpoint: null,
    });

    await orchestrator().run(RUN_INPUT);

    assert.equal(repo.archiveConnectorSourcesNotSeenInRun.mock.calls.length, 0);
    assert.equal(repo.archiveConnectorSources.mock.calls.length, 0);
    const commit = repo.commitConnectorSyncPage.mock.calls[0]?.[0] as {
      complete: boolean;
      checkpoint: unknown;
    };
    assert.equal(commit.complete, true);
    assert.equal(commit.checkpoint, null);
    assert.equal(lastRunPatch("succeeded") !== undefined, true);
  });

  test("reconcileMissing on a page that is not complete is refused and archives nothing", async () => {
    seedConnector(SELECTED);
    scanYielding({
      items: [],
      complete: false,
      reconcileMissing: true,
      checkpoint: null,
    });

    const error = await rejection(orchestrator().run(RUN_INPUT));

    assert.equal(error.code, "CONNECTOR_RECONCILIATION_INVALID");
    assert.equal(repo.archiveConnectorSourcesNotSeenInRun.mock.calls.length, 0);
    assert.equal(
      lastRunPatch("failed")?.errorCode,
      "CONNECTOR_RECONCILIATION_INVALID",
    );
  });

  test("reconcileMissing on a run restricted to target items is refused and archives nothing", async () => {
    seedConnector(SELECTED);
    scanYielding({
      items: [],
      complete: true,
      reconcileMissing: true,
      checkpoint: null,
    });

    const error = await rejection(
      orchestrator().run({ ...RUN_INPUT, targetExternalIds: ["topic:77"] }),
    );

    assert.equal(error.code, "CONNECTOR_RECONCILIATION_INVALID");
    assert.equal(repo.archiveConnectorSourcesNotSeenInRun.mock.calls.length, 0);
  });
});

describe("the sync scope of a selection connector", () => {
  test("a PATCH of configJson.items persists, re-checks readiness on the new config, and changes the scope hash", async () => {
    seedConnector(SELECTED);
    scanYielding({
      items: [],
      complete: true,
      reconcileMissing: false,
      checkpoint: null,
    });
    await orchestrator().run(RUN_INPUT);
    await orchestrator().run(RUN_INPUT);

    const next = { forumUrl: FORUM, items: [CATEGORY] };
    const updated = await service.updateConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "conn_1",
      configJson: next,
    });
    assert.deepEqual(updated.connector.configJson, next);
    assert.deepEqual(
      (checkSyncReadiness.mock.calls.at(-1)?.[0] as { config: unknown }).config,
      next,
    );

    await orchestrator().run(RUN_INPUT);

    const [first, second, third] = scopeHashes();
    assert.equal(scopeHashes().length, 3);
    assert.equal(first, second, "an unchanged selection keeps the scope");
    assert.notEqual(second, third, "a changed selection starts a new scope");
  });

  test("the scope hash does not depend on the key order of the stored config", async () => {
    seedConnector({
      items: [{ kind: "category", id: "category:5" }],
      forumUrl: FORUM,
    });
    scanYielding({
      items: [],
      complete: true,
      reconcileMissing: false,
      checkpoint: null,
    });
    await orchestrator().run(RUN_INPUT);
    connectors.get("conn_1")!.configJson = {
      forumUrl: FORUM,
      items: [CATEGORY],
    };
    await orchestrator().run(RUN_INPUT);

    const [first, second] = scopeHashes();
    assert.equal(first, second);
  });
});

describe("a selection connector with nothing selected yet", () => {
  test("can be created with an empty selection: selection_required is not a configuration fault", async () => {
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "selection_required",
      message: "Choose what to index first.",
    });

    const created = await service.createConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorType: CONNECTOR_TYPE,
      name: "Forum",
      configJson: EMPTY,
    });

    assert.deepEqual(created.connector.configJson, EMPTY);
    assert.equal(repo.createSourceConnectorRecord.mock.calls.length, 1);
  });

  test("can have its selection cleared by a PATCH", async () => {
    seedConnector(SELECTED);
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "selection_required",
      message: "Choose what to index first.",
    });

    const updated = await service.updateConnector({
      workspaceId: "workspace",
      userId: "user",
      connectorId: "conn_1",
      configJson: EMPTY,
    });

    assert.deepEqual(updated.connector.configJson, EMPTY);
    assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 1);
  });

  test.each(FORUM_READINESS_REASONS.filter((r) => r !== "selection_required"))(
    "a %s readiness result still refuses create and PATCH with the reason and persists nothing",
    async (reason) => {
      seedConnector(SELECTED);
      checkSyncReadiness.mockResolvedValue({
        ready: false,
        reason,
        message: `Not ready: ${reason}`,
      });

      const createError = await rejection(
        service.createConnector({
          workspaceId: "workspace",
          userId: "user",
          connectorType: CONNECTOR_TYPE,
          name: "Forum",
          configJson: SELECTED,
        }),
      );
      assert.equal(createError.statusCode, 400);
      assert.equal(createError.code, "CONNECTOR_CONFIG_NOT_READY");
      assert.equal(createError.details?.reason, reason);

      const patchError = await rejection(
        service.updateConnector({
          workspaceId: "workspace",
          userId: "user",
          connectorId: "conn_1",
          configJson: { forumUrl: FORUM, items: [CATEGORY] },
        }),
      );
      assert.equal(patchError.code, "CONNECTOR_CONFIG_NOT_READY");
      assert.equal(patchError.details?.reason, reason);
      assert.equal(repo.createSourceConnectorRecord.mock.calls.length, 0);
      assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 0);
    },
  );

  test("a none connector WITHOUT a declared selection still refuses selection_required on create and PATCH", async () => {
    seedConnector(SELECTED, { connectorType: PLAIN_NONE_TYPE });
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "selection_required",
      message: "Choose what to index first.",
    });

    const createError = await rejection(
      service.createConnector({
        workspaceId: "workspace",
        userId: "user",
        connectorType: PLAIN_NONE_TYPE,
        name: "Plain",
        configJson: EMPTY,
      }),
    );
    assert.equal(createError.statusCode, 400);
    assert.equal(createError.code, "CONNECTOR_CONFIG_NOT_READY");
    assert.equal(createError.details?.reason, "selection_required");

    const patchError = await rejection(
      service.updateConnector({
        workspaceId: "workspace",
        userId: "user",
        connectorId: "conn_1",
        configJson: EMPTY,
      }),
    );
    assert.equal(patchError.code, "CONNECTOR_CONFIG_NOT_READY");
    assert.equal(patchError.details?.reason, "selection_required");
    assert.equal(repo.createSourceConnectorRecord.mock.calls.length, 0);
    assert.equal(repo.updateSourceConnectorRecord.mock.calls.length, 0);
  });

  test.each([CREDENTIAL_SELECTION_TYPE, CREDENTIAL_PLAIN_TYPE])(
    "a credential connector (%s) still refuses selection_required on create",
    async (connectorType) => {
      checkSyncReadiness.mockResolvedValue({
        ready: false,
        reason: "selection_required",
        message: "Choose what to index first.",
      });

      const error = await rejection(
        service.createConnector({
          workspaceId: "workspace",
          userId: "user",
          connectorType,
          name: "Credentialed",
          configJson: EMPTY,
          credential: { username: "users/1", secret: "s3cret-value" },
        }),
      );

      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "CONNECTOR_CONFIG_NOT_READY");
      assert.equal(error.details?.reason, "selection_required");
      assert.equal(repo.createCredentialConnectorRecord.mock.calls.length, 0);
    },
  );

  test("the readiness check endpoint reports selection_required as it is, without rejecting", async () => {
    checkSyncReadiness.mockResolvedValue({
      ready: false,
      reason: "selection_required",
      message: "Choose what to index first.",
    });

    const result = await service.checkConfigReadiness({
      workspaceId: "workspace",
      userId: "user",
      connectorType: CONNECTOR_TYPE,
      configJson: EMPTY,
    });

    assert.deepEqual(result, {
      ready: false,
      reason: "selection_required",
      message: "Choose what to index first.",
    });
  });
});

describe("the selection actions of a none connector", () => {
  function runAction(
    action: "browse" | "search" | "describe",
    request: unknown,
    row = connectorRow("conn_1", SELECTED),
  ) {
    return runConnectorSelectionAction({
      connector: row,
      teamId: "team",
      workspaceId: "workspace",
      action,
      request,
      deps: {
        getRuntimeToken: getRuntimeToken as never,
        getAdapter: (type) => registry.getAdapter(type),
        getManifest: (type) => registry.getManifest(type),
      },
    });
  }

  const entry = (id: string, kind: string) => ({
    id,
    kind,
    name: id,
    detail: null,
    selectable: true,
    expandable: kind === "category",
    disabledReason: null,
    size: null,
    modifiedAt: null,
  });

  test("browse, search and describe reach the adapter with the declared action, the request untouched, and no token", async () => {
    executeAction.mockImplementation(async (input: { actionType: string }) => {
      if (input.actionType === "synthetic.browse") {
        return {
          result: {
            container: {
              id: "category:5",
              kind: "category",
              name: "General",
              detail: null,
            },
            breadcrumbs: [],
            entries: [entry("topic:77", "topic")],
            cursor: "",
            hasMore: false,
          },
        };
      }
      if (input.actionType === "synthetic.search") {
        return {
          result: {
            entries: [entry("topic:77", "topic")],
            cursor: "",
            hasMore: false,
          },
        };
      }
      return {
        result: {
          items: [
            {
              id: "category:5",
              kind: "category",
              name: "General",
              detail: null,
              exists: true,
            },
            {
              id: "topic:77",
              kind: "topic",
              name: "Hello",
              detail: null,
              exists: false,
            },
          ],
        },
      };
    });

    const browse = (await runAction("browse", {
      containerId: "category:5",
      cursor: "abc",
    })) as { entries: Array<{ id: string }> };
    const search = (await runAction("search", { query: "hello" })) as {
      entries: Array<{ id: string }>;
    };
    const ids = ["category:5", "topic:77"];
    const describe = (await runAction("describe", { ids })) as {
      items: Array<{ id: string; kind: string }>;
    };

    const calls = executeAction.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    assert.deepEqual(
      calls.map((call) => call.actionType),
      ["synthetic.browse", "synthetic.search", "synthetic.describe"],
    );
    assert.deepEqual(calls[0]?.request, {
      containerId: "category:5",
      cursor: "abc",
    });
    assert.deepEqual(calls[1]?.request, { query: "hello" });
    assert.deepEqual(calls[2]?.request, { ids });
    for (const call of calls) {
      assert.equal(call.accessToken, "");
      assert.equal(call.connectorType, CONNECTOR_TYPE);
      assert.equal(call.connectorId, "conn_1");
      assert.deepEqual(call.config, SELECTED);
    }
    assert.equal(getRuntimeToken.mock.calls.length, 0);
    // Kind-qualified ids come back exactly as the adapter produced them.
    assert.equal(browse.entries[0]?.id, "topic:77");
    assert.equal(search.entries[0]?.id, "topic:77");
    assert.deepEqual(
      describe.items.map((item) => `${item.kind}:${item.id}`),
      ["category:category:5", "topic:topic:77"],
    );
  });

  test("a connector with nothing selected still browses (the selection is chosen with these actions)", async () => {
    executeAction.mockResolvedValue({
      result: {
        container: null,
        breadcrumbs: [],
        entries: [],
        cursor: "",
        hasMore: false,
      },
    });

    const result = await runAction("browse", {}, connectorRow("conn_1", EMPTY));

    assert.equal((result as { entries: unknown[] }).entries.length, 0);
    assert.deepEqual(
      (executeAction.mock.calls[0]?.[0] as { config: unknown }).config,
      EMPTY,
    );
  });
});
