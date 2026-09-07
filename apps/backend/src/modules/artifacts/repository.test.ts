import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, test, vi } from "vitest";

/**
 * The artifact row and its version row are one publish. These tests pin the
 * atomicity: when the version insert fails, nothing about the artifact row may
 * survive — previously the two INSERTs were independent statements, so a
 * failure between them left a status=ready artifact with zero versions.
 *
 * The fake db below models exactly the property that matters: writes made
 * inside `transaction` are staged and only applied on successful commit.
 */

type Write = { table: string; values: Record<string, unknown> };

type FakeDbState = {
  committed: Write[];
  /** Set to make the next insert into this table throw. */
  failInsertInto: string | null;
  /** Rows returned by the CAS update. Empty means "lost the race". */
  updateReturning: Array<{ id: string }>;
  /** Rows the version-number select resolves to. */
  latestVersionRows: Array<{ versionNo: number }>;
  /** Order of operations observed inside the transaction. */
  ops: string[];
  /** Named projections observed by select(). */
  selectedShapes: Array<Record<string, unknown> | undefined>;
  /** Rows returned by the bounded gallery query. */
  summaryRows: Array<Record<string, unknown>>;
  whereConditions: SQL[];
};

const state: FakeDbState = {
  committed: [],
  failInsertInto: null,
  updateReturning: [{ id: "artifact-1" }],
  latestVersionRows: [],
  ops: [],
  selectedShapes: [],
  summaryRows: [],
  whereConditions: [],
};

function tableNameOf(table: unknown) {
  const symbols = Object.getOwnPropertySymbols(table as object);
  for (const symbol of symbols) {
    if (String(symbol).includes("Name")) {
      const value = (table as Record<symbol, unknown>)[symbol];
      if (typeof value === "string") {
        return value;
      }
    }
  }
  return "unknown";
}

function makeClient(staged: Write[]) {
  const thenableSelect = (rows: unknown[]) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["from", "orderBy", "limit", "for"]) {
      builder[method] = () => builder;
    }
    builder.where = (condition: SQL) => {
      state.whereConditions.push(condition);
      return builder;
    };
    builder.then = (resolve: (value: unknown) => unknown) => resolve(rows);
    return builder;
  };

  return {
    insert(table: unknown) {
      return {
        values: async (values: Record<string, unknown>) => {
          const name = tableNameOf(table);
          state.ops.push(`insert:${name}`);
          if (state.failInsertInto === name) {
            throw new Error(`simulated insert failure on ${name}`);
          }
          staged.push({ table: name, values });
        },
      };
    },
    update(table: unknown) {
      const name = tableNameOf(table);
      return {
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              state.ops.push(`update:${name}`);
              if (state.updateReturning.length > 0) {
                staged.push({ table: name, values });
              }
              return state.updateReturning;
            },
          }),
        }),
      };
    },
    select(shape?: Record<string, unknown>) {
      const isVersionSelect = Boolean(shape && "versionNo" in shape);
      const isSummarySelect = Boolean(shape && "promptExcerpt" in shape);
      state.selectedShapes.push(shape);
      state.ops.push(
        isVersionSelect
          ? "select:versionNo"
          : isSummarySelect
            ? "select:artifactSummary"
            : "select:artifact",
      );
      return thenableSelect(
        isVersionSelect
          ? state.latestVersionRows
          : isSummarySelect
            ? state.summaryRows
            : [{ storageKey: "key" }],
      );
    },
  };
}

vi.mock("@sourceweft/db", async () => {
  const actual =
    await vi.importActual<typeof import("@sourceweft/db")>("@sourceweft/db");
  const root = makeClient(state.committed);
  return {
    ...actual,
    db: {
      ...root,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: Write[] = [];
        const result = await fn(makeClient(staged));
        state.committed.push(...staged);
        return result;
      },
    },
  };
});

const {
  createReadyArtifactRecord,
  listArtifactSummaryRecords,
  markArtifactReady,
} = await import("./repository");

const READY_INPUT = {
  artifactId: "artifact-1",
  artifactType: "image" as const,
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "user-1",
  title: "Title",
  prompt: "Prompt",
  payload: { a: 1 },
  storageBucket: "bucket",
  storageKey: "key",
};

const MARK_READY_INPUT = {
  artifactId: "artifact-1",
  teamId: "team-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  payload: { a: 1 },
};

beforeEach(() => {
  state.committed = [];
  state.failInsertInto = null;
  state.updateReturning = [{ id: "artifact-1" }];
  state.latestVersionRows = [];
  state.ops = [];
  state.selectedShapes = [];
  state.summaryRows = [];
  state.whereConditions = [];
});

test("createReadyArtifactRecord commits the artifact and its first version together", async () => {
  const result = await createReadyArtifactRecord(READY_INPUT);

  assert.ok(result.versionId);
  assert.deepEqual(
    state.committed.map((write) => write.table),
    ["artifacts", "artifact_versions"],
  );
});

test("createReadyArtifactRecord leaves no ready artifact when the version insert fails", async () => {
  state.failInsertInto = "artifact_versions";

  await assert.rejects(createReadyArtifactRecord(READY_INPUT));

  // The critical invariant: no artifacts row survived the failed version write.
  assert.deepEqual(state.committed, []);
});

test("markArtifactReady leaves no ready artifact when the version insert fails", async () => {
  state.failInsertInto = "artifact_versions";

  await assert.rejects(markArtifactReady(MARK_READY_INPUT));

  // Nothing committed at all: in particular no status=ready flip without the
  // matching version row.
  assert.deepEqual(state.committed, []);
});

test("markArtifactReady reads the next version number after the CAS, inside the transaction", async () => {
  state.latestVersionRows = [{ versionNo: 4 }];

  const result = await markArtifactReady(MARK_READY_INPUT);

  assert.ok(result);
  // The version read must not precede the compare-and-swap: outside that window
  // two publishers compute the same next versionNo and one dies on the unique
  // index instead of losing the race cleanly.
  assert.ok(
    state.ops.indexOf("update:artifacts") <
      state.ops.indexOf("select:versionNo"),
    `expected the CAS before the version read, got ${state.ops.join(" -> ")}`,
  );
  const versionWrite = state.committed.find(
    (write) => write.table === "artifact_versions",
  );
  assert.equal(versionWrite?.values.versionNo, 5);
});

test("markArtifactReady writes nothing when the CAS loses the race", async () => {
  state.updateReturning = [];

  const result = await markArtifactReady(MARK_READY_INPUT);

  assert.equal(result, null);
  assert.deepEqual(state.committed, []);
  // A lost race must not even read for a next version number.
  assert.ok(!state.ops.includes("select:versionNo"));
});

test("markArtifactReady advances the version pointer inside the same transaction", async () => {
  state.latestVersionRows = [{ versionNo: 4 }];

  const result = await markArtifactReady(MARK_READY_INPUT);

  assert.equal(result?.versionNo, 5);
  const pointerWrite = state.committed.find(
    (write) =>
      write.table === "artifacts" && "currentVersionNo" in write.values,
  );
  // Same number the version row used, and committed with it: written in a
  // separate transaction the pointer and artifact_versions would disagree in
  // exactly the race the CAS exists to catch.
  assert.equal(pointerWrite?.values.currentVersionNo, 5);
  const versionWrite = state.committed.find(
    (write) => write.table === "artifact_versions",
  );
  assert.equal(versionWrite?.values.versionNo, 5);
});

test("a lost CAS advances no version pointer either", async () => {
  state.updateReturning = [];

  await markArtifactReady(MARK_READY_INPUT);

  assert.equal(
    state.committed.some((write) => "currentVersionNo" in write.values),
    false,
  );
});

test("createReadyArtifactRecord's pointer agrees with its first version", async () => {
  await createReadyArtifactRecord(READY_INPUT);

  const artifactWrite = state.committed.find(
    (write) => write.table === "artifacts",
  );
  const versionWrite = state.committed.find(
    (write) => write.table === "artifact_versions",
  );
  assert.equal(artifactWrite?.values.currentVersionNo, 1);
  assert.equal(versionWrite?.values.versionNo, 1);
});

test("artifact summary query selects bounded fields without payload or raw storage", async () => {
  state.summaryRows = [
    {
      id: "artifact-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      artifactType: "image",
      status: "ready",
      title: "Image",
      promptExcerpt: "Prompt",
      visibility: "private",
      createdAt: new Date("2026-08-23T01:00:00.000Z"),
      completedAt: new Date("2026-08-23T01:01:00.000Z"),
      updatedAt: new Date("2026-08-23T01:01:00.000Z"),
      hasPrimaryFile: true,
      hasPreviewImage: false,
      previewAltText: null,
    },
  ];

  const result = await listArtifactSummaryRecords({
    teamId: "team-1",
    workspaceId: "workspace-1",
    viewerUserId: "user-1",
    limit: 100,
  });

  const shape = state.selectedShapes.find(
    (candidate) => candidate && "promptExcerpt" in candidate,
  );
  assert.ok(shape);
  assert.equal("payloadJson" in shape, false);
  assert.equal("promptText" in shape, false);
  assert.equal("storageKey" in shape, false);
  assert.equal("previewStorageKey" in shape, false);
  assert.equal("previewMetadataJson" in shape, false);
  assert.equal(result.items[0]?.createdAt, "2026-08-23T01:00:00.000Z");
  assert.equal(result.nextCursor, null);
});

test("thread artifact locators retain tenant, thread and viewer visibility filters", async () => {
  await listArtifactSummaryRecords({
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    viewerUserId: "viewer-1",
    limit: 20,
  });

  const query = new PgDialect().sqlToQuery(state.whereConditions[0]!);
  for (const value of ["team-1", "workspace-1", "thread-1", "viewer-1"]) {
    assert.ok(query.params.includes(value), `missing scope: ${value}`);
  }
  for (const column of [
    "team_id",
    "workspace_id",
    "thread_id",
    "visibility",
    "created_by",
  ]) {
    assert.ok(query.sql.includes(`"${column}"`), `missing filter: ${column}`);
  }
  assert.match(query.sql, /\bor\b/);
});

test("artifact summary query keeps limit-plus-one cursor pagination", async () => {
  state.summaryRows = [
    {
      id: "newer",
      workspaceId: "workspace-1",
      threadId: null,
      artifactType: "file",
      status: "ready",
      title: "Newer",
      promptExcerpt: null,
      visibility: "workspace",
      createdAt: new Date("2026-08-23T02:00:00.000Z"),
      completedAt: null,
      updatedAt: new Date("2026-08-23T02:00:00.000Z"),
      hasPrimaryFile: true,
      hasPreviewImage: false,
      previewAltText: null,
    },
    {
      id: "older",
      workspaceId: "workspace-1",
      threadId: null,
      artifactType: "file",
      status: "ready",
      title: "Older",
      promptExcerpt: null,
      visibility: "workspace",
      createdAt: new Date("2026-08-23T01:00:00.000Z"),
      completedAt: null,
      updatedAt: new Date("2026-08-23T01:00:00.000Z"),
      hasPrimaryFile: true,
      hasPreviewImage: false,
      previewAltText: null,
    },
  ];

  const result = await listArtifactSummaryRecords({
    teamId: "team-1",
    workspaceId: "workspace-1",
    limit: 1,
  });

  assert.deepEqual(
    result.items.map((item) => item.id),
    ["newer"],
  );
  assert.ok(result.nextCursor);
  assert.deepEqual(
    JSON.parse(Buffer.from(result.nextCursor, "base64url").toString("utf8")),
    { createdAt: "2026-08-23T01:00:00.000Z", id: "older" },
  );
});
