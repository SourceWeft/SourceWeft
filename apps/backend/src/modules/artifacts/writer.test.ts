import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { ARTIFACT_WRITE_ERROR_CODES } from "@sourceweft/contracts/artifact-errors";
import {
  primaryArtifactAttachment,
  type ArtifactPublishSpec,
} from "@sourceweft/contracts/artifact-write";

/**
 * The writer is the one way an artifact is written, so these tests pin the
 * properties that make it safe to route both lifecycles through it:
 *
 * - nothing is uploaded for a spec that was going to be rejected, so a failed
 *   write leaves no orphaned objects in the bucket;
 * - an artifact with no bytes at all is ordinary, not an error — that is the
 *   case the old file-centric path could not express;
 * - losing the completion race is a conflict, never a retryable failure;
 * - the host names no artifact type: everything type-specific arrives through a
 *   handler the registry supplied.
 */

vi.mock("../sources/storage", () => ({
  artifactStorage: {
    buildArtifactStorageKey: () => "unused",
    getBucketName: () => "unused",
    upload: async () => {},
  },
}));
vi.mock("./repository", () => ({
  createReadyArtifactRecord: async () => ({
    artifactId: "unused",
    versionId: "unused",
  }),
  createPendingArtifactRecord: async () => {},
  markArtifactReady: async () => null,
  markArtifactFailed: async () => false,
  findArtifactRecordByRequestKey: async () => null,
}));

const { createArtifactWriter } = await import("./writer");
type ArtifactWriterDeps = import("./writer").ArtifactWriterDeps;

type Upload = { key: string; contentType: string; byteLength: number };

const uploads: Upload[] = [];
const created: Array<Record<string, unknown>> = [];
const pending: Array<Record<string, unknown>> = [];
const completed: Array<Record<string, unknown>> = [];
const failed: Array<Record<string, unknown>> = [];

let markReadyResult: { artifactId: string; versionId: string } | null = {
  artifactId: "artifact-1",
  versionId: "version-2",
};
let uploadError: Error | null = null;

type ReusableRecord = {
  id: string;
  status: string;
  latestVersionId: string | null;
};
/** What the repository's request-key lookup resolves to, per test. */
let reusableRecord: ReusableRecord | null = null;
const requestKeyLookups: Array<Record<string, unknown>> = [];

const storage = {
  buildArtifactStorageKey: (input: {
    workspaceId: string;
    artifactId: string;
    fileName: string;
  }) =>
    `workspaces/${input.workspaceId}/artifacts/${input.artifactId}/${input.fileName}`,
  getBucketName: () => "content-bucket",
  upload: async (input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }) => {
    if (uploadError) {
      throw uploadError;
    }
    uploads.push({
      key: input.key,
      contentType: input.contentType,
      byteLength: input.body.byteLength,
    });
  },
};

const repository = {
  createReady: async (input: Record<string, unknown>) => {
    created.push(input);
    return { artifactId: input.artifactId as string, versionId: "version-1" };
  },
  createPending: async (input: Record<string, unknown>) => {
    pending.push(input);
  },
  markReady: async (input: Record<string, unknown>) => {
    completed.push(input);
    return markReadyResult;
  },
  markFailed: async (input: Record<string, unknown>) => {
    failed.push(input);
    return true;
  },
  findByRequestKey: async (input: Record<string, unknown>) => {
    requestKeyLookups.push(input);
    return reusableRecord;
  },
} as unknown as ArtifactWriterDeps["repository"];

const CONTEXT = {
  teamId: "team-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  userId: "user-1",
};

function makeWriter() {
  return createArtifactWriter({
    storage,
    repository,
    newArtifactId: () => "artifact-1",
  });
}

function spec(overrides: Partial<ArtifactPublishSpec> = {}): ArtifactPublishSpec {
  return {
    artifactType: "image",
    title: "A cat",
    payload: { prompt: "a cat" },
    ...overrides,
  };
}

beforeEach(() => {
  uploads.length = 0;
  created.length = 0;
  pending.length = 0;
  completed.length = 0;
  failed.length = 0;
  markReadyResult = { artifactId: "artifact-1", versionId: "version-2" };
  uploadError = null;
  reusableRecord = null;
  requestKeyLookups.length = 0;
});

/* ========================================================================== */
/* 1. One-shot publish                                                        */
/* ========================================================================== */

test("a payload-only artifact publishes with no stored file", async () => {
  const result = await makeWriter().publishArtifact({
    context: CONTEXT,
    spec: spec({ artifactType: "video_presentation" }),
  });

  assert.deepEqual(result, {
    artifactId: "artifact-1",
    versionId: "version-1",
    reused: false,
  });
  assert.equal(uploads.length, 0);
  // storageKey stays NULL for its whole life; the payload is the artifact.
  assert.equal(created[0]?.storageKey, null);
  assert.equal(created[0]?.storageBucket, null);
  assert.deepEqual(created[0]?.payload, { prompt: "a cat" });
});

test("the primary attachment becomes the row's own stored file", async () => {
  await makeWriter().publishArtifact({
    context: CONTEXT,
    spec: spec({
      attachments: [
        {
          fileName: "thumb.png",
          contentType: "image/png",
          bytes: new Uint8Array(4),
        },
        {
          fileName: "a-cat.png",
          contentType: "image/png",
          bytes: new Uint8Array(8),
          role: "primary",
        },
      ],
    }),
  });

  assert.equal(uploads.length, 2);
  assert.equal(created[0]?.storageBucket, "content-bucket");
  assert.equal(
    created[0]?.storageKey,
    "workspaces/workspace-1/artifacts/artifact-1/a-cat.png",
  );
});

test("prompt falls back to the title", async () => {
  await makeWriter().publishArtifact({ context: CONTEXT, spec: spec() });
  assert.equal(created[0]?.prompt, "A cat");
});

test("a pre-allocated id is used, so a billing key can predate the work", async () => {
  const result = await makeWriter().publishArtifact({
    artifactId: "pre-allocated",
    context: CONTEXT,
    spec: spec(),
  });
  assert.equal(result.artifactId, "pre-allocated");
  assert.equal(created[0]?.artifactId, "pre-allocated");
});

/* ========================================================================== */
/* 2. Validation happens before any byte is uploaded                          */
/* ========================================================================== */

test("a spec the host rejects uploads nothing and writes no row", async () => {
  await assert.rejects(
    makeWriter().publishArtifact({
      context: CONTEXT,
      spec: spec({
        title: "",
        attachments: [
          {
            fileName: "a.png",
            contentType: "image/png",
            bytes: new Uint8Array(4),
          },
        ],
      }),
    }),
    (error: Error & { code?: string; recoverable?: boolean }) => {
      assert.equal(error.code, "ARTIFACT_PAYLOAD_INVALID");
      assert.equal(error.recoverable, true);
      return true;
    },
  );
  assert.deepEqual(uploads, []);
  assert.deepEqual(created, []);
});

test("a storage failure is reported as infrastructure, not as bad input", async () => {
  uploadError = new Error("s3 refused the upload");
  await assert.rejects(
    makeWriter().publishArtifact({
      context: CONTEXT,
      spec: spec({
        attachments: [
          {
            fileName: "a.png",
            contentType: "image/png",
            bytes: new Uint8Array(4),
          },
        ],
      }),
    }),
    (error: Error & { code?: string; recoverable?: boolean }) => {
      assert.equal(error.code, "ARTIFACT_STORAGE_UNAVAILABLE");
      // Telling an agent to retry a dead dependency burns the turn.
      assert.equal(error.recoverable, false);
      return true;
    },
  );
  assert.deepEqual(created, []);
});

/* ========================================================================== */
/* 3. Preview images are an enhancement                                       */
/* ========================================================================== */

test("a preview is uploaded and its metadata recorded", async () => {
  await makeWriter().publishArtifact({
    context: CONTEXT,
    spec: spec({
      preview: {
        bytes: new Uint8Array(32),
        contentType: "image/jpeg",
        altText: "a cat",
      },
    }),
  });

  assert.equal(
    uploads[0]?.key,
    "workspaces/workspace-1/artifacts/artifact-1/preview.jpg",
  );
  assert.deepEqual(created[0]?.previewMetadata, {
    altText: "a cat",
    byteLength: 32,
    fileName: "preview.jpg",
    mimeType: "image/jpeg",
  });
});

test("an oversized preview is dropped rather than failing the write", async () => {
  await makeWriter().publishArtifact({
    context: CONTEXT,
    spec: spec({
      preview: {
        bytes: new Uint8Array(5 * 1024 * 1024 + 1),
        contentType: "image/jpeg",
      },
    }),
  });

  assert.deepEqual(uploads, []);
  assert.equal(created[0]?.previewStorageKey, null);
  assert.equal(created[0]?.previewMetadata, null);
});

/* ========================================================================== */
/* 4. Two-phase lifecycle                                                     */
/* ========================================================================== */

test("openArtifact writes a pending row and returns its id", async () => {
  const result = await makeWriter().openArtifact({
    context: CONTEXT,
    spec: spec({ artifactType: "video_presentation" }),
  });
  assert.deepEqual(result, { artifactId: "artifact-1", reused: false });
  assert.equal(pending[0]?.artifactType, "video_presentation");
  assert.equal(pending[0]?.title, "A cat");
});

test("openArtifact uploads nothing even when the spec carries bytes", async () => {
  // Bytes written for an artifact that may never complete are bytes nothing
  // will ever reference.
  await makeWriter().openArtifact({
    context: CONTEXT,
    spec: spec({
      attachments: [
        {
          fileName: "a.png",
          contentType: "image/png",
          bytes: new Uint8Array(4),
        },
      ],
    }),
  });
  assert.deepEqual(uploads, []);
});

test("openArtifact validates, so a doomed spec never reaches pending", async () => {
  await assert.rejects(
    makeWriter().openArtifact({ context: CONTEXT, spec: spec({ title: "" }) }),
  );
  assert.deepEqual(pending, []);
});

test("completeArtifact publishes the next version with its bytes", async () => {
  const result = await makeWriter().completeArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    spec: spec({
      attachments: [
        {
          fileName: "a-cat.png",
          contentType: "image/png",
          bytes: new Uint8Array(8),
          role: "primary",
        },
      ],
    }),
    expectedStatuses: ["pending", "running"],
  });

  assert.deepEqual(result, {
    artifactId: "artifact-1",
    versionId: "version-2",
    reused: false,
  });
  assert.equal(completed[0]?.storageBucket, "content-bucket");
  assert.deepEqual(completed[0]?.expectedStatuses, ["pending", "running"]);
});

test("completeArtifact leaves storage pointers alone when there are no bytes", async () => {
  await makeWriter().completeArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    spec: spec({ artifactType: "video_presentation" }),
  });
  // Omitted, not null: the repository carries forward what the row already has.
  assert.equal("storageKey" in (completed[0] ?? {}), false);
  assert.equal("storageBucket" in (completed[0] ?? {}), false);
});

test("losing the completion race is a conflict, not a retryable failure", async () => {
  markReadyResult = null;
  await assert.rejects(
    makeWriter().completeArtifact({
      artifactId: "artifact-1",
      context: CONTEXT,
      spec: spec(),
    }),
    (
      error: Error & {
        code?: string;
        category?: string;
        recoverable?: boolean;
      },
    ) => {
      assert.equal(error.code, "ARTIFACT_STATE_CONFLICT");
      assert.equal(error.category, "conflict");
      assert.equal(error.recoverable, false);
      return true;
    },
  );
});

test("failArtifact stores a code the classification table knows", async () => {
  const result = await makeWriter().failArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    error: new Error("the provider returned no bytes"),
  });

  assert.equal(result.recorded, true);
  assert.equal(failed[0]?.errorCode, "ARTIFACT_RECORD_UNAVAILABLE");
  assert.equal(failed[0]?.errorMessage, "the provider returned no bytes");
  assert.equal(result.error.recoverable, false);
});

test("failArtifact preserves a code the thrower already chose", async () => {
  await makeWriter().failArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    error: Object.assign(new Error("sandbox is down"), {
      code: "VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE",
    }),
  });
  assert.equal(failed[0]?.errorCode, "VIDEO_PRESENTATION_SANDBOX_UNAVAILABLE");
});

/* ========================================================================== */
/* 6. Idempotency: the spec field is now honoured, not merely accepted         */
/* ========================================================================== */

const IDEMPOTENT = { idempotency: { requestKey: "request-1" } } as const;

test("a de-duplicated publish uploads nothing and writes no row", async () => {
  // The property that matters: the lookup precedes the uploads. A hit found
  // after them has already left objects in the bucket for an artifact this call
  // did not create, which nothing references and nothing collects.
  reusableRecord = {
    id: "artifact-existing",
    status: "ready",
    latestVersionId: "version-7",
  };

  const result = await makeWriter().publishArtifact({
    context: CONTEXT,
    spec: spec({
      ...IDEMPOTENT,
      attachments: [
        {
          fileName: "a-cat.png",
          contentType: "image/png",
          bytes: new Uint8Array(64),
          role: "primary",
        },
      ],
    }),
  });

  assert.deepEqual(result, {
    artifactId: "artifact-existing",
    versionId: "version-7",
    reused: true,
  });
  assert.deepEqual(uploads, []);
  assert.deepEqual(created, []);
});

test("a publish that misses records the request key on the new row", async () => {
  const result = await makeWriter().publishArtifact({
    context: CONTEXT,
    spec: spec(IDEMPOTENT),
  });

  assert.equal(result.reused, false);
  assert.equal(created[0]?.requestKey, "request-1");
  // Only a finished artifact may be handed back by the one-shot lifecycle: a
  // pending row under this key belongs to a two-phase writer still running.
  assert.deepEqual(requestKeyLookups[0]?.statuses, ["ready"]);
});

test("a publish with no idempotency key never looks one up", async () => {
  await makeWriter().publishArtifact({ context: CONTEXT, spec: spec() });
  assert.deepEqual(requestKeyLookups, []);
  assert.equal(created[0]?.requestKey, null);
});

test("a retried open returns its own in-flight pending row", async () => {
  // The two-phase trap: the key is visible from `open`, but the artifact is not
  // ready until `complete`. A retried open that could only match `ready` would
  // open a second artifact for one request, and the user would watch both.
  reusableRecord = {
    id: "artifact-existing",
    status: "pending",
    latestVersionId: null,
  };

  const result = await makeWriter().openArtifact({
    context: CONTEXT,
    spec: spec({ ...IDEMPOTENT, artifactType: "video_presentation" }),
  });

  assert.deepEqual(result, { artifactId: "artifact-existing", reused: true });
  assert.deepEqual(pending, []);
  assert.deepEqual(requestKeyLookups[0]?.statuses, [
    "pending",
    "running",
    "ready",
  ]);
});

test("a failed artifact is not what a retried request gets back", async () => {
  // Neither lifecycle asks for `failed`: a request retried after a failure is
  // asking for the work to happen, not for the failure to be handed back.
  await makeWriter().openArtifact({ context: CONTEXT, spec: spec(IDEMPOTENT) });
  await makeWriter().publishArtifact({
    context: CONTEXT,
    spec: spec(IDEMPOTENT),
  });

  for (const lookup of requestKeyLookups) {
    assert.equal(
      (lookup.statuses as readonly string[]).includes("failed"),
      false,
    );
  }
});

test("an open that misses records the request key on the pending row", async () => {
  await makeWriter().openArtifact({
    context: CONTEXT,
    spec: spec({ ...IDEMPOTENT, artifactType: "video_presentation" }),
  });
  assert.equal(pending[0]?.requestKey, "request-1");
});

/* ========================================================================== */
/* 7. Version-based optimistic locking                                        */
/* ========================================================================== */

test("completeArtifact carries the caller's base version to the CAS", async () => {
  // Two concurrent edits of one artifact both see status `ready`, so status
  // cannot separate them. The base version can: only the run whose base is
  // still the published one wins.
  await makeWriter().completeArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    spec: spec({ artifactType: "video_presentation" }),
    expectedStatuses: ["ready", "running", "pending"],
    expectedVersionNo: 3,
  });

  assert.equal(completed[0]?.expectedVersionNo, 3);
});

test("no base version means no version predicate at all", async () => {
  // Omitted rather than 0: a create run has no base to lock against, and
  // sending 0 would be a predicate that happens to match pending rows.
  await makeWriter().completeArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    spec: spec({ artifactType: "video_presentation" }),
    expectedStatuses: ["pending", "running"],
  });

  assert.equal("expectedVersionNo" in (completed[0] ?? {}), false);
});

test("losing the version CAS is the same conflict as losing the status CAS", async () => {
  markReadyResult = null;
  await assert.rejects(
    makeWriter().completeArtifact({
      artifactId: "artifact-1",
      context: CONTEXT,
      spec: spec({ artifactType: "video_presentation" }),
      expectedVersionNo: 3,
    }),
    (error: Error & { code?: string; recoverable?: boolean }) => {
      assert.equal(error.code, "ARTIFACT_STATE_CONFLICT");
      // Not retryable: the work is not lost, but this caller does not own the
      // outcome, so re-running it would republish over the winner.
      assert.equal(error.recoverable, false);
      return true;
    },
  );
});

/* ========================================================================== */
/* 8. An artifact type the schema does not know                               */
/* ========================================================================== */

test("an unknown artifact type is a validation error, not an infrastructure one", async () => {
  // It used to be cast straight through to the repository and die on the
  // artifact_type CHECK constraint, surfacing as ARTIFACT_RECORD_UNAVAILABLE:
  // infrastructure, therefore unrecoverable, therefore telling the caller the
  // database was broken when the truth was "that type does not exist".
  for (const lifecycle of ["publishArtifact", "openArtifact"] as const) {
    await assert.rejects(
      makeWriter()[lifecycle]({
        context: CONTEXT,
        spec: spec({
          artifactType: "hologram",
          attachments: [
            {
              fileName: "a.png",
              contentType: "image/png",
              bytes: new Uint8Array(4),
            },
          ],
        }),
      }),
      (error: Error & { code?: string; recoverable?: boolean }) => {
        assert.equal(error.code, ARTIFACT_WRITE_ERROR_CODES.typeUnsupported);
        assert.equal(error.recoverable, true);
        return true;
      },
    );
  }
  // And it is caught before the bytes are written, like every other rejection.
  assert.deepEqual(uploads, []);
  assert.deepEqual(created, []);
  assert.deepEqual(pending, []);
});
