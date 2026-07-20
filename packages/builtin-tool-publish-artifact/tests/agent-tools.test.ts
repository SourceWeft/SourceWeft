import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  createCapabilityAgentTools,
  publishArtifact,
  publishArtifactFromSource,
  publishPreparedArtifact,
  type PublishArtifactInput,
  PptxOutputError,
} from "../src";

function validPptxBuffer() {
  return Buffer.from(
    "PK\u0003\u0004 [Content_Types].xml ppt/presentation.xml ppt/slides/slide1.xml",
    "latin1",
  );
}

function services(input?: {
  download?: (input: { sandboxPath: string }) => Promise<Buffer>;
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
  const defaultDownload = vi.fn(async ({ sandboxPath }: { sandboxPath: string }) =>
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
        .mockImplementation((input: { fileName: string }) =>
          `artifacts/workspace-1/artifact-1/${input.fileName}`,
        ),
      getBucketName: vi.fn().mockReturnValue("content"),
      upload: vi.fn().mockResolvedValue(undefined),
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

function createPublisherTool() {
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
  return publisher;
}

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
  assert.match(output.message, /previewImage is only supported for slides artifacts/u);
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
    message: "sandbox download failed for /workspace/missing.pptx: No such file",
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
