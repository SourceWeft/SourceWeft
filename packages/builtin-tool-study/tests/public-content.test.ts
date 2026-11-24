import assert from "node:assert/strict";
import { test } from "node:test";
import { createArtifactViewHandlers } from "../src/index";
import {
  flashcardsFixtureEn,
  mindmapFixtureEn,
  quizFixtureEn,
} from "../src/testing/fixtures";
import { parsePublicStudyContent } from "../src/ui/shared/public-content";
import type { MindmapNode, StudyContent } from "@sourceweft/contracts/study";

function allEvidence(content: StudyContent) {
  if (content.kind !== "mindmap") {
    return content.items.flatMap((item) => item.evidence);
  }
  const nodes: MindmapNode[] = [];
  const walk = (node: MindmapNode) => {
    nodes.push(node);
    node.children.forEach(walk);
  };
  walk(content.root);
  return nodes.flatMap((node) => node.evidence);
}

async function publicPayload(artifactType: string, payloadJson: unknown) {
  const handlers = await createArtifactViewHandlers();
  const handler = handlers.find((candidate) => candidate.artifactType === artifactType)!;
  return handler.buildPublicPayload!({
    artifact: {
      artifactType,
      status: "ready",
      title: "Photosynthesis",
      storageBucket: null,
      storageKey: null,
      payloadJson,
    },
    assetUrl: (fileName) => fileName,
  });
}

for (const [artifactType, fixture] of [
  ["flashcards", flashcardsFixtureEn],
  ["quiz", quizFixtureEn],
  ["mindmap", mindmapFixtureEn],
] as const) {
  test(`the share viewer opens the stripped public ${artifactType} payload with no evidence to show`, async () => {
    const payload = await publicPayload(artifactType, fixture);
    const content = parsePublicStudyContent(artifactType, payload);
    assert.ok(content, "the stripped payload parses");
    assert.equal(content.kind, artifactType);
    assert.deepEqual(allEvidence(content), []);
  });

  test(`a ${artifactType} payload that still carries quotes shows none of them on the share page`, () => {
    const content = parsePublicStudyContent(artifactType, fixture);
    assert.ok(content);
    assert.deepEqual(allEvidence(content), []);
    assert.ok(!JSON.stringify(content).includes('"quote"'));
  });
}

test("content of another type or no content at all does not parse", () => {
  assert.equal(parsePublicStudyContent("quiz", flashcardsFixtureEn), null);
  assert.equal(parsePublicStudyContent("quiz", { nope: 1 }), null);
  assert.equal(parsePublicStudyContent("quiz", null), null);
});
