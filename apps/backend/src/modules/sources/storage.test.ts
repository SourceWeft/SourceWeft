import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import { ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES } from "@sourceweft/contracts/artifact-storage";
import type { DeliverableHostContext } from "@sourceweft/capability-contracts";

/**
 * What is and is not covered here.
 *
 * There is no object store in this test run: the AWS SDK is stubbed at the
 * module boundary, so what is exercised is this module's own logic — bucket
 * resolution, the missing-key mapping, the byte ceiling and the content-type
 * fallback — against the shapes S3 (and the S3-compatible stores this
 * deployment also targets) returns. Nothing here proves that a real bucket
 * behaves as stubbed; it proves that when it does, `download` answers the way
 * the port says it does.
 */

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
  class DeleteObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class DeleteObjectsCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class GetObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class HeadObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class ListObjectsV2Command {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class PutObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class S3Client {
    send = sendMock;
  }
  return {
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
  };
});

type StorageModule = typeof import("./storage");
let storage: StorageModule;

/** The bucket has to exist before `config` is first evaluated, hence the dynamic import. */
beforeAll(async () => {
  process.env.S3_BUCKET ||= "test-content-bucket";
  storage = await import("./storage");
});

beforeEach(() => {
  sendMock.mockReset();
});

/** Shape of a GetObject reply, minus everything this module does not read. */
function getObjectReply(input: {
  body?: Uint8Array | null;
  contentLength?: number | null;
  contentType?: string | null;
}) {
  const bytes = input.body;
  return {
    ContentType: input.contentType ?? undefined,
    ContentLength:
      input.contentLength === null
        ? undefined
        : (input.contentLength ?? bytes?.byteLength),
    Body:
      bytes === null
        ? undefined
        : { transformToByteArray: vi.fn().mockResolvedValue(bytes) },
  };
}

function lastGetKeyAndBucket() {
  const command = sendMock.mock.calls.at(-1)?.[0] as {
    input: { Bucket?: string; Key?: string };
  };
  return { bucket: command.input.Bucket, key: command.input.Key };
}

/** How S3 reports an absent key; MinIO/R2 differ only in which field is set. */
function noSuchKeyError() {
  return Object.assign(new Error("The specified key does not exist."), {
    name: "NoSuchKey",
    $metadata: { httpStatusCode: 404 },
  });
}

describe("downloadArtifactObjectForPort", () => {
  test("returns the bytes and the stored content type", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    sendMock.mockResolvedValue(
      getObjectReply({ body, contentType: "audio/mpeg" }),
    );

    const result = await storage.downloadArtifactObjectForPort({
      key: "workspaces/w1/artifacts/a1/narration.mp3",
    });

    expect(result).toEqual({ body, contentType: "audio/mpeg" });
    // No bucket given, so the port's own bucket is used — the same resolution
    // `upload` performs, which is what makes an upload/download pair symmetric.
    expect(lastGetKeyAndBucket()).toEqual({
      bucket: storage.getContentStorageBucketName(),
      key: "workspaces/w1/artifacts/a1/narration.mp3",
    });
  });

  test("an explicit bucket wins over the configured one", async () => {
    sendMock.mockResolvedValue(
      getObjectReply({ body: new Uint8Array([9]), contentType: "audio/mpeg" }),
    );

    await storage.downloadArtifactObjectForPort({
      bucket: "other-bucket",
      key: "k",
    });

    expect(lastGetKeyAndBucket().bucket).toBe("other-bucket");
  });

  test("a store that recorded no content type still yields one", async () => {
    sendMock.mockResolvedValue(
      getObjectReply({ body: new Uint8Array([1]), contentType: null }),
    );

    const result = await storage.downloadArtifactObjectForPort({ key: "k" });

    expect(result?.contentType).toBe("application/octet-stream");
  });

  test("an object with no body reads as empty, not as absent", async () => {
    sendMock.mockResolvedValue(
      getObjectReply({ body: null, contentType: "audio/mpeg" }),
    );

    const result = await storage.downloadArtifactObjectForPort({ key: "k" });

    expect(result).toEqual({
      body: new Uint8Array(0),
      contentType: "audio/mpeg",
    });
  });

  test("a missing key resolves null rather than throwing", async () => {
    sendMock.mockRejectedValue(noSuchKeyError());

    await expect(
      storage.downloadArtifactObjectForPort({ key: "gone" }),
    ).resolves.toBeNull();
  });

  test("a bare 404 with no error name is still a missing key", async () => {
    sendMock.mockRejectedValue(
      Object.assign(new Error("Not Found"), {
        $metadata: { httpStatusCode: 404 },
      }),
    );

    await expect(
      storage.downloadArtifactObjectForPort({ key: "gone" }),
    ).resolves.toBeNull();
  });

  test("a missing bucket is an environment fault, not an absent object", async () => {
    sendMock.mockRejectedValue(
      Object.assign(new Error("no bucket"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      }),
    );

    await expect(
      storage.downloadArtifactObjectForPort({ key: "k" }),
    ).rejects.toThrow("no bucket");
  });

  test("transport failures propagate untouched", async () => {
    sendMock.mockRejectedValue(
      Object.assign(new Error("connection reset"), {
        name: "TimeoutError",
        $metadata: { httpStatusCode: 500 },
      }),
    );

    await expect(
      storage.downloadArtifactObjectForPort({ key: "k" }),
    ).rejects.toThrow("connection reset");
  });
});

describe("conditional object writes", () => {
  test("uses the real S3 If-None-Match precondition", async () => {
    sendMock.mockResolvedValue({});

    await expect(
      storage.putArtifactObjectIfAbsent({
        key: "agent-wip/v1/scope/semantic",
        body: new Uint8Array([1, 2, 3]),
        contentType: "audio/mpeg",
        metadata: { "sourceweft-sha256": "abc" },
      }),
    ).resolves.toBe("created");

    const command = sendMock.mock.calls[0]?.[0] as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    expect(command.constructor.name).toBe("PutObjectCommand");
    expect(command.input).toMatchObject({
      Bucket: storage.getContentStorageBucketName(),
      Key: "agent-wip/v1/scope/semantic",
      IfNoneMatch: "*",
      ContentType: "audio/mpeg",
      Metadata: { "sourceweft-sha256": "abc" },
    });
  });

  test("maps a 412 precondition failure to an existing object", async () => {
    sendMock.mockRejectedValue(
      Object.assign(new Error("precondition failed"), {
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      }),
    );

    await expect(
      storage.putArtifactObjectIfAbsent({
        key: "agent-wip/v1/scope/semantic",
        body: new Uint8Array([1]),
        contentType: "application/octet-stream",
      }),
    ).resolves.toBe("exists");
  });

  test("retries a concurrent 409 without falling back to an unconditional put", async () => {
    sendMock
      .mockRejectedValueOnce(
        Object.assign(new Error("conditional request conflict"), {
          name: "ConditionalRequestConflict",
          $metadata: { httpStatusCode: 409 },
        }),
      )
      .mockResolvedValueOnce({});

    await expect(
      storage.putArtifactObjectIfAbsent({
        key: "agent-wip/v1/scope/semantic",
        body: new Uint8Array([1]),
        contentType: "application/octet-stream",
      }),
    ).resolves.toBe("created");
    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const [command] of sendMock.mock.calls) {
      expect(
        (command as { input: Record<string, unknown> }).input.IfNoneMatch,
      ).toBe("*");
    }
  });
});

describe("scoped object metadata and cleanup", () => {
  test("returns user metadata with the bounded object bytes", async () => {
    sendMock.mockResolvedValue({
      ...getObjectReply({
        body: new Uint8Array([4, 5]),
        contentType: "image/png",
      }),
      Metadata: {
        "sourceweft-sha256": "sha256:abc",
        "sourceweft-expires-at": "2026-08-29T00:00:00.000Z",
      },
    });

    await expect(
      storage.downloadArtifactObjectWithMetadata({
        key: "agent-wip/v1/scope/semantic",
        maxBytes: 10,
      }),
    ).resolves.toEqual({
      body: new Uint8Array([4, 5]),
      contentType: "image/png",
      metadata: {
        "sourceweft-sha256": "sha256:abc",
        "sourceweft-expires-at": "2026-08-29T00:00:00.000Z",
      },
    });
  });

  test("lists the exact prefix before deleting its objects in batches", async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: "agent-wip/v1/scope/a" }],
        IsTruncated: true,
        NextContinuationToken: "next-page",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "agent-wip/v1/scope/b" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    await storage.deleteArtifactObjectsByPrefix({
      prefix: "agent-wip/v1/scope/",
    });

    expect(sendMock).toHaveBeenCalledTimes(3);
    expect(
      (sendMock.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({
      Prefix: "agent-wip/v1/scope/",
      MaxKeys: 1000,
    });
    expect(
      (sendMock.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({
      Prefix: "agent-wip/v1/scope/",
      ContinuationToken: "next-page",
    });
    expect(
      (sendMock.mock.calls[2]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({
      Delete: {
        Quiet: true,
        Objects: [
          { Key: "agent-wip/v1/scope/a" },
          { Key: "agent-wip/v1/scope/b" },
        ],
      },
    });
  });

  test("refuses an empty or over-broad prefix before calling S3", async () => {
    await expect(
      storage.deleteArtifactObjectsByPrefix({ prefix: "" }),
    ).rejects.toThrow(/prefix/i);
    await expect(
      storage.deleteArtifactObjectsByPrefix({
        prefix: "agent-wip/v1/scope/",
        maxObjects: 0,
      }),
    ).rejects.toThrow(/maxObjects/i);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("the download byte ceiling", () => {
  test("an oversized object is refused before any byte is buffered", async () => {
    const reply = getObjectReply({
      body: new Uint8Array(0),
      contentLength: ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES + 1,
      contentType: "video/mp4",
    });
    sendMock.mockResolvedValue(reply);

    // Too large throws; it must never look like "not there", because a caller
    // that treats absence as "skip this input" would then ship the missing
    // input silently.
    await expect(
      storage.downloadArtifactObjectForPort({ key: "huge.mp4" }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_ATTACHMENT_TOO_LARGE",
      category: "validation",
    });
    expect(reply.Body?.transformToByteArray).not.toHaveBeenCalled();
  });

  test("a caller may tighten the ceiling", async () => {
    sendMock.mockResolvedValue(
      getObjectReply({
        body: new Uint8Array(1024),
        contentType: "audio/mpeg",
      }),
    );

    await expect(
      storage.downloadArtifactObjectForPort({ key: "k", maxBytes: 512 }),
    ).rejects.toMatchObject({ code: "ARTIFACT_ATTACHMENT_TOO_LARGE" });
  });

  test("a caller may not widen it", async () => {
    sendMock.mockResolvedValue(
      getObjectReply({
        body: new Uint8Array(0),
        contentLength: ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES + 1,
        contentType: "video/mp4",
      }),
    );

    await expect(
      storage.downloadArtifactObjectForPort({
        key: "huge.mp4",
        maxBytes: ARTIFACT_STORAGE_MAX_DOWNLOAD_BYTES * 10,
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_ATTACHMENT_TOO_LARGE" });
  });

  test("a store that omits ContentLength is still bounded after the fact", async () => {
    sendMock.mockResolvedValue(
      getObjectReply({
        body: new Uint8Array(2048),
        contentLength: null,
        contentType: "audio/mpeg",
      }),
    );

    await expect(
      storage.downloadArtifactObjectForPort({ key: "k", maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: "ARTIFACT_ATTACHMENT_TOO_LARGE" });
  });

  test("an object exactly at the ceiling is allowed through", async () => {
    const body = new Uint8Array(1024);
    sendMock.mockResolvedValue(
      getObjectReply({ body, contentType: "audio/mpeg" }),
    );

    await expect(
      storage.downloadArtifactObjectForPort({ key: "k", maxBytes: 1024 }),
    ).resolves.toEqual({ body, contentType: "audio/mpeg" });
  });
});

/* -------------------------------------------------------------------------- */
/* The two declarations of the port                                            */
/* -------------------------------------------------------------------------- */

/**
 * `ArtifactStorage` is declared twice: canonically in
 * `@sourceweft/contracts/artifact-storage`, and restated structurally inside
 * `DeliverableHostContext` because `@sourceweft/capability-contracts` carries
 * no workspace dependencies on purpose. Their comment says "keep the two in
 * sync"; this makes that a compile error instead of a hope.
 *
 * The backend is the only place that imports both packages, which is why the
 * pin lives here. It is a *type* assertion: the constraint below fails to
 * compile — `pnpm turbo check-types` — if either declaration gains, loses or
 * changes a member the other does not. The runtime assertion exists only so
 * the check has a test to be reported under.
 */
type RestatedArtifactStorage = DeliverableHostContext["storage"];

type IsAssignable<Source, Target> = Source extends Target ? true : false;

// Each of these collapses to `false` the moment one declaration drifts, and
// `false` does not assign to the `true` annotation — so the drift is reported
// at the declaration that caused it, in both directions independently.
const canonicalFitsRestatement: IsAssignable<
  ArtifactStorage,
  RestatedArtifactStorage
> = true;
const restatementFitsCanonical: IsAssignable<
  RestatedArtifactStorage,
  ArtifactStorage
> = true;

test("the canonical port and its capability-contracts restatement stay in sync", () => {
  expect([canonicalFitsRestatement, restatementFitsCanonical]).toEqual([
    true,
    true,
  ]);
});
