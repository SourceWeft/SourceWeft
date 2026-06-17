import assert from "node:assert/strict";
import { test } from "vitest";
import { testExports } from "./service";

test("slides artifact downloads use artifact title over legacy payload file name", () => {
  const artifact = {
    artifactType: "slides",
    payloadJson: {
      fileName: "generated-pptx.pptx",
    },
    title: "费曼学习法：用教别人的方式真正学会",
  };

  assert.equal(
    testExports.resolveArtifactFileName(artifact as never),
    "费曼学习法-用教别人的方式真正学会.pptx",
  );
});

test("visual HTML slides artifact keeps HTML payload file name", () => {
  const artifact = {
    artifactType: "slides",
    payloadJson: {
      fileName: "deck.html",
      generationMode: "visual_html",
    },
    title: "Visual Deck",
  };

  assert.equal(
    testExports.resolveArtifactFileName(artifact as never),
    "deck.html",
  );
});

test("visual HTML slides artifact advertises visual deck renderer", () => {
  assert.equal(
    testExports.resolveArtifactRenderer({
      artifactType: "slides",
      payloadJson: {
        generationMode: "visual_html",
      },
    } as never),
    "visual_html_deck",
  );
  assert.equal(
    testExports.resolveArtifactRenderer({
      artifactType: "slides",
      payloadJson: {
        generationMode: "editable_native",
      },
    } as never),
    null,
  );
  assert.equal(
    testExports.resolveArtifactRenderer({
      artifactType: "image",
      payloadJson: {
        generationMode: "visual_html",
      },
    } as never),
    null,
  );
});

test("non-slides artifact downloads keep payload file name", () => {
  const artifact = {
    artifactType: "image",
    payloadJson: {
      fileName: "generated-image.png",
    },
    title: "Title",
  };

  assert.equal(
    testExports.resolveArtifactFileName(artifact as never),
    "generated-image.png",
  );
});

test("artifact capabilities distinguish files from image artifacts", () => {
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "image",
      status: "ready",
      storageKey: "workspace/artifact/image.png",
    } as never),
    {
      canOpenFile: true,
      canDownloadFile: true,
      canPreviewInline: true,
    },
  );
  assert.deepEqual(
    testExports.buildArtifactCapabilities({
      artifactType: "image",
      status: "pending",
      storageKey: null,
    } as never),
    {
      canOpenFile: false,
      canDownloadFile: false,
      canPreviewInline: false,
    },
  );
});
