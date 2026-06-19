import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ArtifactPublishError,
  PublishArtifactErrorOutputSchema,
  PublishArtifactInputSchema,
  PublishArtifactOutputSchema,
  PptxOutputError,
} from "../src/schemas";

function previewImage() {
  return {
    source: {
      kind: "sandbox_path" as const,
      path: "/workspace/qa/preview.jpg",
    },
  };
}

test("PublishArtifactInputSchema accepts sandbox pptx sources with preview image", () => {
  assert.deepEqual(
    PublishArtifactInputSchema.parse({
      artifactType: "slides",
      title: "Quarterly Plan",
      source: {
        kind: "sandbox_path",
        path: "/workspace/presentations/quarterly-plan.pptx",
      },
      previewImage: previewImage(),
    }),
    {
      artifactType: "slides",
      title: "Quarterly Plan",
      source: {
        kind: "sandbox_path",
        path: "/workspace/presentations/quarterly-plan.pptx",
      },
      previewImage: previewImage(),
    },
  );
});

test("PublishArtifactInputSchema rejects slides without preview image", () => {
  assert.throws(
    () =>
      PublishArtifactInputSchema.parse({
        artifactType: "slides",
        title: "Quarterly Plan",
        source: {
          kind: "sandbox_path",
          path: "/workspace/quarterly-plan.pptx",
        },
      }),
    /is required for slides artifacts; use PREVIEW_IMAGE_PATH/u,
  );
});

test("PublishArtifactInputSchema accepts slides sandbox pptx preview contract", () => {
  assert.deepEqual(
    PublishArtifactInputSchema.parse({
      artifactType: "slides",
      title: "Quarterly Plan",
      source: {
        kind: "sandbox_path",
        path: "/workspace/quarterly-plan.pptx",
      },
      previewImage: previewImage(),
    }),
    {
      artifactType: "slides",
      title: "Quarterly Plan",
      source: {
        kind: "sandbox_path",
        path: "/workspace/quarterly-plan.pptx",
      },
      previewImage: previewImage(),
    },
  );
});

test("PublishArtifactInputSchema accepts slides preview image sources", () => {
  const parsed = PublishArtifactInputSchema.parse({
    artifactType: "slides",
    title: "Quarterly Plan",
    source: {
      kind: "sandbox_path",
      path: "/workspace/quarterly-plan.pptx",
    },
    previewImage: {
      source: {
        kind: "sandbox_path",
        path: "/workspace/qa/slide-1.jpg",
      },
      altText: "First slide",
    },
  });

  assert.equal(parsed.previewImage?.source.kind, "sandbox_path");
  assert.equal(parsed.previewImage?.source.path, "/workspace/qa/slide-1.jpg");
  assert.equal(parsed.previewImage?.altText, "First slide");
});

test("PublishArtifactInputSchema rejects preview images for file artifacts", () => {
  assert.throws(
    () =>
      PublishArtifactInputSchema.parse({
        artifactType: "file",
        title: "Archive",
        source: {
          kind: "sandbox_path",
          path: "/workspace/archive.zip",
        },
        previewImage: {
          source: {
            kind: "sandbox_path",
            path: "/workspace/qa/slide-1.jpg",
          },
        },
      }),
    /previewImage is only supported for slides artifacts/u,
  );
});

test("PublishArtifactInputSchema accepts file artifact types for handler dispatch", () => {
  const parsed = PublishArtifactInputSchema.parse({
    artifactType: "file",
    title: "Reference",
    source: {
      kind: "work_file",
      path: "/workfiles/reference.pdf",
    },
  });

  assert.equal(parsed.artifactType, "file");
  assert.equal(parsed.source.kind, "work_file");
});

test("PublishArtifactInputSchema rejects unsupported public artifact types", () => {
  assert.throws(
    () =>
      PublishArtifactInputSchema.parse({
        artifactType: "pdf",
        title: "Reference",
        source: {
          kind: "work_file",
          path: "/workfiles/reference.pdf",
        },
      }),
    /Invalid option/u,
  );
});

test("PublishArtifactOutputSchema requires a slides artifact URL", () => {
  const parsed = PublishArtifactOutputSchema.parse({
    ok: true,
    type: "presentation_artifact_result",
    status: "ready",
    artifactId: "artifact-1",
    artifact_id: "artifact-1",
    artifactType: "slides",
    title: "Quarterly Plan",
    artifactUrl: "/content/artifacts/artifact-1",
    artifact_url: "/content/artifacts/artifact-1",
    pptx_url: "/content/artifacts/artifact-1",
    previewImageUrl:
      "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
    preview_image_url:
      "/api/artifact-file?artifactId=artifact-1&workspaceId=workspace-1&asset=previewImage",
    byteLength: 42,
    byte_length: 42,
    editable: true,
    fileName: "quarterly-plan.pptx",
    file_name: "quarterly-plan.pptx",
    generation_mode: "editable_native",
    qaWarnings: [],
  });

  assert.equal(parsed.artifactType, "slides");
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.pptx_url, "/content/artifacts/artifact-1");
  assert.equal(parsed.preview_image_url, parsed.previewImageUrl);
});

test("PublishArtifactOutputSchema accepts a generic file artifact URL", () => {
  const parsed = PublishArtifactOutputSchema.parse({
    ok: true,
    type: "file_artifact_result",
    status: "ready",
    artifactId: "artifact-1",
    artifact_id: "artifact-1",
    artifactType: "file",
    title: "Archive",
    artifactUrl: "/artifact-preview?artifactId=artifact-1",
    artifact_url: "/artifact-preview?artifactId=artifact-1",
    downloadUrl: "/api/artifact-file?artifactId=artifact-1&download=1",
    download_url: "/api/artifact-file?artifactId=artifact-1&download=1",
    byteLength: 42,
    byte_length: 42,
    fileName: "archive.zip",
    file_name: "archive.zip",
    mimeType: "application/zip",
    mime_type: "application/zip",
  });

  assert.equal(parsed.artifactType, "file");
  assert.equal(parsed.download_url, parsed.downloadUrl);
});

test("PublishArtifactErrorOutputSchema accepts recoverable publisher failures", () => {
  const parsed = PublishArtifactErrorOutputSchema.parse({
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "PPTX_OUTPUT_NOT_FOUND",
    message: "sandbox file was not found",
    recoverable: true,
  });

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "PPTX_OUTPUT_NOT_FOUND");
  assert.equal(parsed.recoverable, true);
});

test("PublishArtifactErrorOutputSchema accepts recoverable invalid input failures", () => {
  const parsed = PublishArtifactErrorOutputSchema.parse({
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "PUBLISH_INPUT_INVALID",
    message: "source.kind is required",
    recoverable: true,
  });

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "PUBLISH_INPUT_INVALID");
  assert.equal(parsed.recoverable, true);
});

test("PublishArtifactErrorOutputSchema accepts recoverable unsupported type failures", () => {
  const parsed = PublishArtifactErrorOutputSchema.parse({
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "ARTIFACT_TYPE_UNSUPPORTED",
    message: "artifactType is not supported: pdf",
    recoverable: true,
  });

  assert.equal(parsed.code, "ARTIFACT_TYPE_UNSUPPORTED");
});

test("PptxOutputError exposes stable error codes", () => {
  const error = new PptxOutputError("PPTX_SOURCE_UNSUPPORTED", "use sandbox");

  assert.equal(error.code, "PPTX_SOURCE_UNSUPPORTED");
  assert.match(error.message, /use sandbox/);
});

test("ArtifactPublishError remains compatible with legacy PptxOutputError checks", () => {
  const error = new ArtifactPublishError(
    "ARTIFACT_SOURCE_NOT_FOUND",
    "missing",
  );

  assert.ok(error instanceof PptxOutputError);
  assert.equal(error.code, "ARTIFACT_SOURCE_NOT_FOUND");
});
