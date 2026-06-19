import assert from "node:assert/strict";
import { test } from "vitest";
import { handlerForArtifactType } from "../src/artifact-type-handlers";
import { PptxOutputError } from "../src/schemas";

function validPptxBuffer() {
  return Buffer.from(
    "PK\u0003\u0004 [Content_Types].xml ppt/presentation.xml ppt/slides/slide1.xml",
    "latin1",
  );
}

test("slides type handler validates PPTX package and preserves frontend output protocol", () => {
  const handler = handlerForArtifactType("slides");
  assert.ok(handler);

  const prepared = handler.prepare({
    publishInput: {
      artifactType: "slides",
      title: "Clean Deck",
      source: {
        kind: "sandbox_path",
        path: "/workspace/clean-deck.pptx",
      },
    },
    source: {
      bytes: validPptxBuffer(),
      path: "/workspace/clean-deck.pptx",
      source: {
        kind: "sandbox_path",
        path: "/workspace/clean-deck.pptx",
      },
    },
  });

  const output = prepared.toOutput({
    artifactId: "artifact-1",
    artifactUrl: "/artifact-preview?artifactId=artifact-1",
    downloadUrl: "/api/artifact-file?artifactId=artifact-1&download=1",
    title: "Clean Deck",
  });

  assert.equal(prepared.artifactType, "slides");
  assert.equal(
    prepared.contentType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  assert.equal(output.type, "presentation_artifact_result");
  assert.equal(output.artifact_url, output.artifactUrl);
  assert.equal(output.pptx_url, output.artifactUrl);
  assert.equal(output.generation_mode, "editable_native");
});

test("slides type handler rejects non-pptx extensions", () => {
  const handler = handlerForArtifactType("slides");
  assert.ok(handler);

  assert.throws(
    () =>
      handler.prepare({
        publishInput: {
          artifactType: "slides",
          title: "PDF",
          source: {
            kind: "sandbox_path",
            path: "/workspace/deck.pdf",
          },
        },
        source: {
          bytes: validPptxBuffer(),
          path: "/workspace/deck.pdf",
          source: {
            kind: "sandbox_path",
            path: "/workspace/deck.pdf",
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "PPTX_OUTPUT_INVALID_EXTENSION",
  );
});

test("file type handler accepts arbitrary non-empty files", () => {
  const handler = handlerForArtifactType("file");
  assert.ok(handler);

  const prepared = handler.prepare({
    publishInput: {
      artifactType: "file",
      title: "Data Export",
      source: {
        kind: "sandbox_path",
        path: "/workspace/output/report.xlsx",
      },
    },
    source: {
      bytes: Buffer.from("xlsx-bytes"),
      path: "/workspace/output/report.xlsx",
      source: {
        kind: "sandbox_path",
        path: "/workspace/output/report.xlsx",
      },
    },
  });

  const output = prepared.toOutput({
    artifactId: "artifact-1",
    artifactUrl: "/artifact-preview?artifactId=artifact-1",
    downloadUrl: "/api/artifact-file?artifactId=artifact-1&download=1",
    title: "Data Export",
  });

  assert.equal(prepared.artifactType, "file");
  assert.equal(
    prepared.contentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(output.type, "file_artifact_result");
  assert.equal(output.file_name, "report.xlsx");
  assert.equal(output.download_url, output.downloadUrl);
});

test("file type handler infers common artifact MIME types", () => {
  const handler = handlerForArtifactType("file");
  assert.ok(handler);

  const cases = [
    ["/workspace/output/deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["/workspace/output/report.pdf", "application/pdf"],
    ["/workspace/output/archive.zip", "application/zip"],
    ["/workspace/output/report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["/workspace/output/table.csv", "text/csv"],
  ] as const;

  for (const [path, expectedContentType] of cases) {
    const prepared = handler.prepare({
      publishInput: {
        artifactType: "file",
        title: "Artifact",
        source: {
          kind: "sandbox_path",
          path,
        },
      },
      source: {
        bytes: Buffer.from("bytes"),
        path,
        source: {
          kind: "sandbox_path",
          path,
        },
      },
    });

    assert.equal(prepared.contentType, expectedContentType);
  }
});

test("file type handler does not validate PPTX package structure", () => {
  const handler = handlerForArtifactType("file");
  assert.ok(handler);

  const prepared = handler.prepare({
    publishInput: {
      artifactType: "file",
      title: "Downloadable Deck",
      source: {
        kind: "sandbox_path",
        path: "/workspace/output/deck.pptx",
      },
    },
    source: {
      bytes: Buffer.from("not a pptx package"),
      path: "/workspace/output/deck.pptx",
      source: {
        kind: "sandbox_path",
        path: "/workspace/output/deck.pptx",
      },
    },
  });

  assert.equal(prepared.artifactType, "file");
  assert.equal(prepared.fileName, "deck.pptx");
  assert.equal(
    prepared.contentType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
});

test("file type handler rejects empty files", () => {
  const handler = handlerForArtifactType("file");
  assert.ok(handler);

  assert.throws(
    () =>
      handler.prepare({
        publishInput: {
          artifactType: "file",
          title: "Empty",
          source: {
            kind: "sandbox_path",
            path: "/workspace/empty.zip",
          },
        },
        source: {
          bytes: Buffer.alloc(0),
          path: "/workspace/empty.zip",
          source: {
            kind: "sandbox_path",
            path: "/workspace/empty.zip",
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_FILE_EMPTY",
  );
});

test("file type handler rejects oversized files", () => {
  const handler = handlerForArtifactType("file");
  assert.ok(handler);

  assert.throws(
    () =>
      handler.prepare({
        publishInput: {
          artifactType: "file",
          title: "Huge",
          source: {
            kind: "sandbox_path",
            path: "/workspace/huge.zip",
          },
        },
        source: {
          bytes: { byteLength: 100 * 1024 * 1024 + 1 } as Buffer,
          path: "/workspace/huge.zip",
          source: {
            kind: "sandbox_path",
            path: "/workspace/huge.zip",
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_FILE_TOO_LARGE",
  );
});

test("image type handler accepts generated image bytes", () => {
  const handler = handlerForArtifactType("image");
  assert.ok(handler);

  const prepared = handler.prepare({
    publishInput: {
      artifactType: "image",
      title: "Generated Image",
      source: {
        kind: "generated_image",
        tool: "generate_image",
      },
    },
    source: {
      bytes: Buffer.from("png-bytes"),
      mimeType: "image/png",
      path: "generated-image.png",
      payload: {
        prompt: "Generate a launch image",
      },
    },
  });

  const output = prepared.toOutput({
    artifactId: "artifact-1",
    artifactUrl: "/artifact-preview?artifactId=artifact-1",
    downloadUrl: "/api/artifact-file?artifactId=artifact-1&download=1",
    title: "Generated Image",
  });

  assert.equal(prepared.artifactType, "image");
  assert.equal(prepared.contentType, "image/png");
  assert.equal(output.type, "generated_image");
  assert.equal(output.artifactType, "image");
  assert.equal(output.artifact_url, output.artifactUrl);
});

test("handler registry returns null for unsupported artifact types", () => {
  assert.equal(handlerForArtifactType("pdf"), null);
});
