import assert from "node:assert/strict";
import { test } from "vitest";
import { studyContentSchema, studyFingerprint } from "@sourceweft/contracts/study";
import { tableContentFixture } from "../tables/test-support";
import { loadArtifactViewHandlerRegistry } from "./view-handlers";

/**
 * The public share read path for grounded artifacts, through the real handler
 * registry the share service delegates to: what an anonymous browser receives
 * keeps the generated content and never the source text behind it.
 */

const QUOTE = "a randomised trial";

function artifact(artifactType: string, payloadJson: unknown) {
  return {
    artifactType,
    status: "ready",
    title: "Shared",
    storageBucket: null,
    storageKey: null,
    payloadJson,
  };
}

async function publicPayload(artifactType: string, payloadJson: unknown) {
  const registry = await loadArtifactViewHandlerRegistry();
  const handler = registry.handlerFor(artifactType);
  assert.ok(handler?.buildPublicPayload, `${artifactType} has a public payload`);
  return handler.buildPublicPayload({
    artifact: artifact(artifactType, payloadJson),
    assetUrl: (fileName) => `/v1/public/shares/token/assets/${fileName}`,
  });
}

function assertNoSourceText(payload: unknown) {
  const serialized = JSON.stringify(payload);
  for (const field of ["quote", "startChar", "endChar", "quoteHash", "headingPath"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${field}"`), field);
  }
  assert.ok(!serialized.includes(QUOTE), "the quote text is gone");
}

test("a shared table keeps values, column names and source titles, and no evidence text or recipe", async () => {
  const content = tableContentFixture({
    instruction: "Owner's private brief",
    sources: [
      { sourceId: "s1", documentId: "d1", contentHash: "h1", title: "Atlas trial report" },
      { sourceId: "s2", documentId: "d2", contentHash: "h2", title: "Beacon cohort" },
    ],
  });
  const payload = (await publicPayload("table", content)) as typeof content;
  assertNoSourceText(payload);
  const serialized = JSON.stringify(payload);
  for (const field of ["generation", "recipe", "instruction", "description"]) {
    assert.doesNotMatch(serialized, new RegExp(`"${field}"`), field);
  }
  assert.ok(!serialized.includes("private brief"));
  assert.deepEqual(
    payload.columns.map((column) => column.name),
    ["Design", "Participants"],
  );
  assert.deepEqual(
    payload.rows.map((row) => row.title),
    ["Atlas trial report", "Beacon cohort"],
  );
  const cell = Object.values(payload.rows[0]!.cells)[0]!;
  assert.equal(cell.status, "found");
  assert.equal(cell.status === "found" ? cell.value : null, "randomised");
});

test("a shared flashcard set keeps its cards and no evidence text", async () => {
  const content = studyContentSchema.parse({
    schemaVersion: 1,
    kind: "flashcards",
    language: "en",
    inputs: {
      selection: "sources",
      sources: [{ sourceId: "s1", documentId: "d1", contentHash: "h1" }],
    },
    generation: {
      promptVersion: "flashcards-v1",
      modelAlias: "chat-default",
      mode: "single",
      stats: { requested: 1, kept: 1, dropped: {}, groups: 1, tokensEstimated: 10 },
      recipe: { options: { size: "standard" }, sourceIds: ["s1"] },
    },
    items: [
      {
        id: "c_1",
        fingerprint: studyFingerprint("flashcards", "What design?"),
        front: "What design?",
        back: "Randomised",
        tags: [],
        difficulty: 1,
        evidence: [
          {
            kind: "chunk",
            sourceId: "s1",
            documentId: "d1",
            chunkId: "chk",
            headingPath: "Methods",
            quote: QUOTE,
            startChar: 0,
            endChar: QUOTE.length,
            quoteHash: `sha256:${"b".repeat(64)}`,
          },
        ],
      },
    ],
  });
  const payload = (await publicPayload("flashcards", content)) as Record<string, unknown>;
  assertNoSourceText(payload);
  assert.deepEqual(
    (payload.items as { front: string; back: string }[]).map(({ front, back }) => ({
      front,
      back,
    })),
    [{ front: "What design?", back: "Randomised" }],
  );
});
