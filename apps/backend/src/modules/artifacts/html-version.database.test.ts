import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
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
  isolated = await createIsolatedTestDatabase("html_versions");
  process.env.DATABASE_URL = isolated.url;
  db = await import("@sourceweft/db");
  repository = await import("./repository");
  const storage = await import("../sources/storage");
  vi.spyOn(storage, "downloadArtifactObject").mockImplementation(
    async ({ key }) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Test object not found");
      return Buffer.from(bytes);
    },
  );
  const { ArtifactWriter } = await import("./writer");
  ({ contentArtifactsService: service } = await import("./service"));
  const memoryStorage: ArtifactStorage = {
    getBucketName: () => "html-test",
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
    name: "HTML versions",
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
    title: "Private HTML",
  });
}, 120_000);

afterAll(async () => {
  if (db) await db.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function spec(text: string): ArtifactPublishSpec {
  const bytes = Buffer.from(
    `<html><head><meta charset="utf-8"></head><body>${text}</body></html>`,
  );
  return {
    artifactType: "html",
    title: "Versioned HTML",
    payload: {
      schemaVersion: 1,
      fileName: "index.html",
      mimeType: "text/html",
      byteLength: bytes.length,
      contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      metadata: { schemaVersion: 1 },
      validation: {
        policyVersion: "html/1",
        checks: ["utf8", "document", "resources", "metadata", "size"],
      },
    },
    attachments: [
      {
        fileName: "index.html",
        contentType: "text/html",
        bytes,
        role: "primary",
      },
      {
        fileName: "authoring.json",
        contentType: "application/json",
        bytes: Buffer.from('{"private":true}'),
        role: "source",
      },
    ],
  };
}

test("migrated HTML versions retain their own files, reject stale writes and enforce private reads", async () => {
  const first = await writer.publishArtifact({ context, spec: spec("one") });
  const second = await writer.completeArtifact({
    context,
    artifactId: first.artifactId,
    expectedVersionNo: 1,
    expectedStatuses: ["ready"],
    spec: spec("two"),
  });
  assert.notEqual(first.versionId, second.versionId);
  const firstRecord = await repository.findReadyArtifactVersionRecord({
    ...context,
    artifactId: first.artifactId,
    artifactVersionId: first.versionId,
  });
  const secondRecord = await repository.findReadyArtifactVersionRecord({
    ...context,
    artifactId: first.artifactId,
    artifactVersionId: second.versionId,
  });
  assert.notEqual(
    firstRecord?.filesJson?.files[0]?.storageKey,
    secondRecord?.filesJson?.files[0]?.storageKey,
  );
  for (const [artifactVersionId, text] of [
    [first.versionId, "one"],
    [second.versionId, "two"],
  ]) {
    const result = await service.getArtifactVersionFile({
      ...context,
      artifactId: first.artifactId,
      artifactVersionId: artifactVersionId!,
      resource: { kind: "file" },
    });
    assert.equal(
      Buffer.from(result.body).toString(),
      `<html><head><meta charset="utf-8"></head><body>${text}</body></html>`,
    );
  }
  await assert.rejects(
    service.getArtifactVersionFile({
      ...context,
      userId: otherUserId,
      artifactId: first.artifactId,
      artifactVersionId: first.versionId,
      resource: { kind: "file" },
    }),
  );
  await assert.rejects(
    service.getArtifactVersionFile({
      ...context,
      artifactId: first.artifactId,
      artifactVersionId: first.versionId,
      resource: { kind: "asset", fileName: "authoring.json" },
    }),
  );
  await assert.rejects(
    writer.completeArtifact({
      context,
      artifactId: first.artifactId,
      expectedVersionNo: 1,
      expectedStatuses: ["ready"],
      spec: spec("stale"),
    }),
  );
  const current = await repository.findCurrentReadyArtifactVersionRecord({
    ...context,
    artifactId: first.artifactId,
    expectedArtifactType: "html",
  });
  assert.equal(current?.versionId, second.versionId);
  const listed = await service.listArtifacts({
    workspaceId: context.workspaceId,
    userId: context.userId,
  });
  const projected = listed.items.find((item) => item.id === first.artifactId)!;
  assert.equal(projected.artifactVersionId, second.versionId);
  assert.equal(projected.storageKey, null);
  assert.ok("versionFiles" in projected.payloadJson);
  assert.ok(Array.isArray(projected.payloadJson.versionFiles));
  assert.doesNotMatch(
    JSON.stringify(projected.payloadJson),
    /storageKey|storageBucket|authoring.json/,
  );
  assert.equal(objects.size, 4, "losing write cleans only its own uploads");
}, 30_000);
