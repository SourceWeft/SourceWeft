import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactViewHandlers } from "../src/index";
import {
  flashcardsFixtureEn,
  mindmapFixtureEn,
  quizFixtureEn,
} from "../src/testing/fixtures";

function record(artifactType: string, payloadJson: unknown) {
  return {
    artifactType,
    status: "ready",
    title: "Photosynthesis",
    storageBucket: null,
    storageKey: null,
    payloadJson,
  };
}

test("the package takes over the three study artifact types", async () => {
  const handlers = await createArtifactViewHandlers();
  assert.deepEqual(
    handlers.map((handler) => handler.artifactType).sort(),
    ["flashcards", "mindmap", "quiz"],
  );
});

test("study artifacts own no storage objects, so deleting one leaves nothing behind", async () => {
  const handlers = await createArtifactViewHandlers();
  for (const handler of handlers) {
    assert.ok(handler.listOwnedStorageObjects, handler.artifactType);
    assert.deepEqual(
      handler.listOwnedStorageObjects({
        artifact: record(handler.artifactType, flashcardsFixtureEn),
      }),
      [],
    );
    assert.equal(handler.resolveVersionMedia, undefined);
    assert.equal(handler.resolveAsset, undefined);
  }
});

test("source JSON is the validated content, and only for the matching type", async () => {
  const handlers = await createArtifactViewHandlers();
  const quiz = handlers.find((handler) => handler.artifactType === "quiz")!;
  const built = quiz.buildSourceJson?.({ artifact: record("quiz", quizFixtureEn) });
  assert.deepEqual(built?.payload, quizFixtureEn);
  assert.equal(built?.fileName, "Photosynthesis.quiz.json");
  assert.equal(
    quiz.buildSourceJson?.({ artifact: record("quiz", flashcardsFixtureEn) }),
    null,
  );
  assert.equal(quiz.buildSourceJson?.({ artifact: record("quiz", { nope: 1 }) }), null);
});

/* ------------------------------------------------------------ public share */

/** Every quote, offset pair and heading path stored anywhere in `value`. */
function sourceText(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "quote" || key === "headingPath") found.push(String(child));
      walk(child);
    }
  };
  walk(value);
  return found;
}

for (const [artifactType, fixture] of [
  ["flashcards", flashcardsFixtureEn],
  ["quiz", quizFixtureEn],
  ["mindmap", mindmapFixtureEn],
] as const) {
  test(`the public payload of ${artifactType} has no evidence quote, offsets or chunk ids`, async () => {
    const handlers = await createArtifactViewHandlers();
    const handler = handlers.find((candidate) => candidate.artifactType === artifactType)!;
    assert.ok(handler.buildPublicPayload, `${artifactType} offers a public payload`);
    const quotes = sourceText(fixture);
    assert.ok(quotes.length > 0, "the fixture carries quotes to strip");
    const payload = handler.buildPublicPayload({
      artifact: record(artifactType, fixture),
      assetUrl: (fileName) => `/public/${fileName}`,
    });
    assert.ok(payload);
    const serialized = JSON.stringify(payload);
    for (const field of ["quote", "startChar", "endChar", "quoteHash", "headingPath", "chunkId", "chunkNo"]) {
      assert.doesNotMatch(serialized, new RegExp(`"${field}"`), field);
    }
    for (const quote of quotes) {
      assert.ok(!serialized.includes(quote), `"${quote}" left in the public payload`);
    }
    // Where an item was cited from survives.
    assert.match(serialized, /"sourceId":"source-1"/);
    assert.equal(payload.kind, artifactType);
  });
}

test("the public payload keeps the generated study content", async () => {
  const handlers = await createArtifactViewHandlers();
  const flashcards = handlers.find((handler) => handler.artifactType === "flashcards")!;
  const payload = flashcards.buildPublicPayload?.({
    artifact: record("flashcards", flashcardsFixtureEn),
    assetUrl: (fileName) => fileName,
  }) as typeof flashcardsFixtureEn;
  assert.deepEqual(
    payload.items.map(({ front, back }) => ({ front, back })),
    flashcardsFixtureEn.items.map(({ front, back }) => ({ front, back })),
  );
  const mindmap = handlers.find((handler) => handler.artifactType === "mindmap")!;
  const map = mindmap.buildPublicPayload?.({
    artifact: record("mindmap", mindmapFixtureEn),
    assetUrl: (fileName) => fileName,
  }) as typeof mindmapFixtureEn;
  assert.equal(map.root.label, mindmapFixtureEn.root.label);
  assert.deepEqual(
    map.root.children.map((child) => child.label),
    mindmapFixtureEn.root.children.map((child) => child.label),
  );
});

test("there is no public payload for invalid or mismatched study content", async () => {
  const handlers = await createArtifactViewHandlers();
  const quiz = handlers.find((handler) => handler.artifactType === "quiz")!;
  const build = (payloadJson: unknown) =>
    quiz.buildPublicPayload?.({
      artifact: record("quiz", payloadJson),
      assetUrl: (fileName) => fileName,
    });
  assert.equal(build(flashcardsFixtureEn), null);
  assert.equal(build({ nope: 1 }), null);
});
