import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import {
  ARTIFACT_WRITE_ERROR_CODES,
  ArtifactError,
} from "@sourceweft/contracts/artifact-errors";
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
    delete: async () => {},
  },
}));
const diagnostics = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../../shared/logger", () => ({ logger: diagnostics }));
vi.mock("./repository", () => ({
  createReadyArtifactRecord: async () => ({
    artifactId: "unused",
    versionId: "unused",
    reused: false,
  }),
  createPendingArtifactRecord: async () => ({
    artifactId: "unused",
    reused: false,
  }),
  markArtifactReady: async () => null,
  markArtifactFailed: async () => false,
  findArtifactRecordByRequestKey: async () => null,
  findArtifactWriteReferences: async () => ({
    artifactExists: false,
    currentVersionNo: null,
    hasVersions: false,
    referencedKeys: [],
  }),
}));

const { createArtifactWriter } = await import("./writer");
type ArtifactWriterDeps = import("./writer").ArtifactWriterDeps;

type Upload = { key: string; contentType: string; byteLength: number };

const uploads: Upload[] = [];
const deletedKeys: string[] = [];
const created: Array<Record<string, unknown>> = [];
const pending: Array<Record<string, unknown>> = [];
const completed: Array<Record<string, unknown>> = [];
const failed: Array<Record<string, unknown>> = [];

let markReadyResult: { artifactId: string; versionId: string } | null = {
  artifactId: "artifact-1",
  versionId: "version-2",
};
let currentVersionNo = 1;
let uploadError: Error | null = null;
let deleteError: Error | null = null;
let createReadyError: Error | null = null;
let markReadyError: Error | null = null;
let readyWinner: {
  artifactId: string;
  versionId: string;
  reused: boolean;
} | null = null;
let pendingWinner: { artifactId: string; reused: boolean } | null = null;
let referenceError: Error | null = null;
let writeReferences = {
  artifactExists: false,
  currentVersionNo: null as number | null,
  hasVersions: false,
  referencedKeys: [] as string[],
};
const referenceLookups: Array<Record<string, unknown>> = [];
let onUpload:
  | ((input: { key: string; signal?: AbortSignal }) => void | Promise<void>)
  | null = null;

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
    signal?: AbortSignal;
  }) => {
    if (uploadError) {
      throw uploadError;
    }
    uploads.push({
      key: input.key,
      contentType: input.contentType,
      byteLength: input.body.byteLength,
    });
    await onUpload?.(input);
  },
  delete: async (input: { key: string }) => {
    deletedKeys.push(input.key);
    if (deleteError) throw deleteError;
  },
  // The writer never reads objects back; present only because the port
  // requires it, so a stub that fails loudly is better than a plausible one.
  download: async () => {
    throw new Error("writer must not download stored objects");
  },
};

const repository = {
  createReady: async (input: Record<string, unknown>) => {
    created.push(input);
    if (createReadyError) throw createReadyError;
    return (
      readyWinner ?? {
        artifactId: input.artifactId as string,
        versionId: "version-1",
        reused: false,
      }
    );
  },
  createPending: async (input: Record<string, unknown>) => {
    pending.push(input);
    return (
      pendingWinner ?? { artifactId: input.artifactId as string, reused: false }
    );
  },
  markReady: async (input: Record<string, unknown>) => {
    completed.push(input);
    if (markReadyError) throw markReadyError;
    if (markReadyResult) currentVersionNo += 1;
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
  findWriteReferences: async (input: Record<string, unknown>) => {
    referenceLookups.push(input);
    if (referenceError) throw referenceError;
    return writeReferences;
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

function spec(
  overrides: Partial<ArtifactPublishSpec> = {},
): ArtifactPublishSpec {
  return {
    artifactType: "image",
    title: "A cat",
    payload: { prompt: "a cat" },
    ...overrides,
  };
}

beforeEach(() => {
  uploads.length = 0;
  deletedKeys.length = 0;
  created.length = 0;
  pending.length = 0;
  completed.length = 0;
  failed.length = 0;
  markReadyResult = { artifactId: "artifact-1", versionId: "version-2" };
  currentVersionNo = 1;
  uploadError = null;
  deleteError = null;
  createReadyError = null;
  markReadyError = null;
  readyWinner = null;
  pendingWinner = null;
  referenceError = null;
  writeReferences = {
    artifactExists: false,
    currentVersionNo: null,
    hasVersions: false,
    referencedKeys: [],
  };
  referenceLookups.length = 0;
  diagnostics.warn.mockClear();
  diagnostics.error.mockClear();
  onUpload = null;
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

test("abort during upload cleans attempted objects and reaches neither row nor output recorder", async () => {
  const controller = new AbortController();
  const abortReason = new DOMException("tool timeout", "TimeoutError");
  let releaseUpload!: () => void;
  let uploadStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    uploadStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let outputCards = 0;
  let observedSignal: AbortSignal | undefined;
  onUpload = async (input) => {
    observedSignal = input.signal;
    uploadStarted();
    await blocked;
  };

  const publication = makeWriter()
    .publishArtifact({
      context: CONTEXT,
      signal: controller.signal,
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
    })
    .then((result) => {
      outputCards += 1;
      return result;
    });
  await started;
  controller.abort(abortReason);
  releaseUpload();

  await assert.rejects(publication, (error: unknown) => error === abortReason);
  assert.equal(observedSignal, controller.signal);
  assert.deepEqual(created, []);
  assert.deepEqual(deletedKeys, [
    "workspaces/workspace-1/artifacts/artifact-1/a-cat.png",
  ]);
  assert.equal(outputCards, 0);
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

test("abort during republish upload cleans attempted bytes and leaves the current version unchanged", async () => {
  const controller = new AbortController();
  const abortReason = new DOMException("tool timeout", "TimeoutError");
  let releaseUpload!: () => void;
  let uploadStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    uploadStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let observedSignal: AbortSignal | undefined;
  onUpload = async (input) => {
    observedSignal = input.signal;
    uploadStarted();
    await blocked;
  };

  const republish = makeWriter().completeArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    signal: controller.signal,
    spec: spec({
      attachments: [
        {
          fileName: "a-cat-v2.png",
          contentType: "image/png",
          bytes: new Uint8Array(8),
          role: "primary",
        },
      ],
    }),
  });
  await started;
  controller.abort(abortReason);
  releaseUpload();

  await assert.rejects(republish, (error: unknown) => error === abortReason);
  assert.equal(observedSignal, controller.signal);
  assert.deepEqual(completed, []);
  assert.equal(currentVersionNo, 1);
  assert.deepEqual(deletedKeys, [
    "workspaces/workspace-1/artifacts/artifact-1/a-cat-v2.png",
  ]);
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

test("completeArtifact stores a thumbnail the caller already uploaded", async () => {
  await makeWriter().completeArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    spec: spec({ artifactType: "video_presentation" }),
    storedPreview: {
      storageKey: "workspaces/workspace-1/artifacts/artifact-1/cover.jpg",
      metadata: { fileName: "cover.jpg", mimeType: "image/jpeg" },
    },
  });

  // No bytes to upload — the producer uploaded them mid-run, which is the whole
  // reason the pointer form exists — so the pointer must still reach the row.
  assert.deepEqual(uploads, []);
  assert.equal(
    completed[0]?.previewStorageKey,
    "workspaces/workspace-1/artifacts/artifact-1/cover.jpg",
  );
  assert.deepEqual(completed[0]?.previewMetadata, {
    fileName: "cover.jpg",
    mimeType: "image/jpeg",
  });
});

test("a spec's own preview bytes win over a caller-uploaded pointer", async () => {
  await makeWriter().completeArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    spec: spec({
      artifactType: "video_presentation",
      preview: {
        bytes: new Uint8Array(4),
        contentType: "image/png",
        fileName: "preview.png",
      },
    }),
    storedPreview: {
      storageKey: "workspaces/workspace-1/artifacts/artifact-1/cover.jpg",
      metadata: { fileName: "cover.jpg", mimeType: "image/jpeg" },
    },
  });

  // One preview reaches the row, never a key from one source with metadata from
  // the other — which is what describes an object that is not there.
  assert.equal(
    completed[0]?.previewStorageKey,
    "workspaces/workspace-1/artifacts/artifact-1/preview.png",
  );
  assert.equal(
    (completed[0]?.previewMetadata as { fileName?: string })?.fileName,
    "preview.png",
  );
});

test("completeArtifact keeps the existing thumbnail when neither form is given", async () => {
  await makeWriter().completeArtifact({
    artifactId: "artifact-1",
    context: CONTEXT,
    spec: spec({ artifactType: "video_presentation" }),
  });

  // Omitted rather than null: null would clear a thumbnail the artifact has.
  assert.equal("previewStorageKey" in (completed[0] ?? {}), false);
  assert.equal("previewMetadata" in (completed[0] ?? {}), false);
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
      code: "ARTIFACT_STORAGE_UNAVAILABLE",
    }),
  });
  assert.equal(failed[0]?.errorCode, "ARTIFACT_STORAGE_UNAVAILABLE");
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

/* ========================================================================== */
/* 9. Definite failure cleanup and uncertain commit retention                 */
/* ========================================================================== */

function writeWithFiles() {
  return spec({
    ...IDEMPOTENT,
    attachments: [
      {
        fileName: "attempt-primary.png",
        contentType: "image/png",
        bytes: new Uint8Array(4),
        role: "primary",
      },
      {
        fileName: "attempt-extra.png",
        contentType: "image/png",
        bytes: new Uint8Array(2),
      },
    ],
    preview: {
      fileName: "attempt-preview.jpg",
      contentType: "image/jpeg",
      bytes: new Uint8Array(3),
    },
  });
}

function attemptedKeys(artifactId = "artifact-1") {
  return [
    "attempt-primary.png",
    "attempt-extra.png",
    "attempt-preview.jpg",
  ].map((name) => `workspaces/workspace-1/artifacts/${artifactId}/${name}`);
}

function assertCleanupDiagnostics(keys: string[]) {
  const metadata = [
    ...diagnostics.warn.mock.calls,
    ...diagnostics.error.mock.calls,
  ]
    .flat()
    .filter((value): value is { failedKeys: string[] } =>
      Boolean(
        value && typeof value === "object" && Array.isArray(value.failedKeys),
      ),
    );
  assert.ok(
    metadata.some((value) =>
      keys.every((key) => value.failedKeys.includes(key)),
    ),
    "cleanup diagnostics must identify the failed keys",
  );
}

test("a definite completion CAS loss deletes only this attempt's objects, never the stored preview", async () => {
  markReadyResult = null;
  const winnerPreview =
    "workspaces/workspace-1/artifacts/artifact-1/winner-preview.jpg";
  await assert.rejects(
    makeWriter().completeArtifact({
      artifactId: "artifact-1",
      context: CONTEXT,
      spec: writeWithFiles(),
      expectedVersionNo: 1,
      storedPreview: {
        storageKey: winnerPreview,
        metadata: { role: "existing" },
      },
    }),
    (error: Error & { code?: string }) =>
      error.code === ARTIFACT_WRITE_ERROR_CODES.stateConflict,
  );
  assert.deepEqual(deletedKeys, attemptedKeys());
  assert.equal(deletedKeys.includes(winnerPreview), false);
  assert.equal(currentVersionNo, 1);
  assert.deepEqual(
    referenceLookups,
    [],
    "a definite CAS refusal does not need uncertain-commit reconciliation",
  );
});

test("cleanup failure cannot replace a definite completion conflict and records failed keys", async () => {
  markReadyResult = null;
  deleteError = new Error("object delete denied");
  await assert.rejects(
    makeWriter().completeArtifact({
      artifactId: "artifact-1",
      context: CONTEXT,
      spec: writeWithFiles(),
    }),
    (error: Error & { code?: string; recoverable?: boolean }) => {
      assert.equal(error.code, ARTIFACT_WRITE_ERROR_CODES.stateConflict);
      assert.equal(error.recoverable, false);
      return true;
    },
  );
  assert.deepEqual(deletedKeys, attemptedKeys());
  assertCleanupDiagnostics(attemptedKeys());
});

test("a payload-only CAS loss does not delete a caller-owned stored preview", async () => {
  markReadyResult = null;
  await assert.rejects(
    makeWriter().completeArtifact({
      artifactId: "artifact-1",
      context: CONTEXT,
      spec: spec(),
      storedPreview: { storageKey: "already-uploaded-preview", metadata: {} },
    }),
    (error: Error & { code?: string }) =>
      error.code === ARTIFACT_WRITE_ERROR_CODES.stateConflict,
  );
  assert.deepEqual(uploads, []);
  assert.deepEqual(deletedKeys, []);
});

test("a locked publish conflict cleans its attempted bytes and preserves the original conflict", async () => {
  const conflict = new ArtifactError({
    code: ARTIFACT_WRITE_ERROR_CODES.stateConflict,
    message: "same request is still running",
  });
  createReadyError = conflict;
  await assert.rejects(
    makeWriter().publishArtifact({ context: CONTEXT, spec: writeWithFiles() }),
    (error) => error === conflict,
  );
  assert.deepEqual(deletedKeys, attemptedKeys());
  assert.deepEqual(referenceLookups, []);
});

test.each([
  ["publish", "referenced"],
  ["publish", "not_found"],
  ["publish", "read_failed"],
  ["complete", "referenced"],
  ["complete", "not_found"],
  ["complete", "read_failed"],
] as const)(
  "%s with an unknown database outcome retains objects when reconciliation is %s",
  async (lifecycle, referenceOutcome) => {
    const commitError = new Error("database commit response lost");
    if (lifecycle === "publish") createReadyError = commitError;
    else markReadyError = commitError;
    if (referenceOutcome === "referenced") {
      writeReferences = {
        artifactExists: true,
        currentVersionNo: 2,
        hasVersions: true,
        referencedKeys: attemptedKeys(),
      };
    } else if (referenceOutcome === "read_failed") {
      referenceError = new Error("database reference lookup unavailable");
    }
    const writer = makeWriter();
    await assert.rejects(
      lifecycle === "publish"
        ? writer.publishArtifact({ context: CONTEXT, spec: writeWithFiles() })
        : writer.completeArtifact({
            artifactId: "artifact-1",
            context: CONTEXT,
            spec: writeWithFiles(),
            expectedVersionNo: 1,
          }),
      (error: Error & { code?: string; cause?: unknown }) => {
        assert.equal(error.code, ARTIFACT_WRITE_ERROR_CODES.recordUnavailable);
        assert.equal(error.message, commitError.message);
        assert.strictEqual(error.cause, commitError);
        return true;
      },
    );
    assert.deepEqual(
      uploads.map((upload) => upload.key),
      attemptedKeys(),
    );
    assert.deepEqual(
      deletedKeys,
      [],
      "even an empty read cannot prove the original transaction rolled back",
    );
    assert.deepEqual(referenceLookups, [
      {
        artifactId: "artifact-1",
        teamId: CONTEXT.teamId,
        workspaceId: CONTEXT.workspaceId,
        keys: attemptedKeys(),
      },
    ]);
  },
);

test("a publish race loser cleans its own upload and returns the actual committed winner", async () => {
  readyWinner = {
    artifactId: "artifact-winner",
    versionId: "winner-version",
    reused: true,
  };
  const result = await makeWriter().publishArtifact({
    artifactId: "artifact-loser",
    context: CONTEXT,
    spec: writeWithFiles(),
  });
  assert.deepEqual(result, readyWinner);
  assert.equal(created[0]?.artifactId, "artifact-loser");
  assert.deepEqual(deletedKeys, attemptedKeys("artifact-loser"));
  assert.ok(deletedKeys.every((key) => !key.includes("artifact-winner")));
  assert.equal(referenceLookups.length, 0);
});

test("a reused publication does not report success if its unique uploaded objects could not be cleaned", async () => {
  readyWinner = {
    artifactId: "artifact-winner",
    versionId: "winner-version",
    reused: true,
  };
  deleteError = new Error("cleanup was refused");
  await assert.rejects(
    makeWriter().publishArtifact({
      artifactId: "artifact-loser",
      context: CONTEXT,
      spec: writeWithFiles(),
    }),
    (error: Error & { code?: string; recoverable?: boolean }) => {
      assert.equal(error.code, ARTIFACT_WRITE_ERROR_CODES.storageUnavailable);
      assert.equal(error.recoverable, false);
      return true;
    },
  );
  assert.deepEqual(deletedKeys, attemptedKeys("artifact-loser"));
  assertCleanupDiagnostics(attemptedKeys("artifact-loser"));
});

test("a race winner keeps all successfully committed objects", async () => {
  const result = await makeWriter().publishArtifact({
    context: CONTEXT,
    spec: writeWithFiles(),
  });
  assert.equal(result.reused, false);
  assert.deepEqual(
    uploads.map((upload) => upload.key),
    attemptedKeys(),
  );
  assert.deepEqual(deletedKeys, []);
  assert.deepEqual(referenceLookups, []);
});

test("open returns the repository's reused pending winner instead of its preallocated loser id", async () => {
  pendingWinner = { artifactId: "pending-winner", reused: true };
  const result = await makeWriter().openArtifact({
    artifactId: "pending-loser",
    context: CONTEXT,
    spec: spec(IDEMPOTENT),
  });
  assert.deepEqual(result, pendingWinner);
  assert.equal(pending[0]?.artifactId, "pending-loser");
  assert.deepEqual(uploads, []);
  assert.deepEqual(deletedKeys, []);
});

test("fast reuse lookups carry actor and thread identity for private visibility checks", async () => {
  const writer = makeWriter();
  await writer.publishArtifact({ context: CONTEXT, spec: spec(IDEMPOTENT) });
  await writer.openArtifact({ context: CONTEXT, spec: spec(IDEMPOTENT) });
  assert.equal(requestKeyLookups.length, 2);
  for (const lookup of requestKeyLookups) {
    assert.equal(lookup.userId, CONTEXT.userId);
    assert.equal(lookup.threadId, CONTEXT.threadId);
    assert.equal(lookup.teamId, CONTEXT.teamId);
    assert.equal(lookup.workspaceId, CONTEXT.workspaceId);
  }
});

test("upload failure remains primary when cleanup also fails", async () => {
  uploadError = new Error("the upload was refused");
  deleteError = new Error("cleanup was refused");
  await assert.rejects(
    makeWriter().publishArtifact({ context: CONTEXT, spec: writeWithFiles() }),
    (error: Error & { code?: string; cause?: unknown }) => {
      assert.equal(error.code, ARTIFACT_WRITE_ERROR_CODES.storageUnavailable);
      assert.strictEqual(error.cause, uploadError);
      return true;
    },
  );
  assert.deepEqual(deletedKeys, [attemptedKeys()[0]]);
  assert.deepEqual(created, []);
  assertCleanupDiagnostics([attemptedKeys()[0]!]);
});

test("an upload-time abort remains primary when cleanup also fails", async () => {
  const controller = new AbortController();
  const abortReason = new DOMException(
    "user stopped publication",
    "AbortError",
  );
  deleteError = new Error("cleanup was refused");
  onUpload = () => {
    controller.abort(abortReason);
  };
  await assert.rejects(
    makeWriter().publishArtifact({
      context: CONTEXT,
      spec: writeWithFiles(),
      signal: controller.signal,
    }),
    (error) => error === abortReason,
  );
  assert.deepEqual(deletedKeys, [attemptedKeys()[0]]);
  assert.deepEqual(created, []);
  assertCleanupDiagnostics([attemptedKeys()[0]!]);
});

test.each(["publish", "complete"] as const)(
  "%s preserves a pre-commit abort even if cleanup fails",
  async (lifecycle) => {
    const controller = new AbortController();
    const abortReason = new DOMException("stop before commit", "AbortError");
    deleteError = new Error("cleanup was refused");
    // Primary bucket lookup is after the last upload's abort check. This makes
    // cancellation win after preparation but before the repository call.
    const writer = createArtifactWriter({
      storage: {
        ...storage,
        getBucketName: () => {
          controller.abort(abortReason);
          return "content-bucket";
        },
      },
      repository,
      newArtifactId: () => "artifact-1",
    });
    const input = {
      context: CONTEXT,
      signal: controller.signal,
      spec: spec({
        attachments: [
          {
            fileName: "prepared.png",
            contentType: "image/png",
            bytes: new Uint8Array(4),
            role: "primary",
          },
        ],
      }),
    };
    await assert.rejects(
      lifecycle === "publish"
        ? writer.publishArtifact(input)
        : writer.completeArtifact({ ...input, artifactId: "artifact-1" }),
      (error) => error === abortReason,
    );
    assert.equal(uploads.length, 1);
    assert.deepEqual(created, []);
    assert.deepEqual(completed, []);
    assert.deepEqual(deletedKeys, [
      "workspaces/workspace-1/artifacts/artifact-1/prepared.png",
    ]);
    assertCleanupDiagnostics(deletedKeys);
  },
);
