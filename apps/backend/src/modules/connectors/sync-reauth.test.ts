import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ConnectorAdapter, ConnectorManifest } from "./types";

/**
 * Double-based coverage for the credential reauth handling in
 * {@link ConnectorSyncOrchestrator}: a rejected credential on a `credential`
 * connector marks that connector's account `reauth_required` (so the web
 * reconnect banner shows) and normalises the schedule signal so retries stop,
 * while `oauth2` and `none` connectors are left exactly as they were.
 *
 * The orchestrator's database, billing, indexing and credential seams are all
 * mocked, so this runs in the mock lane. A sibling database-backed test
 * (`sync-reauth.database.test.ts`) proves the same path writes the real account
 * row; it needs PostgreSQL + pgvector and could not be executed locally.
 */

const repo = vi.hoisted(() => ({
  createSyncRunRecord: vi.fn(),
  createSyncRunRecordIfNoActiveRun: vi.fn(),
  attachScheduleOccurrenceRun: vi.fn(),
  completeScheduleOccurrence: vi.fn(),
  commitConnectorSyncPage: vi.fn(),
  archiveConnectorSourcesNotSeenInRun: vi.fn(),
  findSourceConnectorRecord: vi.fn(),
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
  updateSourceConnectorRecord: vi.fn(),
  updateSyncRunRecord: vi.fn(),
}));

vi.mock("./repository", () => repo);
vi.mock("../../shared/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
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
vi.mock("./credential", () => ({
  resolveCredential: vi.fn(async () => "token"),
}));
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: vi.fn(),
}));
vi.mock("./extracted-file", () => ({
  resolveExtractedFile: vi.fn(),
}));
vi.mock("./registry", () => ({
  ConnectorRegistry: class {},
  connectorRegistry: {},
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

import { ConnectorSyncOrchestrator } from "./sync-orchestrator";

type AuthKind = "credential" | "oauth2" | "none";

/** An adapter-boundary error shaped like the platform's ConnectorError
 * (statusCode + code + message), as the WebDAV adapter throws. */
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

function manifest(type: string, authKind: AuthKind): ConnectorManifest {
  const auth =
    authKind === "oauth2"
      ? {
          kind: "oauth2" as const,
          authorizationUrl: "https://provider.example/authorize",
          tokenUrl: "https://provider.example/token",
          scopes: [],
        }
      : authKind === "credential"
        ? { kind: "credential" as const, scheme: "basic" as const }
        : { kind: "none" as const };
  return {
    type,
    displayName: type,
    auth,
    sync: {
      supportsIncremental: false,
      defaultFrequencyMinutes: 360,
      resources: [
        { type: "f", displayName: "F", supportsDeleteDetection: true },
      ],
    },
    actions: [],
    configSchema: { type: "object" },
  } as ConnectorManifest;
}

/** An async iterable whose first iteration rejects, modelling a discovery that
 * fails on its first provider call (as the WebDAV adapter does on a 401). */
function rejectingIterable(error: unknown): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  };
}

function throwingAdapter(m: ConnectorManifest, error: unknown): ConnectorAdapter {
  return {
    getManifest: () => m,
    discover: () => rejectingIterable(error),
    extract: async ({ item }: { item: unknown }) => ({ item }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

function readinessAdapter(
  m: ConnectorManifest,
  readiness: { ready: false; reason: string; message: string },
): ConnectorAdapter {
  return {
    getManifest: () => m,
    checkSyncReadiness: async () => readiness,
    async *discover() {},
    extract: async ({ item }: { item: unknown }) => ({ item }),
    executeAction: async () => ({ result: {} }),
  } as unknown as ConnectorAdapter;
}

function orchestratorFor(m: ConnectorManifest, adapter: ConnectorAdapter) {
  const registry = {
    getAdapter: () => adapter,
    getManifest: () => m,
  };
  return new ConnectorSyncOrchestrator(
    {} as never,
    registry as never,
    { getRuntimeToken: vi.fn() } as never,
    async () => "billing-user",
  );
}

function seedConnector(
  connectorType: string,
  oauthAccountId: string | null = "acct-1",
) {
  repo.findSourceConnectorRecord.mockResolvedValue({
    id: "conn-1",
    teamId: "team-1",
    workspaceId: "ws-1",
    connectorType,
    status: "active",
    configJson: {},
    oauthAccountId,
    createdBy: "owner",
    periodicIndexingEnabled: false,
    indexingFrequencyMinutes: null,
    name: "C",
    syncBlock: null,
    lastError: null,
  });
  repo.findSyncRunRecord.mockResolvedValue({
    id: "run-1",
    triggerType: "manual",
    status: "queued",
    createdBy: "owner",
  });
  repo.tryAcquireConnectorSyncLock.mockResolvedValue(async () => {});
  repo.updateSyncRunRecord.mockResolvedValue({});
}

const RUN_INPUT = {
  runId: "run-1",
  teamId: "team-1",
  workspaceId: "ws-1",
  connectorId: "conn-1",
  userId: "trigger",
};

function lastCompleteCall() {
  return repo.completeScheduleOccurrence.mock.calls.at(-1)?.[0] as {
    runId: string;
    succeeded: boolean;
    errorCode?: string | null;
  };
}

beforeEach(() => {
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.markOAuthAccountReauthRequiredRecord.mockResolvedValue(true);
});

test("a credential connector whose sync is rejected marks its account reauth_required once and stops retries", async () => {
  seedConnector("webdav");
  const m = manifest("webdav", "credential");
  const orch = orchestratorFor(
    m,
    throwingAdapter(m, new AdapterError(422, "WEBDAV_REAUTH_REQUIRED", "nope")),
  );

  await assert.rejects(orch.run(RUN_INPUT), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "WEBDAV_REAUTH_REQUIRED");
    return true;
  });

  assert.equal(repo.markOAuthAccountReauthRequiredRecord.mock.calls.length, 1);
  assert.deepEqual(repo.markOAuthAccountReauthRequiredRecord.mock.calls[0]?.[0], {
    teamId: "team-1",
    workspaceId: "ws-1",
    accountId: "acct-1",
    lastError: "The stored credential was rejected. Reconnect the connector.",
  });
  // The schedule sees the normalised code, so its existing reauth rule stops
  // retrying and disables the schedule.
  const complete = lastCompleteCall();
  assert.equal(complete.succeeded, false);
  assert.equal(complete.errorCode, "CONNECTOR_REAUTH_REQUIRED");
  // The run row keeps the specific adapter diagnostic.
  const failed = repo.updateSyncRunRecord.mock.calls
    .map((call) => call[0] as { status?: string; errorCode?: string })
    .find((patch) => patch.status === "failed");
  assert.equal(failed?.errorCode, "WEBDAV_REAUTH_REQUIRED");
});

test("a credential connector whose adapter rejects the stored credential mid-run with WORDPRESS_REAUTH_REQUIRED marks its account reauth_required and stops retries", async () => {
  seedConnector("wordpress_login");
  const m = manifest("wordpress_login", "credential");
  const orch = orchestratorFor(
    m,
    throwingAdapter(
      m,
      new AdapterError(422, "WORDPRESS_REAUTH_REQUIRED", "nope"),
    ),
  );

  await assert.rejects(orch.run(RUN_INPUT), (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      "WORDPRESS_REAUTH_REQUIRED",
    );
    return true;
  });

  assert.equal(repo.markOAuthAccountReauthRequiredRecord.mock.calls.length, 1);
  assert.deepEqual(
    repo.markOAuthAccountReauthRequiredRecord.mock.calls[0]?.[0],
    {
      teamId: "team-1",
      workspaceId: "ws-1",
      accountId: "acct-1",
      lastError: "The stored credential was rejected. Reconnect the connector.",
    },
  );
  const complete = lastCompleteCall();
  assert.equal(complete.succeeded, false);
  assert.equal(complete.errorCode, "CONNECTOR_REAUTH_REQUIRED");
  const failed = repo.updateSyncRunRecord.mock.calls
    .map((call) => call[0] as { status?: string; errorCode?: string })
    .find((patch) => patch.status === "failed");
  assert.equal(failed?.errorCode, "WORDPRESS_REAUTH_REQUIRED");
});

test("an oauth2 connector rejected with its own _REAUTH_REQUIRED code keeps its code and retry behaviour", async () => {
  seedConnector("dropbox");
  const m = manifest("dropbox", "oauth2");
  const orch = orchestratorFor(
    m,
    throwingAdapter(m, new AdapterError(422, "DROPBOX_REAUTH_REQUIRED", "nope")),
  );

  await assert.rejects(orch.run(RUN_INPUT));

  // oauth2 reauth is the refresh path's job, never this helper's.
  assert.equal(repo.markOAuthAccountReauthRequiredRecord.mock.calls.length, 0);
  // The schedule code is NOT normalised, so the mid-discovery retry behaviour
  // is identical to before this change.
  assert.equal(lastCompleteCall().errorCode, "DROPBOX_REAUTH_REQUIRED");
});

test("an oauth2 connector failing with a non-reauth error is unaffected", async () => {
  seedConnector("dropbox");
  const m = manifest("dropbox", "oauth2");
  const orch = orchestratorFor(
    m,
    throwingAdapter(m, new AdapterError(502, "CONNECTOR_PAGE_INCOMPLETE", "x")),
  );

  await assert.rejects(orch.run(RUN_INPUT));

  assert.equal(repo.markOAuthAccountReauthRequiredRecord.mock.calls.length, 0);
  assert.equal(lastCompleteCall().errorCode, "CONNECTOR_PAGE_INCOMPLETE");
});

test("a none connector failing is never marked and keeps its code", async () => {
  seedConnector("rss", null);
  const m = manifest("rss", "none");
  const orch = orchestratorFor(
    m,
    throwingAdapter(m, new AdapterError(500, "RSS_FETCH_FAILED", "x")),
  );

  await assert.rejects(orch.run(RUN_INPUT));

  assert.equal(repo.markOAuthAccountReauthRequiredRecord.mock.calls.length, 0);
  assert.equal(lastCompleteCall().errorCode, "RSS_FETCH_FAILED");
});

test("a scheduled readiness check that reports reauth marks a credential account but not an oauth2 one", async () => {
  const notReady = {
    ready: false as const,
    reason: "reauth_required",
    message: "Reconnect the connector.",
  };
  repo.createSyncRunRecord.mockResolvedValue({ id: "run-x" });
  repo.updateSyncRunRecord.mockResolvedValue({ id: "run-x" });
  repo.updateSourceConnectorRecord.mockResolvedValue({});

  // Credential connector: the readiness reauth marks the account.
  seedConnector("webdav");
  const credM = manifest("webdav", "credential");
  const credResult = await orchestratorFor(
    credM,
    readinessAdapter(credM, notReady),
  ).enqueueScheduledRun({
    teamId: "team-1",
    workspaceId: "ws-1",
    connectorId: "conn-1",
    userId: "system",
    enqueue: async () => null,
  });
  assert.equal(credResult.skipped, true);
  assert.equal(credResult.reason, "reauth_required");
  assert.equal(repo.markOAuthAccountReauthRequiredRecord.mock.calls.length, 1);

  // oauth2 connector reporting the same readiness reason is left to its own
  // refresh path: this helper never marks it.
  repo.markOAuthAccountReauthRequiredRecord.mockClear();
  seedConnector("dropbox");
  const oauthM = manifest("dropbox", "oauth2");
  await orchestratorFor(oauthM, readinessAdapter(oauthM, notReady)).enqueueScheduledRun({
    teamId: "team-1",
    workspaceId: "ws-1",
    connectorId: "conn-1",
    userId: "system",
    enqueue: async () => null,
  });
  assert.equal(repo.markOAuthAccountReauthRequiredRecord.mock.calls.length, 0);
});
