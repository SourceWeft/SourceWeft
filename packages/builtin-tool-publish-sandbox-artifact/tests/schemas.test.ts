import assert from "node:assert/strict";
import { test } from "vitest";
import {
  PublishSandboxArtifactErrorOutputSchema,
  PublishSandboxArtifactInputSchema,
  PublishSandboxArtifactOutputSchema,
  PptxOutputError,
} from "../src/schemas";

test("PublishSandboxArtifactInputSchema accepts sandbox pptx sources", () => {
  assert.deepEqual(
    PublishSandboxArtifactInputSchema.parse({
      artifactType: "slides",
      title: "Quarterly Plan",
      source: {
        kind: "sandbox_path",
        path: "/workspace/presentations/quarterly-plan.pptx",
      },
    }),
    {
      artifactType: "slides",
      title: "Quarterly Plan",
      source: {
        kind: "sandbox_path",
        path: "/workspace/presentations/quarterly-plan.pptx",
      },
    },
  );
});

test("PublishSandboxArtifactInputSchema accepts slides sandbox pptx sources", () => {
  assert.deepEqual(
    PublishSandboxArtifactInputSchema.parse({
      artifactType: "slides",
      title: "Quarterly Plan",
      source: {
        kind: "sandbox_path",
        path: "/workspace/quarterly-plan.pptx",
      },
    }),
    {
      artifactType: "slides",
      title: "Quarterly Plan",
      source: {
        kind: "sandbox_path",
        path: "/workspace/quarterly-plan.pptx",
      },
    },
  );
});

test("PublishSandboxArtifactOutputSchema requires a slides artifact URL", () => {
  const parsed = PublishSandboxArtifactOutputSchema.parse({
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
});

test("PublishSandboxArtifactErrorOutputSchema accepts recoverable publisher failures", () => {
  const parsed = PublishSandboxArtifactErrorOutputSchema.parse({
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

test("PptxOutputError exposes stable error codes", () => {
  const error = new PptxOutputError("PPTX_SOURCE_UNSUPPORTED", "use sandbox");

  assert.equal(error.code, "PPTX_SOURCE_UNSUPPORTED");
  assert.match(error.message, /use sandbox/);
});
