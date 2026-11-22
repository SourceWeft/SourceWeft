import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

const state = vi.hoisted(() => ({
  workspace: { id: "", organizationId: "" },
  indexSource: vi.fn(),
}));

vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: async () => state.workspace,
}));
vi.mock("../sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources")>()),
  sourceIndexingService: { indexSource: state.indexSource },
}));

/**
 * Issue #678: a finished research report becomes a `note` source plus a
 * `generated` `notes` row keyed on the run. Only a ready run can be saved;
 * saving twice returns the first note and makes nothing new.
 */

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let service: typeof import("./research-report");
const originalDatabaseUrl = process.env.DATABASE_URL;

const userId = "saver";
let teamId: string;
let workspaceId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("res_note_save");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  service = await import("./research-report");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId] = [randomUUID(), randomUUID()];
  state.workspace = { id: workspaceId, organizationId: teamId };
  state.indexSource.mockReset().mockResolvedValue({});
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Research",
    slug: `research-${workspaceId}`,
  });
});

afterEach(async () => {
  if (schema)
    await schema.db
      .delete(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId));
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function insertRun(
  overrides: Partial<typeof schema.sourceResearchRuns.$inferInsert> = {},
) {
  const id = randomUUID();
  await schema.db.insert(schema.sourceResearchRuns).values({
    id,
    teamId,
    workspaceId,
    createdByUserId: userId,
    topic: "Solid-state batteries",
    status: "ready",
    phase: "reporting",
    ledgerJson: [
      {
        id: "e1",
        url: "https://example.com/a",
        title: "Battery advances",
        points: ["point"],
        quotes: ["Solid-state cells reach higher density."],
      },
    ],
    reportMarkdown: "Cells are denser [1].",
    reportCitationsJson: [
      {
        entryId: "e1",
        quote: "Solid-state cells reach higher density.",
        status: "verified",
      },
    ],
    ...overrides,
  });
  return id;
}

const save = (runId: string) =>
  service.saveResearchReportAsNote({ workspaceId, userId, runId });

async function noteSourcesInWorkspace() {
  return (
    await schema.db
      .select()
      .from(schema.sources)
      .where(eq(schema.sources.sourceType, "note"))
  ).filter((row) => row.workspaceId === workspaceId);
}

test("a ready run saves as an indexed note source and is retrievable", async () => {
  const runId = await insertRun();

  const result = await save(runId);

  assert.equal(result.alreadySaved, false);
  assert.equal(result.title, "Solid-state batteries");

  const sources = await noteSourcesInWorkspace();
  assert.equal(sources.length, 1);
  const source = sources[0]!;
  assert.equal(source.id, result.sourceId);
  assert.equal(source.ingestKind, "note");
  // The report body is kept verbatim: the [n] marker stays as plain text.
  assert.ok(source.contentText.includes("Cells are denser [1]."));
  // A Sources list is appended so the note is self-contained.
  assert.ok(source.contentText.includes("## Sources"));
  assert.ok(source.contentText.includes("https://example.com/a"));
  assert.equal(state.indexSource.mock.calls[0]?.[0].userId, userId);

  const [note] = await schema.db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.id, result.noteId));
  assert.equal(note?.noteType, "generated");
  assert.equal(note?.threadId, null);
  assert.equal(note?.sourceMessageId, null);
  assert.equal(note?.sourceId, result.sourceId);
  assert.equal(
    (note?.contentJson as { researchRunId?: string }).researchRunId,
    runId,
  );
});

test("a run that is not ready cannot be saved", async () => {
  const runId = await insertRun({
    status: "queued",
    phase: null,
    reportMarkdown: null,
    reportCitationsJson: null,
  });

  await assert.rejects(save(runId), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RESEARCH_NOT_READY");
    return true;
  });
  assert.equal(state.indexSource.mock.calls.length, 0);
  assert.equal((await noteSourcesInWorkspace()).length, 0);
});

test("an unknown run is a not-found", async () => {
  await assert.rejects(save(randomUUID()), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "RESEARCH_NOT_FOUND");
    return true;
  });
});

test("saving the same run again returns the first note and exactly one source", async () => {
  const runId = await insertRun();

  const first = await save(runId);
  const second = await save(runId);

  assert.equal(second.alreadySaved, true);
  assert.equal(second.noteId, first.noteId);
  assert.equal(second.sourceId, first.sourceId);
  assert.equal((await noteSourcesInWorkspace()).length, 1);
  assert.equal(state.indexSource.mock.calls.length, 1);

  const notes = await schema.db
    .select()
    .from(schema.notes)
    .where(
      and(
        eq(schema.notes.workspaceId, workspaceId),
        eq(schema.notes.noteType, "generated"),
      ),
    );
  assert.equal(notes.length, 1);
});

test("a failed index leaves no source and no note behind", async () => {
  const runId = await insertRun();
  state.indexSource.mockRejectedValue(new Error("embedding down"));

  await assert.rejects(save(runId), /embedding down/);

  assert.equal((await noteSourcesInWorkspace()).length, 0);
  const notes = await schema.db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.workspaceId, workspaceId));
  assert.equal(notes.length, 0);
});

test("a failed note insert removes the just-indexed source", async () => {
  const runId = await insertRun();
  // The source is created and indexed before the note row; force that insert's
  // transaction to throw and the source it left behind must be cleaned up.
  const txSpy = vi
    .spyOn(schema.db, "transaction")
    .mockRejectedValueOnce(new Error("note insert failed"));

  await assert.rejects(save(runId), /note insert failed/);
  txSpy.mockRestore();

  assert.equal((await noteSourcesInWorkspace()).length, 0);
  const notes = await schema.db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.workspaceId, workspaceId));
  assert.equal(notes.length, 0);
});
