import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";

/**
 * Issue #472: each used citation is stored with the passage of its chunk that
 * supports the sentence it follows. Offsets index the stored chunk content,
 * markup included; unsupported citations are kept and flagged, not dropped.
 */

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
const originalDatabaseUrl = process.env.DATABASE_URL;

const userId = "anchoring-user";
let teamId: string;
let workspaceId: string;
let threadId: string;
let messageId: string;
let revenueChunkId: string;
let otherChunkId: string;
let sourceId: string;
let documentId: string;

const REVENUE_CONTENT =
  "<table><tr><th>Metric</th><th>Value</th></tr></table>\n\n" +
  "Revenue grew 23% to $4.1 billion in fiscal 2025, driven by cloud services. " +
  "Headcount stayed flat at 12,000 employees.";
const OTHER_CONTENT = "The board approved a new buyback programme.";
const EXTERNAL_CONTENT =
  "Press release. Exports rose 8% year over year in the third quarter.";

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("citation_anchor");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, threadId, messageId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  [revenueChunkId, otherChunkId, sourceId, documentId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const { db } = schema;
  await db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Citation anchoring",
    slug: `citation-anchoring-${workspaceId}`,
  });
  await db.insert(schema.threads).values({
    id: threadId,
    teamId,
    workspaceId,
    title: "Anchoring",
    createdBy: userId,
  });
  await db.insert(schema.messages).values({
    id: messageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
  });
  await db.insert(schema.sources).values({
    id: sourceId,
    teamId,
    workspaceId,
    title: "Annual report",
    status: "indexed",
  });
  await db.insert(schema.documents).values({
    id: documentId,
    teamId,
    workspaceId,
    sourceId,
    contentText: REVENUE_CONTENT,
    status: "ready",
  });
  await db.insert(schema.chunks).values([
    {
      id: revenueChunkId,
      teamId,
      workspaceId,
      sourceId,
      documentId,
      chunkNo: 0,
      content: REVENUE_CONTENT,
    },
    {
      id: otherChunkId,
      teamId,
      workspaceId,
      sourceId,
      documentId,
      chunkNo: 1,
      content: OTHER_CONTENT,
    },
  ]);
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

function records() {
  return [
    {
      citationKey: "c1",
      referenceKey: revenueChunkId,
      sourceId,
      documentId,
      chunkId: revenueChunkId,
      quoteText: "stale excerpt",
      rank: 1,
      score: 0.9,
    },
    {
      citationKey: "c2",
      referenceKey: otherChunkId,
      sourceId,
      documentId,
      chunkId: otherChunkId,
      quoteText: "The board approved a new buyback programme.",
      rank: 2,
      score: 0.5,
    },
    {
      citationKey: "c3",
      referenceKey: "external:https://example.com/release",
      sourceId: null,
      documentId: null,
      chunkId: null,
      externalUri: "https://example.com/release",
      quoteText: "Press release.",
      rank: 3,
      score: 0.4,
      content: EXTERNAL_CONTENT,
    },
  ];
}

async function persist(
  answerText: string | undefined,
  mode: "create" | "replace" = "create",
  citations = records(),
) {
  const anchors = answerText
    ? await repository.anchorAnswerCitations({
        teamId,
        workspaceId,
        threadId,
        answerText,
        citations,
      })
    : undefined;
  const write =
    mode === "create"
      ? repository.createCitationRecords
      : repository.replaceCitationRecords;
  await write({ teamId, workspaceId, threadId, messageId, anchors, citations });
}

async function rows() {
  const stored = await schema.db
    .select()
    .from(schema.citations)
    .where(eq(schema.citations.messageId, messageId));
  return new Map(stored.map((row) => [row.citationKey, row]));
}

const ANSWER =
  "Revenue grew 23% to $4.1 billion [citation:c1]. " +
  "A new office opened in Singapore [citation:c2]. " +
  "Exports rose 8% year over year [citation:c3].";

test("stores the supporting passage of each used citation", async () => {
  await persist(ANSWER, "create");

  const stored = await rows();
  const strong = stored.get("c1")!;
  assert.equal(strong.metadataJson.support, "strong");
  assert.notEqual(strong.startChar, null);
  assert.equal(
    REVENUE_CONTENT.slice(strong.startChar!, strong.endChar!),
    strong.quoteText,
  );
  assert.ok(strong.quoteText?.startsWith("Revenue grew 23%"));
  assert.ok(!strong.quoteText?.includes("<table>"));

  const external = stored.get("c3")!;
  assert.equal(external.metadataJson.support, "strong");
  assert.equal(
    EXTERNAL_CONTENT.slice(external.startChar!, external.endChar!),
    external.quoteText,
  );
  assert.ok(external.quoteText?.includes("Exports rose 8%"));
});

test("keeps a citation without supporting passage and flags it weak", async () => {
  await persist(ANSWER, "create");

  const weak = (await rows()).get("c2")!;
  assert.equal(weak.metadataJson.support, "weak");
  assert.equal(weak.startChar, null);
  assert.equal(weak.endChar, null);
  assert.equal(weak.quoteText, "The board approved a new buyback programme.");
});

test("stores no span and no support flag without the answer text", async () => {
  await persist(undefined, "create");

  const stored = await rows();
  for (const row of stored.values()) {
    assert.equal(row.startChar, null);
    assert.equal(row.metadataJson.support, undefined);
  }
  assert.equal(stored.get("c1")!.quoteText, "stale excerpt");
});

test("replacing the records after a resume re-anchors against the combined answer", async () => {
  await persist("A new office opened in Singapore [citation:c2].", "create");
  assert.equal(
    (await rows()).get("c1")?.startChar ?? null,
    null,
    "c1 is not used in the paused text",
  );

  await persist(ANSWER, "replace");

  const stored = await rows();
  assert.equal(stored.size, 3);
  assert.equal(stored.get("c1")!.metadataJson.support, "strong");
  assert.notEqual(stored.get("c1")!.startChar, null);
});

test("the citation lookup returns the stored span", async () => {
  await persist(ANSWER, "create");

  const found = await repository.findCitationByMessageRank({
    userId,
    teamId,
    workspaceId,
    messageId,
    rank: 1,
  });
  assert.ok(found);
  assert.equal(
    REVENUE_CONTENT.slice(found.startChar!, found.endChar!),
    found.quoteText,
  );
});

test("does not load chunk content from another workspace", async () => {
  const anchors = await repository.anchorAnswerCitations({
    teamId,
    workspaceId: randomUUID(),
    threadId,
    answerText: ANSWER,
    citations: records().slice(0, 1),
  });
  assert.equal(anchors.size, 0);
});
