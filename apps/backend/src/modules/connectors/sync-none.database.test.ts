import assert from "node:assert/strict";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { makeSetup, item } from "./sync-test-support";
import type { ConnectorAdapter } from "./types";

const workspaceRef = vi.hoisted(() => ({
  current: { id: "", organizationId: "" },
}));

// The readiness case goes through `enqueueManualRun`, whose workspace
// permission check needs a seeded membership; it is not what this suite tests.
vi.mock("./permissions", () => ({
  requireConnectorWorkspace: vi.fn(async () => ({
    workspace: workspaceRef.current,
    membership: { role: "workspace_admin" },
  })),
}));

let schema: typeof import("@sourceweft/db");
let connectorRuntime: typeof import("./index");
let syncRunRepo: typeof import("./repository/sync-run");
let indexing: typeof import("../sources/indexing-service");
let setup: ReturnType<typeof makeSetup>;
let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const originalUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("none_sync");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  connectorRuntime = await import("./index");
  syncRunRepo = await import("./repository/sync-run");
  indexing = await import("../sources/indexing-service");
  setup = makeSetup({ schema, connectorRuntime, syncRunRepo, indexing });
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalUrl;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

const NONE_TYPE = "none_feed";

/** A credential-less adapter that records the token it receives at each seam. */
function noneAdapter() {
  const feedItem = item("a");
  const discoverPages = vi.fn(async function* (_input: unknown) {
    const { body: _body, extractShape: _shape, ...rest } = feedItem;
    yield {
      items: [rest],
      continuation: null,
      checkpoint: { history: "h1" },
      complete: true,
    };
  });
  const extract = vi.fn(async (input: { item: { externalId: string } }) => ({
    item: input.item,
    contentText: feedItem.body,
  }));
  const checkSyncReadiness = vi.fn(async (_input: unknown) => ({
    ready: true as const,
  }));
  const adapter = {
    getManifest: () => ({
      type: NONE_TYPE,
      displayName: "None feed",
      auth: { kind: "none" as const },
      sync: {
        supportsIncremental: true,
        defaultFrequencyMinutes: 60,
        resources: [
          {
            type: "feed_item",
            displayName: "Feed item",
            supportsDeleteDetection: false,
          },
        ],
      },
      actions: [],
      configSchema: { type: "object" },
    }),
    async *discover() {},
    discoverPages,
    extract,
    checkSyncReadiness,
  } as unknown as ConnectorAdapter;
  return { adapter, discoverPages, extract, checkSyncReadiness };
}

const throwingToken = () =>
  vi.fn(async () => {
    throw new Error("getRuntimeToken must not be called for a none connector");
  });

test("a none connector with no account syncs with an empty access token", async () => {
  const getRuntimeToken = throwingToken();
  const built = noneAdapter();
  const t = await setup({
    pagesOf: [],
    adapter: built.adapter,
    connectorType: NONE_TYPE,
    getRuntimeToken,
  });

  const run = await t.sync();

  assert.equal(run.status, "succeeded");
  assert.equal(getRuntimeToken.mock.calls.length, 0);
  assert.equal(t.fake.discoverPages.mock.calls.length, 1);
  assert.equal(
    (t.fake.discoverPages.mock.calls[0]?.[0] as { accessToken: string })
      .accessToken,
    "",
  );
  assert.equal(t.fake.extract.mock.calls.length, 1);
  assert.equal(
    (t.fake.extract.mock.calls[0]?.[0] as { accessToken: string }).accessToken,
    "",
  );
});

test("the readiness check of a none connector gets an empty access token", async () => {
  const getRuntimeToken = throwingToken();
  const built = noneAdapter();
  const t = await setup({
    pagesOf: [],
    adapter: built.adapter,
    connectorType: NONE_TYPE,
    getRuntimeToken,
  });
  workspaceRef.current = { id: t.workspaceId, organizationId: t.teamId };
  const enqueue = vi.fn().mockResolvedValue({ id: "job-1" });

  await t.orchestrator.enqueueManualRun({
    workspaceId: t.workspaceId,
    userId: "user",
    connectorId: t.connectorId,
    enqueue,
  });

  assert.equal(getRuntimeToken.mock.calls.length, 0);
  assert.equal(built.checkSyncReadiness.mock.calls.length, 1);
  assert.equal(
    (built.checkSyncReadiness.mock.calls[0]?.[0] as { accessToken: string })
      .accessToken,
    "",
  );
  assert.equal(enqueue.mock.calls.length, 1);
});
