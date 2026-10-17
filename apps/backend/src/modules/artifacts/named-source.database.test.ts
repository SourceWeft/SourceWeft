import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import type { ArtifactPublishSpec } from "@sourceweft/contracts/artifact-write";

let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let db: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let service: typeof import("./service").contentArtifactsService;
let writer: import("./writer").ArtifactWriter;
const objects = new Map<string, Uint8Array>();
const context = {
  teamId: randomUUID(),
  workspaceId: randomUUID(),
  threadId: randomUUID(),
  userId: randomUUID(),
};
const otherUserId = randomUUID();
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("named_sources");
  process.env.DATABASE_URL = isolated.url;
  db = await import("@sourceweft/db");
  repository = await import("./repository");
  const storage = await import("../sources/storage");
  const { ArtifactWriter } = await import("./writer");
  ({ contentArtifactsService: service } = await import("./service"));
  const memoryStorage: ArtifactStorage = {
    getBucketName: () => "named-source-test",
    buildArtifactStorageKey: storage.buildArtifactStorageKey,
    upload: async ({ key, body }) => {
      objects.set(key, new Uint8Array(body));
    },
    download: async ({ key }) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Test object not found");
      return { body: bytes, contentType: "application/octet-stream" };
    },
    delete: async ({ key }) => {
      objects.delete(key);
    },
  };
  writer = new ArtifactWriter({
    storage: memoryStorage,
    repository: {
      createReady: repository.createReadyArtifactRecord,
      createPending: repository.createPendingArtifactRecord,
      markReady: repository.markArtifactReady,
      markFailed: repository.markArtifactFailed,
      findByRequestKey: repository.findArtifactRecordByRequestKey,
      findWriteReferences: repository.findArtifactWriteReferences,
    },
  });
  await db.database.query(
    'insert into organization (id,name,slug,"createdAt") values ($1,$1,$1,now())',
    [context.teamId],
  );
  await db.db.insert(db.workspaces).values({
    id: context.workspaceId,
    organizationId: context.teamId,
    name: "Named source versions",
    slug: context.workspaceId,
  });
  for (const userId of [context.userId, otherUserId]) {
    await db.database.query(
      'insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())',
      [userId, `${userId}@example.test`],
    );
    await db.db.insert(db.workspaceMemberships).values({
      workspaceId: context.workspaceId,
      userId,
      role: "editor",
      source: "guest",
    });
  }
  await db.db.insert(db.threads).values({
    id: context.threadId,
    teamId: context.teamId,
    workspaceId: context.workspaceId,
    createdBy: context.userId,
    visibility: "private",
    title: "Private authoring source",
  });
}, 120_000);

// The shared test setup restores spies after each test. Install the same
// memory-object reader for every case while exercising real PostgreSQL below.
beforeEach(async () => {
  const storage = await import("../sources/storage");
  vi.spyOn(storage, "downloadFileObject").mockImplementation(
    async ({ key, maxBytes, signal }) => {
      signal?.throwIfAborted();
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Test object not found");
      if (bytes.byteLength > maxBytes)
        throw new Error("FILE_TOO_LARGE: test object exceeds limit");
      return Buffer.from(bytes);
    },
  );
});

afterAll(async () => {
  if (db) await db.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function spec(label: string): ArtifactPublishSpec {
  return {
    artifactType: "file",
    title: "Versioned report",
    payload: { fileName: "report.md", mimeType: "text/markdown" },
    attachments: [
      {
        fileName: "report.md",
        contentType: "text/markdown",
        bytes: Buffer.from(`# ${label}`),
        role: "primary",
      },
      {
        fileName: "report.source.json",
        contentType: "application/json",
        bytes: Buffer.from(JSON.stringify({ label })),
        role: "source",
        access: "private",
      },
      {
        fileName: "private-notes.txt",
        contentType: "text/plain",
        bytes: Buffer.from(label),
        role: "asset",
        access: "private",
      },
    ],
  };
}
function namedRequest(artifactId: string, artifactVersionId: string) {
  return {
    workspaceId: context.workspaceId,
    userId: context.userId,
    artifactId,
    artifactVersionId,
    fileName: "report.source.json",
    maxBytes: 1024,
  };
}

test("private sources restore the named immutable version, stay off public readers and retain CAS preconditions", async () => {
  const first = await writer.publishArtifact({ context, spec: spec("one") });
  const second = await writer.completeArtifact({
    context,
    artifactId: first.artifactId,
    expectedVersionNo: 1,
    expectedStatuses: ["ready"],
    spec: spec("two"),
  });
  assert.notEqual(first.versionId, second.versionId);
  for (const [versionId, label, versionNo] of [
    [first.versionId, "one", 1],
    [second.versionId, "two", 2],
  ] as const) {
    const request = namedRequest(first.artifactId, versionId);
    const restored = await service.readArtifactVersionAttachment(request);
    assert.deepEqual(JSON.parse(Buffer.from(restored.bytes).toString()), {
      label,
    });
    assert.equal(restored.artifactVersionId, versionId);
    assert.equal(restored.versionNo, versionNo);
    assert.equal(restored.fileName, "report.source.json");
    assert.equal(
      restored.contentDigest,
      `sha256:${createHash("sha256").update(restored.bytes).digest("hex")}`,
    );
    assert.doesNotMatch(
      JSON.stringify({ ...restored, bytes: undefined }),
      /storageKey|storageBucket/,
    );
    await assert.rejects(
      service.getArtifactVersionFile({
        ...request,
        resource: { kind: "asset", fileName: request.fileName },
      }),
    );
    const privateAsset = await service.readArtifactVersionAttachment({
      ...request,
      fileName: "private-notes.txt",
    });
    assert.equal(Buffer.from(privateAsset.bytes).toString(), label);
    await assert.rejects(
      service.readArtifactVersionAttachment({
        ...request,
        userId: otherUserId,
      }),
    );
    await assert.rejects(
      service.readArtifactVersionAttachment({ ...request, maxBytes: 1 }),
    );
  }
  await assert.rejects(
    writer.completeArtifact({
      context,
      artifactId: first.artifactId,
      expectedVersionNo: 1,
      expectedStatuses: ["ready"],
      spec: spec("stale edit"),
    }),
  );
  const current = await repository.findCurrentReadyArtifactVersionRecord({
    ...context,
    artifactId: first.artifactId,
    expectedArtifactType: "file",
  });
  assert.equal(current?.versionId, second.versionId);
});

test("workspace authoring access rechecks membership, artifact/version identity and manifest integrity", async () => {
  const first = await writer.publishArtifact({ context, spec: spec("shared") });
  const unrelated = await writer.publishArtifact({
    context,
    spec: spec("other artifact"),
  });
  await db.db
    .update(db.artifacts)
    .set({ visibility: "workspace" })
    .where(eq(db.artifacts.id, first.artifactId));
  const request = namedRequest(first.artifactId, first.versionId);
  assert.ok(
    (
      await service.readArtifactVersionAttachment({
        ...request,
        userId: otherUserId,
      })
    ).bytes.length > 0,
  );
  await assert.rejects(
    service.readArtifactVersionAttachment({
      ...request,
      artifactVersionId: unrelated.versionId,
    }),
  );
  await assert.rejects(
    service.readArtifactVersionAttachment({
      ...request,
      workspaceId: randomUUID(),
    }),
  );
  await db.db
    .delete(db.workspaceMemberships)
    .where(
      and(
        eq(db.workspaceMemberships.workspaceId, context.workspaceId),
        eq(db.workspaceMemberships.userId, otherUserId),
      ),
    );
  try {
    await assert.rejects(
      service.readArtifactVersionAttachment({
        ...request,
        userId: otherUserId,
      }),
    );
  } finally {
    await db.db.insert(db.workspaceMemberships).values({
      workspaceId: context.workspaceId,
      userId: otherUserId,
      role: "editor",
      source: "guest",
    });
  }
  const version = await repository.findReadyArtifactVersionRecord({
    ...context,
    artifactId: first.artifactId,
    artifactVersionId: first.versionId,
  });
  const file = version!.filesJson!.files.find(
    (file) => file.fileName === request.fileName,
  )!;
  objects.set(file.storageKey, Buffer.from("tampered private authoring"));
  await assert.rejects(
    service.readArtifactVersionAttachment(request),
    (error: unknown) =>
      (error as { code: string }).code === "ARTIFACT_FILE_INTEGRITY_MISMATCH",
  );
  await db.db
    .update(db.artifactVersions)
    .set({ filesJson: null })
    .where(eq(db.artifactVersions.id, first.versionId));
  await assert.rejects(
    service.readArtifactVersionAttachment(request),
    (error: unknown) =>
      (error as { code: string }).code === "ARTIFACT_VERSION_FILE_NOT_FOUND",
  );
});

test("member source-file reads serve the private report source to viewers only and never other manifest entries", async () => {
  const published = await writer.publishArtifact({
    context,
    spec: spec("member read"),
  });
  const request = {
    workspaceId: context.workspaceId,
    userId: context.userId,
    artifactId: published.artifactId,
    artifactVersionId: published.versionId,
    fileName: "report.source.json",
  };
  const fileNotFound = (error: unknown) =>
    (error as { statusCode: number; code: string }).statusCode === 404 &&
    (error as { code: string }).code === "ARTIFACT_VERSION_FILE_NOT_FOUND";
  const notFound = (error: unknown) =>
    (error as { statusCode: number }).statusCode === 404;

  const read = await service.readArtifactVersionSourceFile(request);
  assert.deepEqual(JSON.parse(Buffer.from(read.bytes).toString()), {
    label: "member read",
  });
  assert.equal(read.artifactVersionId, published.versionId);
  assert.equal(read.fileName, "report.source.json");
  assert.doesNotMatch(
    JSON.stringify({ ...read, bytes: undefined }),
    /storageKey|storageBucket/,
  );

  // Private artifact: another workspace member is not a viewer yet.
  await assert.rejects(
    service.readArtifactVersionSourceFile({ ...request, userId: otherUserId }),
    notFound,
  );
  await db.db
    .update(db.artifacts)
    .set({ visibility: "workspace" })
    .where(eq(db.artifacts.id, published.artifactId));
  assert.ok(
    (
      await service.readArtifactVersionSourceFile({
        ...request,
        userId: otherUserId,
      })
    ).bytes.length > 0,
  );
  // Non-members and other workspaces stay out.
  await assert.rejects(
    service.readArtifactVersionSourceFile({
      ...request,
      userId: randomUUID(),
    }),
    notFound,
  );
  await assert.rejects(
    service.readArtifactVersionSourceFile({
      ...request,
      workspaceId: randomUUID(),
    }),
    notFound,
  );
  // Other manifest entries are invisible through this reader, including the
  // private asset the host-only attachment reader can still recover.
  for (const fileName of ["private-notes.txt", "report.md", "missing.json"]) {
    await assert.rejects(
      service.readArtifactVersionSourceFile({ ...request, fileName }),
      fileNotFound,
      fileName,
    );
  }
  assert.equal(
    Buffer.from(
      (
        await service.readArtifactVersionAttachment({
          ...request,
          fileName: "private-notes.txt",
          maxBytes: 1024,
        })
      ).bytes,
    ).toString(),
    "member read",
  );
  // Tampered storage is refused, not served.
  const version = await repository.findReadyArtifactVersionRecord({
    ...context,
    artifactId: published.artifactId,
    artifactVersionId: published.versionId,
  });
  const file = version!.filesJson!.files.find(
    (file) => file.fileName === request.fileName,
  )!;
  objects.set(file.storageKey, Buffer.from("tampered member source"));
  await assert.rejects(
    service.readArtifactVersionSourceFile(request),
    (error: unknown) =>
      (error as { code: string }).code === "ARTIFACT_FILE_INTEGRITY_MISMATCH",
  );
});
