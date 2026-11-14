import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

const state = vi.hoisted(() => ({
  workspace: { id: "", organizationId: "" },
  indexSource: vi.fn(),
  getThread: vi.fn(),
}));

vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: async () => state.workspace,
}));
vi.mock("../sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources")>()),
  sourceIndexingService: { indexSource: state.indexSource },
}));
vi.mock("../threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threads")>()),
  contentThreadService: { getThread: state.getThread },
}));

/**
 * Issue #496: a saved answer becomes a `note` source plus a `notes` row that
 * remembers the message and the sources it cited. Saving twice returns the
 * first note; a failed index leaves nothing behind.
 */

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let service: typeof import("./service");
const originalDatabaseUrl = process.env.DATABASE_URL;

const userId = "saver";
let teamId: string;
let workspaceId: string;
let threadId: string;
let messageId: string;
let citedSourceId: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("note_save");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  service = await import("./service");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, threadId, messageId, citedSourceId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  state.workspace = { id: workspaceId, organizationId: teamId };
  state.indexSource.mockReset().mockResolvedValue({});
  state.getThread.mockReset().mockResolvedValue({});
  const { db } = schema;
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Notes",
    slug: `notes-${workspaceId}`,
  });
  await db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Thread",
    createdBy: userId,
  });
  await db.insert(schema.sources).values({
    id: citedSourceId,
    teamId,
    workspaceId,
    title: "Annual report",
    status: "indexed",
  });
  await db.insert(schema.messages).values({
    id: messageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "# Revenue\n\nRevenue grew 23% [citation:c1].",
    metadata: {
      retrieval: {
        citations: [
          {
            citation: "c1",
            sourceId: citedSourceId,
            sourceTitle: "Annual report",
            chunkId: "chunk-1",
            excerpt: "Overview. Revenue grew 23% to $4.1 billion.",
            spanText: "Revenue grew 23% to $4.1 billion.",
          },
        ],
      },
    },
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

const save = () => service.saveAnswerAsNote({ workspaceId, userId, messageId });

async function noteSourcesOf(type: "note") {
  return schema.db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.sourceType, type));
}

test("saves the answer as an indexed note source with footnotes and a sources list", async () => {
  const result = await save();

  assert.equal(result.alreadySaved, false);
  assert.equal(result.title, "Revenue");
  const [source] = (await noteSourcesOf("note")).filter(
    (row) => row.workspaceId === workspaceId,
  );
  assert.ok(source);
  assert.equal(source.id, result.sourceId);
  assert.equal(source.ingestKind, "note");
  assert.ok(source.contentText.includes("Revenue grew 23% [1]."));
  assert.ok(
    source.contentText.includes(
      '[1] Annual report: "Revenue grew 23% to $4.1 billion."',
    ),
  );
  assert.equal(source.contentText.includes("citation:"), false);
  assert.equal(state.indexSource.mock.calls[0]?.[0].userId, userId);
});

test("remembers the message and the sources the answer cited", async () => {
  const result = await save();

  const [note] = await schema.db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.id, result.noteId));
  assert.equal(note?.noteType, "saved_response");
  assert.equal(note?.sourceMessageId, messageId);
  assert.equal(note?.threadId, threadId);
  assert.equal(note?.sourceId, result.sourceId);
  const references = (
    note?.contentJson as { references: Array<Record<string, unknown>> }
  ).references;
  assert.equal(references[0]?.passage, "Revenue grew 23% to $4.1 billion.");
  const linked = await schema.db
    .select()
    .from(schema.noteSources)
    .where(eq(schema.noteSources.noteId, result.noteId));
  assert.deepEqual(
    linked.map((row) => row.sourceId),
    [citedSourceId],
  );
});

test("saving the same message again returns the first note without a second source", async () => {
  const first = await save();
  const second = await save();

  assert.equal(second.alreadySaved, true);
  assert.equal(second.noteId, first.noteId);
  assert.equal(
    (await noteSourcesOf("note")).filter(
      (row) => row.workspaceId === workspaceId,
    ).length,
    1,
  );
  assert.equal(state.indexSource.mock.calls.length, 1);
});

test("a failed index leaves no source and no note behind", async () => {
  state.indexSource.mockRejectedValue(new Error("embedding down"));

  await assert.rejects(save(), /embedding down/);

  assert.equal(
    (await noteSourcesOf("note")).filter(
      (row) => row.workspaceId === workspaceId,
    ).length,
    0,
  );
  const rows = await schema.db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.workspaceId, workspaceId));
  assert.equal(rows.length, 0);
});

test("only an assistant answer with text can be saved", async () => {
  const userMessageId = randomUUID();
  await schema.db.insert(schema.messages).values({
    id: userMessageId,
    teamId,
    workspaceId,
    threadId,
    role: "user",
    content: "question",
  });
  await assert.rejects(
    service.saveAnswerAsNote({ workspaceId, userId, messageId: userMessageId }),
    /Message not found/,
  );

  await schema.db
    .update(schema.messages)
    .set({ content: "  " })
    .where(eq(schema.messages.id, messageId));
  await assert.rejects(save(), /no answer text/);
});

test("a thread the user cannot read cannot be saved from", async () => {
  state.getThread.mockRejectedValue(new Error("Thread not found"));

  await assert.rejects(save(), /Thread not found/);

  assert.equal(state.indexSource.mock.calls.length, 0);
});

test("a message from another workspace is not found", async () => {
  state.workspace = { id: randomUUID(), organizationId: teamId };

  await assert.rejects(save(), /Message not found/);
});
