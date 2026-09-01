import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { adapterForSource } from "../src/source-adapters";
import {
  PptxOutputError,
  type ArtifactSource,
  type PublishArtifactInput,
} from "../src/schemas";

function validInput(source: ArtifactSource): PublishArtifactInput {
  return {
    artifactType: "slides",
    title: "Deck",
    source,
  };
}

test("sandbox_path source adapter reads bytes from sandbox service", async () => {
  const downloadCurrentFile = vi.fn().mockResolvedValue(Buffer.from("bytes"));
  const adapter = adapterForSource({
    kind: "sandbox_path",
    path: "/workspace/deck.pptx",
  });
  assert.ok(adapter);

  const output = await adapter.read({
    publishInput: validInput({
      kind: "sandbox_path",
      path: "/workspace/deck.pptx",
    }),
    services: {
      sandbox: {
        downloadCurrentFile,
      },
    },
  });

  assert.equal(output.bytes.toString(), "bytes");
  assert.equal(output.path, "/workspace/deck.pptx");
  assert.equal(downloadCurrentFile.mock.calls[0]?.[0].sandboxPath, "/workspace/deck.pptx");
});

test("sandbox_path source adapter forwards the host invocation signal", async () => {
  const controller = new AbortController();
  const downloadCurrentFile = vi
    .fn()
    .mockResolvedValue(Buffer.from("bytes"));
  const adapter = adapterForSource({
    kind: "sandbox_path",
    path: "/workspace/deck.pptx",
  });
  assert.ok(adapter);

  await adapter.read({
    publishInput: validInput({
      kind: "sandbox_path",
      path: "/workspace/deck.pptx",
    }),
    services: { sandbox: { downloadCurrentFile } },
    signal: controller.signal,
  });

  assert.equal(
    downloadCurrentFile.mock.calls[0]?.[0].signal,
    controller.signal,
  );
});

test("sandbox_path source adapter rejects paths outside allowed roots", async () => {
  const adapter = adapterForSource({
    kind: "sandbox_path",
    path: "/tmp/deck.pptx",
  });
  assert.ok(adapter);

  await assert.rejects(
    () =>
      adapter.read({
        publishInput: validInput({
          kind: "sandbox_path",
          path: "/tmp/deck.pptx",
        }),
        services: {
          sandbox: {
            downloadCurrentFile: vi.fn(),
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_SOURCE_INVALID" &&
      /under allowed sandbox roots: \/workspace/u.test(error.details ?? ""),
  );
});

test("sandbox_path source adapter honors provider allowed roots", async () => {
  const downloadCurrentFile = vi.fn().mockResolvedValue(Buffer.from("bytes"));
  const adapter = adapterForSource({
    kind: "sandbox_path",
    path: "/task/output.zip",
  });
  assert.ok(adapter);

  const output = await adapter.read({
    publishInput: validInput({
      kind: "sandbox_path",
      path: "/task/output.zip",
    }),
    services: {
      sandbox: {
        allowedReadRoots: ["/task"],
        downloadCurrentFile,
      },
    },
  });

  assert.equal(output.path, "/task/output.zip");
  assert.equal(downloadCurrentFile.mock.calls[0]?.[0].sandboxPath, "/task/output.zip");

  await assert.rejects(
    () =>
      adapter.read({
        publishInput: validInput({
          kind: "sandbox_path",
          path: "/workspace/output.zip",
        }),
        services: {
          sandbox: {
            allowedReadRoots: ["/task"],
            downloadCurrentFile,
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_SOURCE_INVALID" &&
      /under allowed sandbox roots: \/task/u.test(error.message),
  );
});

test("work_file source adapter reads binary bytes from VFS download", async () => {
  const downloadFiles = vi.fn().mockResolvedValue([
    {
      path: "/workfiles/deck.pptx",
      content: new Uint8Array([0x50, 0x4b]),
      error: null,
    },
  ]);
  const adapter = adapterForSource({
    kind: "work_file",
    path: "workfiles/deck.pptx",
  });
  assert.ok(adapter);

  const output = await adapter.read({
    publishInput: validInput({
      kind: "work_file",
      path: "workfiles/deck.pptx",
    }),
    services: {
      filesystem: {
        downloadFiles,
      },
    },
  });

  assert.deepEqual([...output.bytes], [0x50, 0x4b]);
  assert.equal(output.path, "/workfiles/deck.pptx");
  assert.deepEqual(downloadFiles.mock.calls[0]?.[0], ["/workfiles/deck.pptx"]);
});

test("work_file source adapter falls back to readRaw text content", async () => {
  const adapter = adapterForSource({
    kind: "work_file",
    path: "/workfiles/deck.pptx",
  });
  assert.ok(adapter);

  const output = await adapter.read({
    publishInput: validInput({
      kind: "work_file",
      path: "/workfiles/deck.pptx",
    }),
    services: {
      filesystem: {
        readRaw: vi.fn().mockResolvedValue({
          data: {
            content: "PK",
            mimeType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          },
        }),
      },
    },
  });

  assert.equal(output.bytes.toString(), "PK");
  assert.equal(
    output.mimeType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
});

test("work_file source adapter returns recoverable missing source error", async () => {
  const adapter = adapterForSource({
    kind: "work_file",
    path: "/workfiles/missing.pptx",
  });
  assert.ok(adapter);

  await assert.rejects(
    () =>
      adapter.read({
        publishInput: validInput({
          kind: "work_file",
          path: "/workfiles/missing.pptx",
        }),
        services: {
          filesystem: {
            readRaw: vi.fn().mockResolvedValue({
              error: "file not found",
            }),
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_SOURCE_NOT_FOUND",
  );
});

test("work_file source adapter rejects paths outside /workfiles", async () => {
  const adapter = adapterForSource({
    kind: "work_file",
    path: "/kb/source.pdf",
  });
  assert.ok(adapter);

  await assert.rejects(
    () =>
      adapter.read({
        publishInput: validInput({
          kind: "work_file",
          path: "/kb/source.pdf",
        }),
        services: {
          filesystem: {
            readRaw: vi.fn(),
          },
        },
      }),
    (error) =>
      error instanceof PptxOutputError &&
      error.code === "ARTIFACT_SOURCE_INVALID" &&
      /under \/workfiles/u.test(error.message),
  );
});
