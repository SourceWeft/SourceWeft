import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

/**
 * Reuse lookups must filter in SQL, not in JS.
 *
 * The old shape was: fetch the newest 20 rows of the type in the thread, then
 * drop the ones whose status or payload did not match. The LIMIT therefore
 * applied *before* the filter, so a perfectly reusable artifact stopped being
 * found as soon as 20 newer artifacts of the same type existed in the thread —
 * silently, and worst on the busiest threads, where regenerating a duplicate
 * costs the most.
 *
 * These tests pin the fix at the seam that caused it: which predicates reach
 * the WHERE clause, and what the LIMIT is applied to.
 */

type Captured = {
  whereColumns: string[];
  limit: number | null;
  rows: Array<Record<string, unknown>>;
  selectCount: number;
};

const captured: Captured = {
  whereColumns: [],
  limit: null,
  rows: [],
  selectCount: 0,
};

/** Column names referenced anywhere in a drizzle SQL condition tree. */
function columnsIn(node: unknown, into: string[] = []): string[] {
  if (!node || typeof node !== "object") {
    return into;
  }
  const name = (node as { name?: unknown }).name;
  const table = (node as { table?: unknown }).table;
  if (typeof name === "string" && table) {
    into.push(name);
  }
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      columnsIn(chunk, into);
    }
  }
  return into;
}

vi.mock("@sourceweft/db", async () => {
  const actual =
    await vi.importActual<typeof import("@sourceweft/db")>("@sourceweft/db");
  const builder: Record<string, unknown> = {};
  builder.from = () => builder;
  builder.where = (condition: unknown) => {
    captured.whereColumns = columnsIn(condition);
    return builder;
  };
  builder.orderBy = () => builder;
  builder.limit = (value: number) => {
    captured.limit = value;
    return builder;
  };
  builder.then = (resolve: (value: unknown) => unknown) =>
    resolve(captured.rows.slice(0, captured.limit ?? captured.rows.length));

  return {
    ...actual,
    db: {
      select: () => {
        captured.selectCount += 1;
        return builder;
      },
    },
  };
});

const { findReusableArtifactRecord } = await import("./repository");

/** A row the database returned, i.e. one that already passed the WHERE clause. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact-old",
    teamId: "team-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    artifactType: "video_presentation",
    status: "ready",
    currentVersionNo: 3,
    requestKey: "request-1",
    title: "A deck",
    promptText: "make a deck",
    payloadJson: {},
    storageBucket: null,
    storageKey: null,
    previewStorageKey: null,
    previewMetadataJson: {},
    errorCode: null,
    errorMessage: null,
    createdBy: "user-1",
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const QUERY = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  artifactType: "video_presentation" as const,
  statuses: ["pending", "running", "ready"] as const,
};

beforeEach(() => {
  captured.whereColumns = [];
  captured.limit = null;
  captured.rows = [];
  captured.selectCount = 0;
});

test("status and request key are predicates, not post-filters", async () => {
  captured.rows = [row()];

  await findReusableArtifactRecord({ ...QUERY, requestKey: "request-1" });

  assert.ok(
    captured.whereColumns.includes("status"),
    `status must reach the WHERE clause, got ${captured.whereColumns.join(", ")}`,
  );
  assert.ok(
    captured.whereColumns.includes("request_key"),
    `request_key must reach the WHERE clause, got ${captured.whereColumns.join(", ")}`,
  );
});

test("a match beyond the old 20-row window is still found", async () => {
  // The database applies the WHERE clause first, so what comes back is the
  // newest *matching* row — its position among all the thread's artifacts of
  // this type is irrelevant. Under the old shape this row was the 25th newest
  // and never survived the LIMIT to be looked at.
  captured.rows = [row({ id: "artifact-25th-newest" })];

  const found = await findReusableArtifactRecord({
    ...QUERY,
    requestKey: "request-1",
  });

  assert.equal(found?.id, "artifact-25th-newest");
  // One matching row is all a column-only match can use, so the limit is 1 and
  // no longer doubles as a scan depth.
  assert.equal(captured.limit, 1);
});

test("a residual payload filter still bounds how many candidates it inspects", async () => {
  // A caller whose match cannot be expressed as a column keeps a JS filter, but
  // it now runs over SQL-narrowed rows rather than over an unfiltered window.
  captured.rows = [
    row({ id: "a", payloadJson: { marker: "no" } }),
    row({ id: "b", payloadJson: { marker: "yes" } }),
  ];

  const found = await findReusableArtifactRecord({
    ...QUERY,
    matchesPayload: (payload) => payload.marker === "yes",
  });

  assert.equal(found?.id, "b");
  assert.equal(captured.limit, 20);
});

test("no candidate status means no query at all", async () => {
  const found = await findReusableArtifactRecord({ ...QUERY, statuses: [] });

  assert.equal(found, null);
  // An empty IN () list is a query that can only ever return nothing.
  assert.equal(captured.selectCount, 0);
});
