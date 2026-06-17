import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  createCapabilityAgentTools,
  publishSandboxArtifactFromSandbox,
  PptxOutputError,
} from "../src";

function validPptxBuffer() {
  return Buffer.from(
    "PK\u0003\u0004 [Content_Types].xml ppt/presentation.xml ppt/slides/slide1.xml",
    "latin1",
  );
}

function services(input?: { download?: () => Promise<Buffer> }) {
  return {
    artifacts: {
      createSlidesArtifactRecord: vi.fn().mockResolvedValue({
        artifactId: "artifact-1",
        versionId: "version-1",
      }),
    },
    sandbox: {
      downloadCurrentFile:
        input?.download ?? vi.fn().mockResolvedValue(validPptxBuffer()),
    },
    storage: {
      buildArtifactStorageKey: vi
        .fn()
        .mockReturnValue("artifacts/workspace-1/artifact-1/deck.pptx"),
      getContentStorageBucketName: vi.fn().mockReturnValue("content"),
      uploadArtifactObject: vi.fn().mockResolvedValue(undefined),
    },
  };
}

const context = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "user-1",
};

test("createCapabilityAgentTools does not bind publisher without sandbox download service", () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_sandbox_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_sandbox_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: {
      artifacts: services().artifacts,
      storage: services().storage,
    },
  });

  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.promptProviders, []);
});

test("publish_sandbox_artifact tool returns recoverable error for missing sandbox files", async () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_sandbox_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_sandbox_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: services({
      download: vi.fn().mockRejectedValue(new Error("No such file")),
    }),
  });
  const publisher = result.tools[0]?.tool;
  assert.ok(publisher);

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "Missing",
        source: {
          kind: "sandbox_path",
          path: "/workspace/missing.pptx",
        },
      }),
    ),
  );

  assert.deepEqual(output, {
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "PPTX_OUTPUT_NOT_FOUND",
    message: "sandbox download failed for /workspace/missing.pptx: No such file",
    recoverable: true,
  });
});

test("publish_sandbox_artifact tool returns recoverable error for invalid PPTX files", async () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_sandbox_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_sandbox_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: services({
      download: vi.fn().mockResolvedValue(Buffer.from("not a pptx")),
    }),
  });
  const publisher = result.tools[0]?.tool;
  assert.ok(publisher);

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "Invalid",
        source: {
          kind: "sandbox_path",
          path: "/workspace/invalid.pptx",
        },
      }),
    ),
  );

  assert.deepEqual(output, {
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "PPTX_PACKAGE_INVALID",
    message: "file is not a valid ZIP archive (missing PK magic bytes)",
    recoverable: true,
  });
});

test("publish_sandbox_artifact tool returns recoverable error for non-pptx paths", async () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_sandbox_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_sandbox_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: services(),
  });
  const publisher = result.tools[0]?.tool;
  assert.ok(publisher);

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "PDF",
        source: {
          kind: "sandbox_path",
          path: "/workspace/deck.pdf",
        },
      }),
    ),
  );

  assert.equal(output.ok, false);
  assert.equal(output.code, "PPTX_OUTPUT_INVALID_EXTENSION");
  assert.equal(output.recoverable, true);
});

test("publishSandboxArtifactFromSandbox stores slides artifact records", async () => {
  const mockedServices = services();

  const output = await publishSandboxArtifactFromSandbox({
    context,
    services: mockedServices,
    input: {
      artifactType: "slides",
      title: "Feynman Method",
      description: "Learning deck",
      source: {
        kind: "sandbox_path",
        path: "/workspace/Presentation.pptx",
      },
      qa: {
        contentChecked: true,
        visualChecked: false,
        warnings: [],
      },
    },
  });

  assert.equal(output.ok, true);
  assert.equal(output.type, "presentation_artifact_result");
  assert.equal(output.status, "ready");
  assert.equal(output.artifactType, "slides");
  assert.equal(output.artifact_id, output.artifactId);
  assert.equal(output.artifact_url, output.artifactUrl);
  assert.equal(output.pptx_url, output.artifactUrl);
  assert.equal(output.title, "Feynman Method");
  assert.equal(output.file_name, output.fileName);
  assert.equal(output.generation_mode, "editable_native");
  assert.equal(output.editable, true);
  assert.equal(
    mockedServices.storage.uploadArtifactObject.mock.calls.length,
    1,
  );
  assert.equal(
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls.length,
    1,
  );
  assert.equal(
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls[0]?.[0]
      .payload.source.path,
    "/workspace/Presentation.pptx",
  );
});

test("publishSandboxArtifactFromSandbox fails clearly for missing sandbox files", async () => {
  const mockedServices = services({
    download: vi.fn().mockRejectedValue(new Error("No such file")),
  });

  await assert.rejects(
    () =>
      publishSandboxArtifactFromSandbox({
        context,
        services: mockedServices,
        input: {
          artifactType: "slides",
          title: "Missing",
          source: {
            kind: "sandbox_path",
            path: "/workspace/missing.pptx",
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "PPTX_OUTPUT_NOT_FOUND" &&
      /No such file/.test(error.message),
  );
});

test("publishSandboxArtifactFromSandbox rejects non-pptx paths", async () => {
  await assert.rejects(
    () =>
      publishSandboxArtifactFromSandbox({
        context,
        services: services(),
        input: {
          artifactType: "slides",
          title: "Wrong Extension",
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

test("publishSandboxArtifactFromSandbox rejects invalid OOXML PPTX files", async () => {
  await assert.rejects(
    () =>
      publishSandboxArtifactFromSandbox({
        context,
        services: services({
          download: vi.fn().mockResolvedValue(Buffer.from("not a pptx")),
        }),
        input: {
          artifactType: "slides",
          title: "Invalid",
          source: {
            kind: "sandbox_path",
            path: "/workspace/invalid.pptx",
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError && error.code === "PPTX_PACKAGE_INVALID",
  );
});
