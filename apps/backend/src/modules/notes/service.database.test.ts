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
let origin: typeof import("./origin");
let edit: typeof import("./edit");
let saved: typeof import("./saved");
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
  origin = await import("./origin");
  edit = await import("./edit");
  saved = await import("./saved");
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

test("an answer that cited something that is not a source row still saves, and keeps what it cited", async () => {
  // E.g. a file read from a connector's virtual folder: it has an id and a
  // title in the answer's citations but no row in `sources`.
  const virtualId = randomUUID();
  await schema.db
    .update(schema.messages)
    .set({
      metadata: {
        retrieval: {
          citations: [
            {
              citation: "c1",
              sourceId: virtualId,
              sourceTitle: "Mail: access demo",
              excerpt: "This test message was sent from SourceWeft.",
              spanText: "This test message was sent from SourceWeft.",
            },
            {
              citation: "c2",
              sourceId: citedSourceId,
              sourceTitle: "Annual report",
              excerpt: "Revenue grew.",
              spanText: "Revenue grew.",
            },
          ],
        },
      },
      content: "Mail says so [citation:c1]. Revenue grew [citation:c2].",
    })
    .where(eq(schema.messages.id, messageId));

  const result = await save();

  assert.equal(result.alreadySaved, false);
  const linked = await schema.db
    .select()
    .from(schema.noteSources)
    .where(eq(schema.noteSources.noteId, result.noteId));
  assert.deepEqual(
    linked.map((row) => row.sourceId),
    [citedSourceId],
  );
  const [note] = await schema.db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.id, result.noteId));
  const references = (
    note?.contentJson as { references: Array<Record<string, unknown>> }
  ).references;
  assert.equal(references.length, 2);
  assert.ok(references.some((reference) => reference.sourceId === virtualId));
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

async function noteRow(noteId: string) {
  const [row] = await schema.db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.id, noteId));
  return row;
}

async function sourceRow(sourceId: string) {
  const [row] = await schema.db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.id, sourceId));
  return row;
}

test("a saved note carries its text's hash and is editable", async () => {
  const result = await save();

  const source = await sourceRow(result.sourceId);
  const { computeContentHash } = await import("../sources/content-hash");
  assert.equal(source?.contentHash, computeContentHash(source!.contentText));
  assert.equal((await noteRow(result.noteId))?.isEditable, true);
});

test("deleting the note's source deletes its note, so the same answer can be saved again", async () => {
  const first = await save();
  await schema.db
    .delete(schema.sources)
    .where(eq(schema.sources.id, first.sourceId));
  assert.equal(await noteRow(first.noteId), undefined);

  const second = await save();

  assert.equal(second.alreadySaved, false);
  assert.notEqual(second.sourceId, first.sourceId);
});

test("a dead note row left over from before is replaced instead of returned", async () => {
  const deadId = randomUUID();
  await schema.db.insert(schema.notes).values({
    id: deadId,
    teamId,
    workspaceId,
    threadId,
    sourceMessageId: messageId,
    sourceId: null,
    noteType: "saved_response",
    title: "Old",
    createdBy: userId,
  });

  const result = await save();

  assert.equal(result.alreadySaved, false);
  assert.notEqual(result.sourceId, "");
  assert.equal(await noteRow(deadId), undefined);
});

test("the origin names the conversation, when it was saved and what the answer cited", async () => {
  const result = await save();

  const found = await origin.getNoteOrigin({
    workspaceId,
    userId,
    sourceId: result.sourceId,
  });

  assert.ok(found);
  assert.equal(found.noteId, result.noteId);
  assert.deepEqual(found.thread, { id: threadId, title: "Thread" });
  assert.equal(found.messageId, messageId);
  assert.equal(found.editedAt, null);
  assert.equal(found.references.length, 1);
  assert.equal(found.references[0]?.sourceTitle, "Annual report");
  assert.equal(
    found.references[0]?.passage,
    "Revenue grew 23% to $4.1 billion.",
  );
  assert.equal(found.references[0]?.sourceExists, true);
});

test("a cited source that was deleted since is shown as gone", async () => {
  const result = await save();
  await schema.db
    .delete(schema.sources)
    .where(eq(schema.sources.id, citedSourceId));

  const found = await origin.getNoteOrigin({
    workspaceId,
    userId,
    sourceId: result.sourceId,
  });

  assert.equal(found?.references[0]?.sourceExists, false);
});

test("someone who cannot read the conversation sees the cited sources but not the conversation", async () => {
  const result = await save();
  await schema.db
    .update(schema.threads)
    .set({ createdBy: "someone-else", visibility: "private" })
    .where(eq(schema.threads.id, threadId));

  const found = await origin.getNoteOrigin({
    workspaceId,
    userId,
    sourceId: result.sourceId,
  });

  assert.equal(found?.thread, null);
  assert.equal(found?.messageId, null);
  assert.equal(found?.references.length, 1);
});

test("a source that is not a note has no origin, and a note without a record has none", async () => {
  await assert.rejects(
    origin.getNoteOrigin({ workspaceId, userId, sourceId: citedSourceId }),
    /not a note/,
  );

  const result = await save();
  await schema.db
    .delete(schema.notes)
    .where(eq(schema.notes.id, result.noteId));
  assert.equal(
    await origin.getNoteOrigin({
      workspaceId,
      userId,
      sourceId: result.sourceId,
    }),
    null,
  );
});

async function editInput(
  sourceId: string,
  contentText: string,
  expected?: string,
) {
  const source = await sourceRow(sourceId);
  return {
    workspaceId,
    userId,
    sourceId,
    contentText,
    expectedUpdatedAt: expected ?? source!.updatedAt.toISOString(),
  };
}

test("editing replaces the text, re-indexes it under its own key and moves the hash", async () => {
  const result = await save();
  const before = await sourceRow(result.sourceId);
  state.indexSource.mockClear();

  const done = await edit.updateNoteContent(
    await editInput(result.sourceId, "A rewritten note."),
  );

  const after = await sourceRow(result.sourceId);
  assert.equal(after?.contentText, "A rewritten note.");
  assert.notEqual(after?.contentHash, before?.contentHash);
  assert.equal(state.indexSource.mock.calls.length, 1);
  const call = state.indexSource.mock.calls[0]![0];
  assert.equal(call.userId, userId);
  assert.ok(
    String(call.idempotencyKey).startsWith(`note-edit:${result.sourceId}:`),
  );
  assert.equal(
    (await noteRow(result.noteId))?.contentText,
    "A rewritten note.",
  );
  assert.equal(
    done.updatedAt,
    (await sourceRow(result.sourceId))!.updatedAt.toISOString(),
  );
});

test("after an edit the origin reports when it was edited and keeps the saved references", async () => {
  const result = await save();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await edit.updateNoteContent(
    await editInput(result.sourceId, "A rewritten note."),
  );

  const found = await origin.getNoteOrigin({
    workspaceId,
    userId,
    sourceId: result.sourceId,
  });

  assert.ok(found?.editedAt);
  assert.equal(
    found?.references[0]?.passage,
    "Revenue grew 23% to $4.1 billion.",
  );
});

test("an edit started from an older version is refused", async () => {
  const result = await save();
  await edit.updateNoteContent(await editInput(result.sourceId, "First edit."));

  await assert.rejects(
    edit.updateNoteContent(
      await editInput(
        result.sourceId,
        "Second edit.",
        "2000-01-01T00:00:00.000Z",
      ),
    ),
    /changed by someone else/,
  );
  assert.equal((await sourceRow(result.sourceId))?.contentText, "First edit.");
});

test("saving the same text again does nothing, and a source that is not a note is refused", async () => {
  const result = await save();
  const original = (await sourceRow(result.sourceId))!;
  await schema.db
    .update(schema.sources)
    .set({ status: "indexed" })
    .where(eq(schema.sources.id, result.sourceId));
  state.indexSource.mockClear();
  const current = (await sourceRow(result.sourceId))!;

  await edit.updateNoteContent({
    workspaceId,
    userId,
    sourceId: result.sourceId,
    contentText: original.contentText,
    expectedUpdatedAt: current.updatedAt.toISOString(),
  });
  assert.equal(state.indexSource.mock.calls.length, 0);

  await assert.rejects(
    edit.updateNoteContent(await editInput(citedSourceId, "x")),
    /not a note/,
  );
});

test("when indexing fails the new text is kept and the error is raised", async () => {
  const result = await save();
  state.indexSource.mockRejectedValueOnce(new Error("embedding down"));

  await assert.rejects(
    edit.updateNoteContent(await editInput(result.sourceId, "Kept text.")),
    /embedding down/,
  );

  assert.equal((await sourceRow(result.sourceId))?.contentText, "Kept text.");
});

test("a guide made before an edit reads as stale afterwards", async () => {
  const result = await save();
  const before = (await sourceRow(result.sourceId))!;
  await schema.db.insert(schema.sourceGuides).values({
    id: randomUUID(),
    teamId,
    workspaceId,
    sourceId: result.sourceId,
    status: "ready",
    trigger: "manual",
    contentHash: before.contentHash,
    contentJson: { summary: "S", topics: [], suggestedQuestions: ["Q?"] },
  });
  await edit.updateNoteContent(
    await editInput(result.sourceId, "A rewritten note."),
  );

  const { toSourceGuide } = await import("../sources/guide-repository");
  const [guide] = await schema.db
    .select()
    .from(schema.sourceGuides)
    .where(eq(schema.sourceGuides.sourceId, result.sourceId));
  const after = (await sourceRow(result.sourceId))!;

  assert.equal(toSourceGuide(guide!, after.contentHash).stale, true);
});

test("saved messages are reported, unsaved ones are not", async () => {
  const result = await save();
  const otherMessageId = randomUUID();

  const found = await saved.listSavedNotes({
    workspaceId,
    userId,
    messageIds: [messageId, otherMessageId],
  });

  assert.deepEqual(Object.keys(found.notes), [messageId]);
  assert.equal(found.notes[messageId]?.sourceId, result.sourceId);
  assert.equal(found.notes[messageId]?.noteId, result.noteId);
});

test("a message saved from a conversation the viewer cannot read is not reported", async () => {
  await save();
  await schema.db
    .update(schema.threads)
    .set({ createdBy: "someone-else", visibility: "private" })
    .where(eq(schema.threads.id, threadId));

  const found = await saved.listSavedNotes({
    workspaceId,
    userId,
    messageIds: [messageId],
  });

  assert.deepEqual(found.notes, {});
});
