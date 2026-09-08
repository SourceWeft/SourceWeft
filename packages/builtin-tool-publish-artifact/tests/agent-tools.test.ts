import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ARTIFACT_LIMITS } from "@sourceweft/contracts/artifact-files";
import {
  ArtifactError,
  ARTIFACT_WRITE_ERROR_CODES,
} from "@sourceweft/contracts/artifact-errors";
import { withAgentToolHostInvocationSignal } from "@sourceweft/contracts/agent-tools";
import { downloadPptxFromSandbox } from "../src/sandbox-output";
import {
  createCapabilityAgentTools,
  publishArtifact,
  publishArtifactFromSource,
  publishPreparedArtifact,
  type PublishArtifactInput,
  PptxOutputError,
} from "../src";
import {
  PublishArtifactErrorOutputSchema,
  PublishArtifactOutputSchema,
} from "../src/schemas";

function validPptxBuffer() {
  return Buffer.from(
    "PK\u0003\u0004 [Content_Types].xml ppt/presentation.xml ppt/slides/slide1.xml",
    "latin1",
  );
}

function services(input?: {
  download?: (input: {
    sandboxPath: string;
    signal?: AbortSignal;
  }) => Promise<Buffer>;
  filesystem?: {
    readRaw?: (path: string) => Promise<{
      data?: { content: string | Uint8Array; mimeType?: string };
      error?: string;
    }>;
    downloadFiles?: (paths: readonly string[]) => Promise<
      {
        path: string;
        content: Uint8Array | null;
        error?: string | null;
      }[]
    >;
  };
}) {
  const defaultDownload = vi.fn(
    async ({ sandboxPath }: { sandboxPath: string }) =>
      /\.(?:jpe?g|png|webp)$/iu.test(sandboxPath)
        ? Buffer.from("preview-bytes")
        : validPptxBuffer(),
  );
  // The host offers one function. The per-type mocks below are the test's own
  // view of it: `publishArtifact` routes on the artifact type in the spec, so
  // the assertions keep checking both the routing and the spec that was built.
  const createFileArtifactRecord = vi.fn().mockResolvedValue({
    artifactId: "artifact-1",
    versionId: "version-1",
    reused: false,
  });
  const createSlidesArtifactRecord = vi.fn().mockResolvedValue({
    artifactId: "artifact-1",
    versionId: "version-1",
    reused: false,
  });
  const createImageArtifactRecord = vi.fn().mockResolvedValue({
    artifactId: "artifact-1",
    versionId: "version-1",
    reused: false,
  });
  const publishArtifact = vi.fn(
    (publishInput: {
      spec: { artifactType: string } & Record<string, unknown>;
    }) => {
      const { artifactType } = publishInput.spec;
      if (artifactType === "slides") {
        return createSlidesArtifactRecord(publishInput);
      }
      if (artifactType === "file") {
        return createFileArtifactRecord(publishInput);
      }
      if (artifactType === "image") {
        return createImageArtifactRecord(publishInput);
      }
      throw new Error(`unexpected artifact type ${artifactType}`);
    },
  );
  return {
    artifacts: {
      publishArtifact,
      createFileArtifactRecord,
      createSlidesArtifactRecord,
      createImageArtifactRecord,
    },
    sandbox: {
      downloadCurrentFile: input?.download ?? defaultDownload,
    },
    ...(input?.filesystem ? { filesystem: input.filesystem } : {}),
    storage: {
      buildArtifactStorageKey: vi
        .fn()
        .mockImplementation(
          (input: { fileName: string }) =>
            `artifacts/workspace-1/artifact-1/${input.fileName}`,
        ),
      getBucketName: vi.fn().mockReturnValue("content"),
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      // Publishing only writes; the port requires a reader, and "nothing is
      // stored" is the honest answer for a fake that keeps no bytes.
      download: vi.fn().mockResolvedValue(null),
    },
  };
}

function previewImage(path = "/workspace/qa/preview.jpg") {
  return {
    source: {
      kind: "sandbox_path" as const,
      path,
    },
    altText: "First slide preview",
  };
}

function slidesInput(
  input: Omit<PublishArtifactInput, "artifactType" | "previewImage"> & {
    previewImage?: PublishArtifactInput["previewImage"];
  },
): PublishArtifactInput {
  return {
    artifactType: "slides",
    previewImage: previewImage(),
    ...input,
  };
}

const context = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "user-1",
};

function createPublisherTool(mockedServices = services()) {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: mockedServices,
  });
  const publisher = result.tools[0]?.tool;
  assert.ok(publisher);
  return publisher;
}

test("publish_artifact returns a shared writer conflict through the tool schema without making it recoverable", async () => {
  const mockedServices = services();
  const conflict = new ArtifactError({
    code: ARTIFACT_WRITE_ERROR_CODES.stateConflict,
    message: "The same artifact request is still running.",
  });
  mockedServices.artifacts.publishArtifact.mockRejectedValueOnce(conflict);
  const publisher = createPublisherTool(mockedServices);
  const output = PublishArtifactErrorOutputSchema.parse(
    JSON.parse(
      String(
        await publisher.invoke({
          artifactType: "file",
          title: "Pending export",
          source: { kind: "sandbox_path", path: "/workspace/output.txt" },
        }),
      ),
    ),
  );

  assert.deepEqual(output, {
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "ARTIFACT_STATE_CONFLICT",
    message: conflict.message,
    recoverable: false,
  });
  assert.equal(mockedServices.artifacts.publishArtifact.mock.calls.length, 1);
  assert.equal(mockedServices.storage.upload.mock.calls.length, 0);
});

test("unknown shared artifact failures still propagate instead of becoming a declared publisher error", async () => {
  const mockedServices = services();
  const unexpected = new ArtifactError({
    code: "UNDECLARED_TEST_FAILURE",
    category: "infrastructure",
    message: "Unrecognized writer failure",
  });
  mockedServices.artifacts.publishArtifact.mockRejectedValueOnce(unexpected);
  const publisher = createPublisherTool(mockedServices);
  await assert.rejects(
    publisher.invoke({
      artifactType: "file",
      title: "Export",
      source: { kind: "sandbox_path", path: "/workspace/output.txt" },
    }),
    (error) => error === unexpected,
  );
});

test.each(["slides", "file"] as const)(
  "publish_artifact %s reuse returns the winning artifact and valid reused output",
  async (artifactType) => {
    const mockedServices = services();
    mockedServices.artifacts.publishArtifact.mockResolvedValueOnce({
      artifactId: "artifact-winner",
      versionId: "version-winner",
      reused: true,
    });
    const publisher = createPublisherTool(mockedServices);
    const output = PublishArtifactOutputSchema.parse(
      JSON.parse(
        String(
          await publisher.invoke({
            artifactType,
            title: "Repeated publication",
            source: {
              kind: "sandbox_path",
              path:
                artifactType === "slides"
                  ? "/workspace/deck.pptx"
                  : "/workspace/output.txt",
            },
            ...(artifactType === "slides"
              ? { previewImage: previewImage() }
              : {}),
          }),
        ),
      ),
    );

    assert.equal(output.reused, true);
    assert.equal(output.artifactId, "artifact-winner");
    assert.equal(output.artifact_id, "artifact-winner");
    assert.match(output.artifactUrl, /artifact-winner/);
    assert.equal(output.artifact_url, output.artifactUrl);
    assert.equal(mockedServices.artifacts.publishArtifact.mock.calls.length, 1);
  },
);

test("publishPreparedArtifact preserves winner identity, version and reuse when given a losing preallocated id", async () => {
  const mockedServices = services();
  const winner = {
    artifactId: "artifact-winner",
    versionId: "version-winner",
    reused: true,
  };
  mockedServices.artifacts.publishArtifact.mockResolvedValueOnce(winner);
  const result = await publishPreparedArtifact({
    context,
    artifactId: "artifact-loser",
    requestKey: "same-logical-request",
    descriptor: { artifactType: "image", title: "Image" },
    source: {
      bytes: Buffer.from("png-bytes"),
      mimeType: "image/png",
      path: "generated-image.png",
    },
    services: mockedServices,
  });

  const output = PublishArtifactOutputSchema.parse(result.output);
  assert.equal(output.artifactType, "image");
  assert.equal(output.reused, true);
  assert.equal(output.artifactId, "artifact-winner");
  assert.equal(result.artifactId, "artifact-winner");
  assert.deepEqual(result.record, winner);
  assert.match(output.artifactUrl, /artifact-winner/);
  assert.doesNotMatch(output.artifactUrl, /artifact-loser/);
  assert.equal(
    mockedServices.artifacts.publishArtifact.mock.calls[0]?.[0].spec
      .idempotency &&
      (
        mockedServices.artifacts.publishArtifact.mock.calls[0]?.[0].spec
          .idempotency as { requestKey: string }
      ).requestKey,
    "same-logical-request",
  );
});

test("publish_artifact aborts its sandbox download and never enters the writer", async () => {
  const controller = new AbortController();
  const abortReason = new DOMException("user stopped", "AbortError");
  let downloadStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    downloadStarted = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  const mockedServices = services({
    download: async (input) => {
      observedSignal = input.signal;
      downloadStarted();
      assert.ok(input.signal);
      await new Promise<void>((resolve) =>
        input.signal!.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      throw input.signal.reason;
    },
  });
  const publisher = createPublisherTool(mockedServices);

  const invocation = publisher.invoke(
    {
      artifactType: "file",
      title: "Cancelled export",
      source: { kind: "sandbox_path", path: "/workspace/output.txt" },
    },
    withAgentToolHostInvocationSignal(
      { toolCall: { id: "publish-cancelled" } },
      controller.signal,
    ) as never,
  );
  await started;
  controller.abort(abortReason);

  await assert.rejects(invocation, (error: unknown) => error === abortReason);
  assert.equal(observedSignal, controller.signal);
  assert.equal(mockedServices.artifacts.publishArtifact.mock.calls.length, 0);
});

test("createCapabilityAgentTools does not bind publisher without a source read service", () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
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

test("createCapabilityAgentTools binds publisher with only work_file read service", () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: {
      artifacts: services().artifacts,
      filesystem: {
        readRaw: vi.fn().mockResolvedValue({
          data: {
            content: validPptxBuffer(),
            mimeType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          },
        }),
      },
      storage: services().storage,
    },
  });

  assert.equal(result.tools.length, 1);
  assert.equal(result.promptProviders.length, 1);
});

test("publisher prompt requires rendered slide visual QA before publishing", () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: services(),
  });

  const prompt = result.promptProviders
    .flatMap((provider) =>
      provider.buildLines({
        runtimeTools: { publish_artifact: { enabled: true } },
      }),
    )
    .join("\n");

  assert.match(prompt, /content QA plus visual QA/);
  assert.match(prompt, /render the actual PPTX to PDF with LibreOffice/);
  assert.match(prompt, /render slide JPG files with pdftoppm/);
  assert.match(prompt, /QA_IMAGE_COUNT/);
  assert.match(prompt, /PREVIEW_IMAGE_PATH/);
  assert.match(prompt, /`previewImage` is required/);
  assert.match(prompt, /previewImage\.source\.kind/);
  assert.match(prompt, /previewImage\.source\.path/);
  assert.match(prompt, /previewImage\.altText/);
  assert.match(prompt, /manifest file/);
  assert.match(prompt, /does not search the QA directory automatically/);
  assert.match(prompt, /rendered slide image count and visual QA result/);
});

test("publish_artifact tool publishes canonical structured slides source", async () => {
  const publisher = createPublisherTool();

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "Canonical Deck",
        source: {
          kind: "sandbox_path",
          path: "/workspace/deck.pptx",
        },
        previewImage: previewImage(),
        qa: {
          contentChecked: true,
          visualChecked: true,
          warnings: [],
        },
      }),
    ),
  );

  assert.equal(output.ok, true);
  assert.equal(output.type, "presentation_artifact_result");
  assert.equal(output.status, "ready");
  assert.equal(output.artifactType, "slides");
  assert.equal(output.artifact_url, output.artifactUrl);
  assert.equal(output.pptx_url, output.artifactUrl);
  assert.equal(output.generation_mode, "editable_native");
  assert.equal(typeof output.preview_image_url, "string");
});

test("publish_artifact tool returns recoverable error when slides omit preview image", async () => {
  const mockedServices = services();
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: mockedServices,
  });
  const publisher = result.tools[0]?.tool;
  assert.ok(publisher);

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "Missing Preview",
        source: {
          kind: "sandbox_path",
          path: "/workspace/deck.pptx",
        },
      }),
    ),
  );

  assert.deepEqual(output, {
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "PUBLISH_INPUT_INVALID",
    message:
      "previewImage is required for slides artifacts; use PREVIEW_IMAGE_PATH from final PPTX visual QA",
    recoverable: true,
  });
  assert.equal(mockedServices.storage.upload.mock.calls.length, 0);
  assert.equal(
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls.length,
    0,
  );
});

test("publish_artifact tool returns recoverable error for empty source", async () => {
  const publisher = createPublisherTool();

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "Missing source path",
        source: {},
      }),
    ),
  );

  assert.deepEqual(output, {
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "PUBLISH_INPUT_INVALID",
    message:
      "source.kind is required; source.path is required; received source: object keys: (none); sourceKind: undefined; sourcePath: undefined",
    recoverable: true,
  });
});

test("publish_artifact tool returns recoverable error for missing source", async () => {
  const publisher = createPublisherTool();

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "Missing source",
      }),
    ),
  );

  assert.equal(output.ok, false);
  assert.equal(output.code, "PUBLISH_INPUT_INVALID");
  assert.match(output.message, /^source is required/u);
  assert.match(output.message, /received source: undefined/u);
  assert.equal(output.recoverable, true);
});

test("publish_artifact tool accepts JSON-string source", async () => {
  const publisher = createPublisherTool();

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "String source shape",
        source: JSON.stringify({
          kind: "sandbox_path",
          path: "/workspace/deck.pptx",
        }),
        previewImage: previewImage(),
      }),
    ),
  );

  assert.equal(output.ok, true);
  assert.equal(output.artifactType, "slides");
});

test("publish_artifact tool accepts flat source fields", async () => {
  const publisher = createPublisherTool();

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        title: "Flat source shape",
        sourceKind: "sandbox_path",
        sourcePath: "/workspace/deck.pptx",
        previewImage: previewImage(),
      }),
    ),
  );

  assert.equal(output.ok, true);
  assert.equal(output.artifactType, "slides");
});

test("publish_artifact tool returns recoverable error for missing title", async () => {
  const publisher = createPublisherTool();

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "slides",
        source: {
          kind: "sandbox_path",
          path: "/workspace/deck.pptx",
        },
      }),
    ),
  );

  assert.equal(output.ok, false);
  assert.equal(output.code, "PUBLISH_INPUT_INVALID");
  assert.match(output.message, /^title is required/u);
  assert.match(output.message, /received source: object keys: kind,path/u);
  assert.equal(output.recoverable, true);
});

test("publish_artifact tool returns recoverable schema error for unsupported artifact type", async () => {
  const publisher = createPublisherTool();

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "pdf",
        title: "Wrong type",
        source: {
          kind: "sandbox_path",
          path: "/workspace/deck.pptx",
        },
      }),
    ),
  );

  assert.equal(output.ok, false);
  assert.equal(output.code, "PUBLISH_INPUT_INVALID");
  assert.match(output.message, /artifactType/u);
  assert.match(output.message, /Invalid option/u);
  assert.equal(output.recoverable, true);
});

test("publish_artifact tool publishes generic file artifacts", async () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: services({
      download: vi.fn().mockResolvedValue(Buffer.from("zip-bytes")),
    }),
  });
  const publisher = result.tools[0]?.tool;
  assert.ok(publisher);

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "file",
        title: "Archive",
        source: {
          kind: "sandbox_path",
          path: "/workspace/output/archive.zip",
        },
      }),
    ),
  );

  assert.equal(output.ok, true);
  assert.equal(output.type, "file_artifact_result");
  assert.equal(output.artifactType, "file");
  assert.equal(output.file_name, "archive.zip");
  assert.equal(output.mime_type, "application/zip");
  assert.equal(output.byte_length, "zip-bytes".length);
  assert.match(output.download_url, /\/api\/artifact-file\?/);
});

test("publish_artifact tool returns recoverable error when file artifacts include preview image", async () => {
  const publisher = createPublisherTool();

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "file",
        title: "Archive",
        source: {
          kind: "sandbox_path",
          path: "/workspace/output/archive.zip",
        },
        previewImage: previewImage(),
      }),
    ),
  );

  assert.equal(output.ok, false);
  assert.equal(output.code, "PUBLISH_INPUT_INVALID");
  assert.match(
    output.message,
    /previewImage is only supported for slides and html artifacts/u,
  );
  assert.equal(output.recoverable, true);
});

test("publish_artifact tool returns recoverable error for empty generic files", async () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
      teamId: "team-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      userMessageId: "message-1",
    },
    services: services({
      download: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    }),
  });
  const publisher = result.tools[0]?.tool;
  assert.ok(publisher);

  const output = JSON.parse(
    String(
      await publisher.invoke({
        artifactType: "file",
        title: "Empty",
        source: {
          kind: "sandbox_path",
          path: "/workspace/output/empty.zip",
        },
      }),
    ),
  );

  assert.equal(output.ok, false);
  assert.equal(output.code, "ARTIFACT_FILE_EMPTY");
  assert.equal(output.recoverable, true);
});

test("publish_artifact tool returns recoverable error for missing sandbox files", async () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
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
        previewImage: previewImage(),
      }),
    ),
  );

  assert.deepEqual(output, {
    ok: false,
    type: "presentation_artifact_error",
    status: "failed",
    code: "ARTIFACT_SOURCE_NOT_FOUND",
    message:
      "sandbox download failed for /workspace/missing.pptx: No such file",
    recoverable: true,
  });
});

test("publish_artifact tool returns recoverable error for invalid PPTX files", async () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
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
        previewImage: previewImage(),
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

test("publish_artifact tool returns recoverable error for non-pptx paths", async () => {
  const result = createCapabilityAgentTools({
    toolIds: ["publish_artifact"],
    context: {
      shouldBindAgentTool: (toolName) => toolName === "publish_artifact",
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
        previewImage: previewImage(),
      }),
    ),
  );

  assert.equal(output.ok, false);
  assert.equal(output.code, "PPTX_OUTPUT_INVALID_EXTENSION");
  assert.equal(output.recoverable, true);
});

test("publishArtifactFromSource stores slides artifact records", async () => {
  const mockedServices = services();

  const output = await publishArtifactFromSource({
    context,
    services: mockedServices,
    input: slidesInput({
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
    }),
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
  // The bytes are handed over, not uploaded here: storage is the host's.
  assert.equal(mockedServices.storage.upload.mock.calls.length, 0);
  assert.equal(
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls.length,
    1,
  );
  const published =
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls[0]?.[0].spec;
  assert.equal(published.payload.source.path, "/workspace/Presentation.pptx");
  assert.equal(published.attachments?.length, 1);
  assert.equal(published.attachments?.[0]?.role, "primary");
  assert.equal(published.preview?.fileName, "preview.jpg");
  assert.equal("previewImage" in published.payload, false);
});

test("publishArtifactFromSource stores slides preview images as companion assets", async () => {
  const mockedServices = services({
    download: vi.fn(async ({ sandboxPath }: { sandboxPath: string }) =>
      sandboxPath.endsWith(".jpg")
        ? Buffer.from("jpeg-bytes")
        : validPptxBuffer(),
    ),
  });

  const output = await publishArtifactFromSource({
    context,
    services: mockedServices,
    input: slidesInput({
      title: "Deck With Preview",
      source: {
        kind: "sandbox_path",
        path: "/workspace/Presentation.pptx",
      },
      previewImage: {
        source: {
          kind: "sandbox_path",
          path: "/workspace/qa/slide-1.jpg",
        },
        altText: "First slide",
      },
    }),
  });

  assert.equal(output.ok, true);
  assert.equal(output.artifactType, "slides");
  assert.equal(typeof output.preview_image_url, "string");
  assert.match(
    output.preview_image_url!,
    /^\/api\/artifact-file\?artifactId=[^&]+&workspaceId=workspace-1&asset=previewImage$/u,
  );
  assert.match(output.preview_image_url!, new RegExp(output.artifactId));
  assert.equal(mockedServices.storage.upload.mock.calls.length, 0);
  const published =
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls[0]?.[0].spec;
  assert.equal(published?.preview?.fileName, "preview.jpg");
  assert.equal(published?.preview?.contentType, "image/jpeg");
  assert.equal(published?.preview?.altText, "First slide");
  assert.equal(published?.preview?.bytes.byteLength, "jpeg-bytes".length);
  assert.equal("previewImage" in (published?.payload ?? {}), false);
});

test("publishArtifactFromSource rejects invalid slides preview images", async () => {
  const mockedServices = services({
    download: vi.fn(async ({ sandboxPath }: { sandboxPath: string }) =>
      sandboxPath.endsWith(".txt")
        ? Buffer.from("not-image")
        : validPptxBuffer(),
    ),
  });

  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: mockedServices,
        input: slidesInput({
          title: "Deck With Bad Preview",
          source: {
            kind: "sandbox_path",
            path: "/workspace/Presentation.pptx",
          },
          previewImage: {
            source: {
              kind: "sandbox_path",
              path: "/workspace/qa/slide-1.txt",
            },
          },
        }),
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_PREVIEW_IMAGE_INVALID",
  );
});

test("publishArtifactFromSource publishes without a preview when the preview image is oversized", async () => {
  // Behavior change: an oversized preview used to abort the whole publish with
  // ARTIFACT_PREVIEW_IMAGE_TOO_LARGE, throwing away the deck to protect a
  // thumbnail. The thumbnail is an enhancement, so it is now dropped instead.
  // Malformed previews still reject (see the test above) — those are input
  // errors the caller should hear about.
  const mockedServices = services({
    download: vi.fn(async ({ sandboxPath }: { sandboxPath: string }) =>
      sandboxPath.endsWith(".jpg")
        ? Buffer.alloc(5 * 1024 * 1024 + 1)
        : validPptxBuffer(),
    ),
  });

  const output = await publishArtifactFromSource({
    context,
    services: mockedServices,
    input: slidesInput({
      title: "Deck With Large Preview",
      source: {
        kind: "sandbox_path",
        path: "/workspace/Presentation.pptx",
      },
      previewImage: {
        source: {
          kind: "sandbox_path",
          path: "/workspace/qa/preview.jpg",
        },
      },
    }),
  });

  assert.equal(output.ok, true);
  assert.equal(output.artifactType, "slides");
  assert.equal(output.preview_image_url, undefined);
  // The oversized preview is dropped before the write, so none is handed over.
  assert.equal(mockedServices.storage.upload.mock.calls.length, 0);
  const published =
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls[0]?.[0].spec;
  assert.equal(published?.preview, undefined);
});

test("publishArtifact publishes slides from work_file source", async () => {
  const mockedServices = services({
    filesystem: {
      readRaw: vi.fn().mockResolvedValue({
        data: {
          content: validPptxBuffer(),
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      }),
    },
  });

  const output = await publishArtifact({
    context,
    services: {
      artifacts: mockedServices.artifacts,
      filesystem: mockedServices.filesystem,
      sandbox: mockedServices.sandbox,
      storage: mockedServices.storage,
    },
    input: slidesInput({
      title: "Workfile Deck",
      source: {
        kind: "work_file",
        path: "/workfiles/decks/workfile-deck.pptx",
      },
    }),
  });

  assert.equal(output.ok, true);
  assert.equal(output.artifactType, "slides");
  assert.equal(output.generation_mode, "editable_native");
  const published =
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls[0]?.[0].spec;
  assert.equal(published?.payload.source.kind, "work_file");
  assert.equal(
    published?.attachments?.[0]?.contentType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
});

test("publishArtifact publishes generic file artifacts from sandbox source", async () => {
  const mockedServices = services({
    download: vi.fn().mockResolvedValue(Buffer.from("a,b\n1,2\n")),
  });

  const output = await publishArtifact({
    context,
    services: mockedServices,
    input: {
      artifactType: "file",
      title: "Table Export",
      source: {
        kind: "sandbox_path",
        path: "/workspace/output/table.csv",
      },
    },
  });

  assert.equal(output.ok, true);
  assert.equal(output.artifactType, "file");
  assert.equal(output.file_name, "table.csv");
  assert.equal(output.mime_type, "text/csv");
  assert.equal(
    mockedServices.artifacts.createFileArtifactRecord.mock.calls.length,
    1,
  );
  assert.equal(
    mockedServices.artifacts.createFileArtifactRecord.mock.calls[0]?.[0].spec
      .payload.source.path,
    "/workspace/output/table.csv",
  );
});

test("publishArtifact publishes HTML file artifacts from work_file source", async () => {
  const mockedServices = services({
    filesystem: {
      readRaw: vi.fn().mockResolvedValue({
        data: {
          content: "<!doctype html><html><body>Hello</body></html>",
          mimeType: "text/html",
        },
      }),
    },
  });

  const output = await publishArtifact({
    context,
    services: {
      artifacts: mockedServices.artifacts,
      filesystem: mockedServices.filesystem,
      storage: mockedServices.storage,
    },
    input: {
      artifactType: "file",
      title: "Example HTML",
      description: "Generated HTML artifact",
      source: {
        kind: "work_file",
        path: "/workfiles/example.html",
      },
    },
  });

  assert.equal(output.ok, true);
  assert.equal(output.artifactType, "file");
  assert.equal(output.file_name, "example.html");
  assert.equal(output.mime_type, "text/html");
  assert.equal(
    mockedServices.artifacts.createFileArtifactRecord.mock.calls.length,
    1,
  );
  const published =
    mockedServices.artifacts.createFileArtifactRecord.mock.calls[0]?.[0].spec;
  assert.equal(published?.payload.source.kind, "work_file");
  assert.equal(published?.payload.source.path, "/workfiles/example.html");
  assert.equal(published?.attachments?.[0]?.contentType, "text/html");
});

test("publishPreparedArtifact publishes generated image bytes", async () => {
  const mockedServices = services();

  const result = await publishPreparedArtifact({
    context,
    descriptor: {
      artifactType: "image",
      title: "Generated Image",
      description: "A generated image",
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
        width: 1024,
        height: 768,
      },
    },
    services: mockedServices,
    toolCallId: "tool-call-1",
  });

  assert.equal(result.output.ok, true);
  assert.equal(result.output.type, "generated_image");
  assert.equal(result.output.artifactType, "image");
  assert.equal(result.record.versionId, "version-1");
  assert.equal(
    mockedServices.artifacts.createImageArtifactRecord.mock.calls.length,
    1,
  );
  const published =
    mockedServices.artifacts.createImageArtifactRecord.mock.calls[0]?.[0].spec;
  assert.equal(published?.payload.source.kind, "generated_image");
  // The storage key is the host's to choose now, so the payload no longer
  // carries one — the attachment is what says where the bytes came from.
  assert.equal("storageKey" in published.payload, false);
  assert.equal(published?.attachments?.[0]?.fileName, "generated-image.png");
});

test("publishPreparedArtifact forwards the host signal through republish", async () => {
  const mockedServices = services();
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const republishArtifact = vi.fn(async (input: { signal?: AbortSignal }) => {
    observedSignal = input.signal;
    return {
      artifactId: "artifact-1",
      versionId: "version-2",
      reused: false,
    };
  });

  const result = await publishPreparedArtifact({
    context,
    descriptor: {
      artifactType: "file",
      title: "Updated report",
      description: "Republished report",
      republishArtifactId: "artifact-1",
      source: {
        kind: "sandbox_path",
        path: "/workspace/report.txt",
      },
    },
    source: {
      bytes: Buffer.from("updated"),
      mimeType: "text/plain",
      path: "/workspace/report.txt",
    },
    services: {
      ...mockedServices,
      artifacts: {
        ...mockedServices.artifacts,
        findArtifact: async () => ({
          id: "artifact-1",
          status: "ready",
          artifactType: "file",
          currentVersionNo: 1,
          title: "Existing report",
        }),
        republishArtifact,
      },
    },
    signal: controller.signal,
  });

  assert.equal(result.record.versionId, "version-2");
  assert.equal(republishArtifact.mock.calls.length, 1);
  assert.equal(observedSignal, controller.signal);
});

test("publishPreparedArtifact rejects slides without preview image", async () => {
  const mockedServices = services();

  await assert.rejects(
    () =>
      publishPreparedArtifact({
        context,
        descriptor: {
          artifactType: "slides",
          title: "Prepared Deck",
          source: {
            kind: "sandbox_path",
            path: "/workspace/Prepared.pptx",
          },
        },
        source: {
          bytes: validPptxBuffer(),
          mimeType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          path: "/workspace/Prepared.pptx",
        },
        services: mockedServices,
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_PREVIEW_IMAGE_INVALID" &&
      /previewImage is required/u.test(error.message),
  );
  assert.equal(mockedServices.storage.upload.mock.calls.length, 0);
  assert.equal(
    mockedServices.artifacts.createSlidesArtifactRecord.mock.calls.length,
    0,
  );
});

test("publishArtifact rejects unsupported public artifact types at schema level", async () => {
  const input = {
    artifactType: "pdf",
    title: "Unsupported PDF",
    source: {
      kind: "sandbox_path",
      path: "/workspace/file.pdf",
    },
  } as unknown as Parameters<typeof publishArtifact>[0]["input"];

  await assert.rejects(
    () =>
      publishArtifact({
        context,
        services: services(),
        input,
      }),
    /Invalid option/u,
  );
});

test("publishArtifactFromSource fails clearly for missing sandbox files", async () => {
  const mockedServices = services({
    download: vi.fn().mockRejectedValue(new Error("No such file")),
  });

  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: mockedServices,
        input: {
          ...slidesInput({
            title: "Missing",
            source: {
              kind: "sandbox_path",
              path: "/workspace/missing.pptx",
            },
          }),
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_SOURCE_NOT_FOUND" &&
      /No such file/.test(error.message),
  );
});

test("publishArtifactFromSource rejects non-pptx paths", async () => {
  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: services(),
        input: {
          ...slidesInput({
            title: "Wrong Extension",
            source: {
              kind: "sandbox_path",
              path: "/workspace/deck.pdf",
            },
          }),
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "PPTX_OUTPUT_INVALID_EXTENSION",
  );
});

test("publishArtifactFromSource rejects invalid OOXML PPTX files", async () => {
  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: services({
          download: vi.fn().mockResolvedValue(Buffer.from("not a pptx")),
        }),
        input: {
          ...slidesInput({
            title: "Invalid",
            source: {
              kind: "sandbox_path",
              path: "/workspace/invalid.pptx",
            },
          }),
        },
      }),
    (error) =>
      error instanceof PptxOutputError && error.code === "PPTX_PACKAGE_INVALID",
  );
});

/** The spec the writer is handed, as these assertions need to read it. */
type PublishedSpec = {
  readonly artifactType: string;
  readonly title: string;
  readonly prompt?: string;
  readonly payload: Record<string, unknown>;
  readonly attachments?: readonly {
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Buffer;
    readonly role?: string;
    readonly maxBytes?: number;
  }[];
  readonly preview?: {
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly fileName?: string;
    readonly altText?: string | null;
  };
  readonly idempotency?: { readonly requestKey: string };
};

/* -------------------------------------------------------------------------- */
/* Row shape through the shared writer                                        */
/* -------------------------------------------------------------------------- */

/**
 * Field for field what the pre-writer `createReadyArtifact` path persisted for
 * a `slides` artifact. deepEqual here is the whole `payload_json`, so a key that
 * appears or disappears fails rather than passing unnoticed.
 *
 * One key is deliberately absent: `payload.storageKey`, which the old path
 * copied from the column it had just built. The writer builds the key itself
 * (it contains a `randomUUID()`), so the copy cannot be reproduced — and no
 * reader ever wanted it: every read of a slides/file artifact's bytes goes
 * through the row's own `storage_key` column.
 */
test("slides publish hands the writer the payload the old path persisted", async () => {
  const mockedServices = services();

  await publishArtifactFromSource({
    context,
    services: mockedServices,
    toolCallId: "call-1",
    input: slidesInput({
      title: "Feynman Method",
      description: "Learning deck",
      source: {
        kind: "sandbox_path",
        path: "/workspace/Presentation.pptx",
      },
      qa: {
        contentChecked: true,
        visualChecked: true,
        warnings: ["check fonts"],
      },
    }),
  });

  const call = mockedServices.artifacts.publishArtifact.mock.calls[0]?.[0];
  assert.ok(call);
  const spec = call.spec as unknown as PublishedSpec;

  assert.deepEqual(spec.payload, {
    artifactType: "slides",
    byteLength: validPptxBuffer().byteLength,
    description: "Learning deck",
    fileName: "Feynman-Method.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    qa: {
      contentChecked: true,
      visualChecked: true,
      warnings: ["check fonts"],
    },
    source: {
      kind: "sandbox_path",
      path: "/workspace/Presentation.pptx",
    },
    title: "Feynman Method",
    toolCallId: "call-1",
  });

  // The rest of the row: the columns the writer fills from the spec.
  assert.equal(spec.artifactType, "slides");
  assert.equal(spec.title, "Feynman Method");
  // prompt_text was `description ?? title` on the old path and still is.
  assert.equal(spec.prompt, "Learning deck");
  assert.equal(spec.attachments?.length, 1);
  assert.equal(spec.attachments?.[0]?.role, "primary");
  assert.equal(spec.attachments?.[0]?.fileName, "Feynman-Method.pptx");
  assert.equal(
    spec.attachments?.[0]?.contentType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  // No maxBytes: the ceiling is checked here, so the code stays PPTX_OUTPUT_TOO_LARGE
  // rather than becoming the writer's ARTIFACT_ATTACHMENT_TOO_LARGE.
  assert.equal(spec.attachments?.[0]?.maxBytes, undefined);
  assert.deepEqual(spec.preview, {
    bytes: Buffer.from("preview-bytes"),
    contentType: "image/jpeg",
    fileName: "preview.jpg",
    altText: "First slide preview",
  });
  assert.equal("idempotency" in spec, false);
  assert.equal("storageKey" in spec.payload, false);
});

/** The same pin for `file`, whose payload carries no `qa` key at all. */
test("file publish hands the writer the payload the old path persisted", async () => {
  const mockedServices = services({
    download: vi.fn().mockResolvedValue(Buffer.from("a,b\n1,2\n")),
  });

  await publishArtifactFromSource({
    context,
    services: mockedServices,
    toolCallId: "call-2",
    input: {
      artifactType: "file",
      title: "Table Export",
      description: "Quarterly numbers",
      source: {
        kind: "sandbox_path",
        path: "/workspace/output/table.csv",
      },
    },
  });

  const call = mockedServices.artifacts.publishArtifact.mock.calls[0]?.[0];
  assert.ok(call);
  const spec = call.spec as unknown as PublishedSpec;

  assert.deepEqual(spec.payload, {
    artifactType: "file",
    byteLength: "a,b\n1,2\n".length,
    description: "Quarterly numbers",
    fileName: "table.csv",
    mimeType: "text/csv",
    source: {
      kind: "sandbox_path",
      path: "/workspace/output/table.csv",
    },
    title: "Table Export",
    toolCallId: "call-2",
  });

  assert.equal(spec.artifactType, "file");
  assert.equal(spec.title, "Table Export");
  assert.equal(spec.prompt, "Quarterly numbers");
  assert.equal(spec.attachments?.length, 1);
  assert.equal(spec.attachments?.[0]?.role, "primary");
  assert.equal(spec.attachments?.[0]?.fileName, "table.csv");
  assert.equal(spec.attachments?.[0]?.contentType, "text/csv");
  assert.equal(spec.attachments?.[0]?.maxBytes, undefined);
  assert.equal(spec.preview, undefined);
  assert.equal("idempotency" in spec, false);
  assert.equal("storageKey" in spec.payload, false);
});

/* -------------------------------------------------------------------------- */
/* The live PPTX_* codes stay this package's, thrown before the writer         */
/* -------------------------------------------------------------------------- */

test("PPTX_OUTPUT_INVALID_EXTENSION is thrown here, before the writer is reached", async () => {
  const mockedServices = services({
    download: vi.fn().mockResolvedValue(validPptxBuffer()),
  });

  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: mockedServices,
        input: slidesInput({
          title: "Wrong Extension",
          source: {
            kind: "sandbox_path",
            path: "/workspace/deck.pdf",
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PptxOutputError);
      assert.equal(error.code, "PPTX_OUTPUT_INVALID_EXTENSION");
      assert.equal(
        error.message,
        "PPTX_OUTPUT_INVALID_EXTENSION: path must end with .pptx: /workspace/deck.pdf",
      );
      return true;
    },
  );
  assert.equal(mockedServices.artifacts.publishArtifact.mock.calls.length, 0);
});

test("PPTX_OUTPUT_INVALID_MIME is thrown here, before the writer is reached", async () => {
  const mockedServices = services({
    filesystem: {
      readRaw: vi.fn().mockResolvedValue({
        data: { content: validPptxBuffer(), mimeType: "text/plain" },
      }),
    },
  });

  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: mockedServices,
        input: slidesInput({
          title: "Wrong Mime",
          source: {
            kind: "work_file",
            path: "/workfiles/deck.pptx",
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PptxOutputError);
      assert.equal(error.code, "PPTX_OUTPUT_INVALID_MIME");
      assert.equal(
        error.message,
        "PPTX_OUTPUT_INVALID_MIME: expected PPTX MIME type, received text/plain",
      );
      return true;
    },
  );
  assert.equal(mockedServices.artifacts.publishArtifact.mock.calls.length, 0);
});

test("PPTX_PACKAGE_INVALID is thrown here, before the writer is reached", async () => {
  const emptyServices = services({
    download: vi.fn(async ({ sandboxPath }: { sandboxPath: string }) =>
      sandboxPath.endsWith(".jpg")
        ? Buffer.from("preview-bytes")
        : Buffer.alloc(0),
    ),
  });

  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: emptyServices,
        input: slidesInput({
          title: "Empty Deck",
          source: {
            kind: "sandbox_path",
            path: "/workspace/empty.pptx",
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PptxOutputError);
      assert.equal(error.code, "PPTX_PACKAGE_INVALID");
      assert.equal(error.message, "PPTX_PACKAGE_INVALID: file is empty");
      return true;
    },
  );
  assert.equal(emptyServices.artifacts.publishArtifact.mock.calls.length, 0);

  const notZipServices = services({
    download: vi.fn(async ({ sandboxPath }: { sandboxPath: string }) =>
      sandboxPath.endsWith(".jpg")
        ? Buffer.from("preview-bytes")
        : Buffer.from("not-a-zip-archive"),
    ),
  });

  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: notZipServices,
        input: slidesInput({
          title: "Not A Zip",
          source: {
            kind: "sandbox_path",
            path: "/workspace/not-a-zip.pptx",
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PptxOutputError);
      assert.equal(error.code, "PPTX_PACKAGE_INVALID");
      assert.equal(
        error.message,
        "PPTX_PACKAGE_INVALID: file is not a valid ZIP archive (missing PK magic bytes)",
      );
      return true;
    },
  );
  assert.equal(notZipServices.artifacts.publishArtifact.mock.calls.length, 0);
});

test("PPTX_OUTPUT_TOO_LARGE is thrown here, before the writer is reached", async () => {
  const oversized = Buffer.allocUnsafe(ARTIFACT_LIMITS.pptxBytes + 1);
  const mockedServices = services({
    download: vi.fn(async ({ sandboxPath }: { sandboxPath: string }) =>
      sandboxPath.endsWith(".jpg") ? Buffer.from("preview-bytes") : oversized,
    ),
  });

  await assert.rejects(
    () =>
      publishArtifactFromSource({
        context,
        services: mockedServices,
        input: slidesInput({
          title: "Huge Deck",
          source: {
            kind: "sandbox_path",
            path: "/workspace/huge.pptx",
          },
        }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof PptxOutputError);
      assert.equal(error.code, "PPTX_OUTPUT_TOO_LARGE");
      assert.equal(
        error.message,
        `PPTX_OUTPUT_TOO_LARGE: ${ARTIFACT_LIMITS.pptxBytes + 1} bytes exceeds limit of ${ARTIFACT_LIMITS.pptxBytes} bytes`,
      );
      return true;
    },
  );
  assert.equal(mockedServices.artifacts.publishArtifact.mock.calls.length, 0);
});

/**
 * The fifth live code has no publish-path caller: `downloadPptxFromSandbox` is
 * the only thrower, and the publish path reads its bytes through the source
 * adapters (which raise `ARTIFACT_SOURCE_NOT_FOUND`). Pinned at its own entry
 * point so the string stays a contract either way.
 */
test("PPTX_OUTPUT_NOT_FOUND keeps its code and message", async () => {
  await assert.rejects(
    () =>
      downloadPptxFromSandbox({
        provider: {
          downloadFile: async () => {
            throw new Error("no such file");
          },
        },
        providerSandboxId: "sandbox-1",
        sandboxPath: "/workspace/missing.pptx",
        maxBytes: ARTIFACT_LIMITS.pptxBytes,
      }),
    (error: unknown) => {
      assert.ok(error instanceof PptxOutputError);
      assert.equal(error.code, "PPTX_OUTPUT_NOT_FOUND");
      assert.equal(
        error.message,
        "PPTX_OUTPUT_NOT_FOUND: sandbox download failed for /workspace/missing.pptx: no such file",
      );
      return true;
    },
  );
});
