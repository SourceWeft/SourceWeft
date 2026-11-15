import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactViewHandlers } from "../src/index";
import { flashcardsFixtureEn, quizFixtureEn } from "../src/testing/fixtures";

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
