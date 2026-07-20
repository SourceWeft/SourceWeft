import assert from "node:assert/strict";
import { test } from "vitest";
import type { ArtifactViewRecord } from "@sourceweft/contracts";
import {
  createArtifactViewHandlers,
  slidesArtifactViewHandler,
} from "../src/artifact-view";

function slidesArtifact(
  overrides: Partial<ArtifactViewRecord> = {},
): ArtifactViewRecord {
  return {
    artifactType: "slides",
    status: "ready",
    title: null,
    storageBucket: "content",
    storageKey: "workspaces/w1/artifacts/a1/deck.pptx",
    payloadJson: {},
    ...overrides,
  };
}

test("the capability registers a slides view handler", async () => {
  const handlers = await createArtifactViewHandlers();
  assert.deepEqual(
    handlers.map((handler) => handler.artifactType),
    ["slides"],
  );
});

test("slides downloads use the artifact title over a legacy payload file name", () => {
  assert.equal(
    slidesArtifactViewHandler.resolveFileName?.({
      artifact: slidesArtifact({
        title: "费曼学习法：用教别人的方式真正学会",
        payloadJson: { fileName: "generated-pptx.pptx" },
      }),
    }),
    "费曼学习法-用教别人的方式真正学会.pptx",
  );
});

test("a titleless slides artifact defers to the host's generic naming", () => {
  assert.equal(
    slidesArtifactViewHandler.resolveFileName?.({
      artifact: slidesArtifact({ payloadJson: { fileName: "deck.pptx" } }),
    }),
    null,
  );
});

test("slides are inline-previewable regardless of MIME type", () => {
  assert.equal(
    slidesArtifactViewHandler.canPreviewInline?.({
      artifact: slidesArtifact(),
      contentType: "application/octet-stream",
    }),
    true,
  );
});

test("only a visual HTML deck advertises the visual deck renderer", () => {
  assert.equal(
    slidesArtifactViewHandler.resolveRenderer?.({
      artifact: slidesArtifact({
        payloadJson: { generationMode: "visual_html", fileName: "deck.html" },
      }),
    }),
    "visual_html_deck",
  );
  assert.equal(
    slidesArtifactViewHandler.resolveRenderer?.({
      artifact: slidesArtifact({
        payloadJson: { generationMode: "editable_native" },
      }),
    }),
    null,
  );
});

test("a visual HTML deck keeps its payload file name", () => {
  assert.equal(
    slidesArtifactViewHandler.resolveFileName?.({
      artifact: slidesArtifact({
        title: "Visual Deck",
        payloadJson: { fileName: "deck.html", generationMode: "visual_html" },
      }),
    }),
    "deck.html",
  );
});
