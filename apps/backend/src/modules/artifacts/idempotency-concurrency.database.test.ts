import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import type { ArtifactStorage } from "@sourceweft/contracts/artifact-storage";
import type { ArtifactPublishSpec } from "@sourceweft/contracts/artifact-write";

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./repository");
let publication: typeof import("./current-run-publication-repository");
let ArtifactWriter: typeof import("./writer").ArtifactWriter;
let buildArtifactStorageKey: typeof import("../sources/storage").buildArtifactStorageKey;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let teamId: string;
let workspaceId: string;
let threadId: string;
let userId: string;
let otherUserId: string;
let requestKey: string;

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("artifact_keys");
  process.env.DATABASE_URL = isolated.url;
  schema = await import("@sourceweft/db");
  repository = await import("./repository");
  publication = await import("./current-run-publication-repository");
  ({ ArtifactWriter } = await import("./writer"));
  ({ buildArtifactStorageKey } = await import("../sources/storage"));
}, 120_000);

beforeEach(async () => {
  [teamId, workspaceId, userId, otherUserId, requestKey] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await schema.database.query(
    'insert into organization (id, name, slug, "createdAt") values ($1,$1,$1,now())',
    [teamId],
  );
  await schema.db.insert(schema.workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Artifact idempotency",
    slug: workspaceId,
  });
  for (const actor of [userId, otherUserId]) {
    await schema.database.query(
      'insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1,$1,$2,true,now(),now())',
      [actor, `${actor}@example.test`],
    );
    await schema.db
      .insert(schema.workspaceMemberships)
      .values({ workspaceId, userId: actor, role: "editor", source: "guest" });
  }
  threadId = await createThread();
});

afterEach(async () => {
  if (!schema) return;
  await schema.db
    .delete(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  await schema.database.query("delete from organization where id = $1", [
    teamId,
  ]);
  await schema.database.query('delete from "user" where id = any($1::text[])', [
    [userId, otherUserId],
  ]);
});
afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function createThread(
  visibility: "private" | "workspace" = "workspace",
  creator = userId,
) {
  const id = randomUUID();
  await schema.db.insert(schema.threads).values({
    id,
    teamId,
    workspaceId,
    title: "Artifact thread",
    visibility,
    createdBy: creator,
  });
  return id;
}
function input(
  overrides: Partial<
    Parameters<typeof repository.createReadyArtifactRecord>[0]
  > = {},
) {
  return {
    artifactId: randomUUID(),
    artifactType: "image" as const,
    teamId,
    workspaceId,
    threadId,
    userId,
    requestKey,
    title: "Test image",
    prompt: "Test image",
    payload: { image: "data" },
    ...overrides,
  };
}
async function records() {
  return {
    artifacts: await schema.db.select().from(schema.artifacts),
    versions: await schema.db.select().from(schema.artifactVersions),
  };
}
async function waitForBlockedQuery(pattern: string, count = 1) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await schema.database.query(
      "select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like $1",
      [pattern],
    );
    if (Number(result.rows[0]?.count) >= count) return;
    await delay(10);
  }
  throw new Error(
    "Expected concurrent artifact writers to wait for their real PostgreSQL lock",
  );
}

/** Hold the exact pre-existing current-run key domain, then release two writers. */
async function concurrent<T, U>(
  first: () => Promise<T>,
  second: () => Promise<U>,
) {
  const connection = await schema.database.connect();
  const key = [teamId, workspaceId, "image", requestKey].join("\u001f");
  let a: Promise<T> | undefined;
  let b: Promise<U> | undefined;
  try {
    await connection.query("begin");
    await connection.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
    a = first();
    await waitForBlockedQuery("%pg_advisory_xact_lock%", 1);
    b = second();
    await waitForBlockedQuery("%pg_advisory_xact_lock%", 2);
    await connection.query("commit");
    return await Promise.all([a, b]);
  } finally {
    await connection.query("rollback");
    connection.release();
    await Promise.allSettled([a, b].filter((value) => value !== undefined));
  }
}

async function runInput() {
  const id = randomUUID();
  const messageId = randomUUID();
  const sourceToolCallId = randomUUID();
  await schema.db.insert(schema.messages).values({
    id: messageId,
    teamId,
    workspaceId,
    threadId,
    role: "assistant",
    content: "",
    metadata: {},
  });
  await schema.db.insert(schema.chatThreadRuns).values({
    id,
    teamId,
    workspaceId,
    threadId,
    userId,
    assistantMessageId: messageId,
    idempotencyKey: randomUUID(),
    mode: "send",
    streamKey: `test:${id}`,
    status: "running",
    requestJson: {},
    snapshotJson: {},
  });
  return {
    context: {
      actorUserId: userId,
      producer: { kind: "main" as const },
      runId: id,
      sourceToolCallId,
      sourceToolName: "publish_artifact",
      teamId,
      workspaceId,
    },
    artifact: {
      artifactType: "image",
      mode: { kind: "create" as const },
      payload: { image: "current-run" },
      title: "Test image",
      prompt: "Test image",
      workflowVersion: "test-v1",
      semanticRequestKey: requestKey,
    },
  };
}

test("generic open/open serializes on the existing current-run request lock and reuses pending", async () => {
  const [a, b] = await concurrent(
    () => repository.createPendingArtifactRecord(input()),
    () => repository.createPendingArtifactRecord(input()),
  );
  assert.equal(a.artifactId, b.artifactId);
  assert.deepEqual([a.reused, b.reused], [false, true]);
  const stored = await records();
  assert.equal(stored.artifacts.length, 1);
  assert.equal(stored.versions.length, 0);
});

test("generic publish/publish serializes and returns the committed winner ID and version", async () => {
  const [a, b] = await concurrent(
    () => repository.createReadyArtifactRecord(input()),
    () => repository.createReadyArtifactRecord(input()),
  );
  assert.equal(a.artifactId, b.artifactId);
  assert.equal(a.versionId, b.versionId);
  assert.deepEqual([a.reused, b.reused], [false, true]);
  const stored = await records();
  assert.equal(stored.artifacts.length, 1);
  assert.equal(stored.versions.length, 1);
});

for (const sharedId of [false, true]) {
  test(`actual writers with ${sharedId ? "the same preallocated" : "distinct"} artifact IDs clean only their losing uploads after a real database race`, async () => {
    const objects = new Map<
      string,
      { body: Uint8Array; contentType: string }
    >();
    const uploads: Array<{ key: string; marker: number }> = [];
    const deleted: string[] = [];
    let signalBothUploaded!: () => void;
    let releaseUploads!: () => void;
    const bothUploaded = new Promise<void>((resolve) => {
      signalBothUploaded = resolve;
    });
    const uploadsGate = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    const storage: ArtifactStorage = {
      // Use production key allocation: even a reused preallocated artifact ID
      // gives each physical upload a unique key, including assets/previews.
      buildArtifactStorageKey,
      getBucketName: () => "writer-integration",
      upload: async ({ key, body, contentType }) => {
        assert.equal(
          objects.has(key),
          false,
          "attempts must not overwrite one another's objects",
        );
        objects.set(key, { body: new Uint8Array(body), contentType });
        uploads.push({ key, marker: body[0]! });
        if (uploads.length === 2) signalBothUploaded();
        await uploadsGate;
      },
      delete: async ({ key }) => {
        const stored = await records();
        assert.equal(
          stored.artifacts.length,
          1,
          "cleanup follows the winning commit",
        );
        assert.notEqual(key, stored.artifacts[0]!.storageKey);
        assert.notEqual(key, stored.artifacts[0]!.previewStorageKey);
        assert.equal(objects.delete(key), true);
        deleted.push(key);
      },
      download: async ({ key }) => objects.get(key) ?? null,
    };
    const repo = {
      createReady: repository.createReadyArtifactRecord,
      createPending: repository.createPendingArtifactRecord,
      markReady: repository.markArtifactReady,
      markFailed: repository.markArtifactFailed,
      findByRequestKey: repository.findArtifactRecordByRequestKey,
      findWriteReferences: repository.findArtifactWriteReferences,
    };
    const firstId = randomUUID();
    const secondId = sharedId ? firstId : randomUUID();
    const context = { teamId, workspaceId, threadId, userId };
    const spec = (marker: number): ArtifactPublishSpec => ({
      artifactType: "image",
      title: "Real writer race",
      payload: { producer: marker },
      idempotency: { requestKey },
      attachments: [
        {
          fileName: "primary.png",
          contentType: "image/png",
          bytes: new Uint8Array([marker, 1]),
          role: "primary",
        },
        {
          fileName: "asset.json",
          contentType: "application/json",
          bytes: new Uint8Array([marker, 2]),
          role: "asset",
        },
      ],
      preview: {
        fileName: "preview.png",
        contentType: "image/png",
        bytes: new Uint8Array([marker, 3]),
      },
    });
    const a = new ArtifactWriter({
      repository: repo,
      storage,
      newArtifactId: () => firstId,
    });
    const b = new ArtifactWriter({
      repository: repo,
      storage,
      newArtifactId: () => secondId,
    });
    const connection = await schema.database.connect();
    const publishing = [
      a.publishArtifact({
        context,
        spec: spec(11),
        ...(sharedId ? { artifactId: firstId } : {}),
      }),
      b.publishArtifact({
        context,
        spec: spec(22),
        ...(sharedId ? { artifactId: secondId } : {}),
      }),
    ];
    try {
      // Both real preflights have missed before either writer can commit.
      await Promise.race([bothUploaded, Promise.all(publishing)]);
      assert.equal(uploads.length, 2);
      await connection.query("begin");
      await connection.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [[teamId, workspaceId, "image", requestKey].join("\u001f")],
      );
      releaseUploads();
      await waitForBlockedQuery("%pg_advisory_xact_lock%", 2);
      assert.equal(uploads.length, 6);
      await connection.query("commit");
      const results = await Promise.all(publishing);
      assert.deepEqual(results.map((result) => result.reused).sort(), [
        false,
        true,
      ]);
      assert.equal(results[0]!.artifactId, results[1]!.artifactId);
      assert.equal(results[0]!.versionId, results[1]!.versionId);
      const winner = results.findIndex((result) => !result.reused);
      const winnerMarker = winner === 0 ? 11 : 22;
      const winnerId = winner === 0 ? firstId : secondId;
      const winnerKeys = uploads
        .filter((upload) => upload.marker === winnerMarker)
        .map((upload) => upload.key);
      const loserKeys = uploads
        .filter((upload) => upload.marker !== winnerMarker)
        .map((upload) => upload.key);
      assert.equal(results[0]!.artifactId, winnerId);
      assert.deepEqual(deleted.sort(), loserKeys.sort());
      assert.deepEqual([...objects.keys()].sort(), winnerKeys.sort());
      const stored = await records();
      assert.equal(stored.artifacts.length, 1);
      assert.equal(stored.versions.length, 1);
      assert.equal(stored.artifacts[0]!.id, winnerId);
      assert.equal(stored.versions[0]!.artifactId, winnerId);
      assert.equal(stored.versions[0]!.id, results[0]!.versionId);
      assert.deepEqual(stored.artifacts[0]!.payloadJson, {
        producer: winnerMarker,
      });
      assert.deepEqual(stored.versions[0]!.contentJson, {
        producer: winnerMarker,
      });
      assert.equal(
        objects.get(stored.artifacts[0]!.storageKey!)?.body[0],
        winnerMarker,
      );
      assert.equal(
        objects.get(stored.artifacts[0]!.previewStorageKey!)?.body[0],
        winnerMarker,
      );
      const retried = await a.publishArtifact({ context, spec: spec(33) });
      assert.deepEqual(retried, {
        artifactId: winnerId,
        versionId: results[0]!.versionId,
        reused: true,
      });
      assert.equal(uploads.length, 6);
      assert.equal(deleted.length, 3);
      assert.deepEqual(await records(), stored);
    } finally {
      releaseUploads();
      await connection.query("rollback");
      connection.release();
      await Promise.allSettled(publishing);
    }
  });
}

for (const first of ["generic", "current-run"] as const) {
  test(`${first} publication serializes with the other entry point`, async () => {
    const currentRunInput = await runInput();
    const generic = () => repository.createReadyArtifactRecord(input());
    const currentRun = () =>
      publication.commitCurrentRunArtifactPublication(currentRunInput);
    const pair =
      first === "generic"
        ? await concurrent(generic, currentRun)
        : (await concurrent(currentRun, generic)).reverse();
    const a = pair[0] as Awaited<ReturnType<typeof generic>>;
    const b = pair[1] as Awaited<ReturnType<typeof currentRun>>;
    assert.equal(b.ok, true);
    assert.equal(a.artifactId, b.result.artifactId);
    assert.equal(a.versionId, b.result.artifactVersionId);
    assert.equal(Number(a.reused) + Number(b.reused), 1);
    const stored = await records();
    assert.equal(stored.artifacts.length, 1);
    assert.equal(stored.versions.length, 1);
  });
}

test("pending blocks generic and current-run publish with their explicit conflict contracts", async () => {
  const pending = await repository.createPendingArtifactRecord(input());
  await assert.rejects(
    repository.createReadyArtifactRecord(input()),
    (error: unknown) =>
      (error as { code?: string }).code === "ARTIFACT_STATE_CONFLICT",
  );
  const result = await publication.commitCurrentRunArtifactPublication(
    await runInput(),
  );
  assert.deepEqual(result, { ok: false, reason: "artifact_in_progress" });
  assert.equal((await records()).artifacts[0]?.id, pending.artifactId);
  assert.equal((await records()).versions.length, 0);
});

test("running is reusable by open but rejects one-shot publish; failed permits a new attempt", async () => {
  const first = await repository.createPendingArtifactRecord(input());
  await schema.db
    .update(schema.artifacts)
    .set({ status: "running" })
    .where(eq(schema.artifacts.id, first.artifactId));
  assert.deepEqual(await repository.createPendingArtifactRecord(input()), {
    artifactId: first.artifactId,
    reused: true,
  });
  await assert.rejects(
    repository.createReadyArtifactRecord(input()),
    (error: unknown) =>
      (error as { code?: string }).code === "ARTIFACT_STATE_CONFLICT",
  );
  await schema.db
    .update(schema.artifacts)
    .set({ status: "failed" })
    .where(eq(schema.artifacts.id, first.artifactId));
  const next = await repository.createReadyArtifactRecord(input());
  assert.equal(next.reused, false);
  assert.notEqual(next.artifactId, first.artifactId);
  assert.equal((await records()).artifacts.length, 2);
  assert.deepEqual(await repository.createPendingArtifactRecord(input()), {
    artifactId: next.artifactId,
    reused: true,
  });
});

test("same-user private and workspace requests with the same key create separate legitimate artifacts", async () => {
  const privateThread = await createThread("private");
  const [a, b] = await concurrent(
    () =>
      repository.createReadyArtifactRecord(input({ threadId: privateThread })),
    () => repository.createReadyArtifactRecord(input()),
  );
  assert.notEqual(a.artifactId, b.artifactId);
  assert.equal(a.reused || b.reused, false);
  for (const [destination, artifactId] of [
    [privateThread, a.artifactId],
    [threadId, b.artifactId],
  ]) {
    const found = await repository.findArtifactRecordByRequestKey({
      ...input(),
      threadId: destination!,
      requestKey,
      statuses: ["ready"],
    });
    assert.equal(found?.id, artifactId);
  }
});

test("different private creators never reuse or discover each other's key", async () => {
  const aThread = await createThread("private");
  const bThread = await createThread("private", otherUserId);
  const [a, b] = await concurrent(
    () => repository.createReadyArtifactRecord(input({ threadId: aThread })),
    () =>
      repository.createReadyArtifactRecord(
        input({ threadId: bThread, userId: otherUserId }),
      ),
  );
  assert.notEqual(a.artifactId, b.artifactId);
  assert.equal(
    (
      await repository.findArtifactRecordByRequestKey({
        ...input({ threadId: bThread, userId: otherUserId }),
        requestKey,
        statuses: ["ready"],
      })
    )?.id,
    b.artifactId,
  );
  // B is newer: an unscoped preflight would leak B's private artifact to A.
  assert.equal(
    (
      await repository.findArtifactRecordByRequestKey({
        ...input({ threadId: aThread }),
        requestKey,
        statuses: ["ready"],
      })
    )?.id,
    a.artifactId,
  );
  assert.equal((await records()).artifacts.length, 2);
});

test("workspace-visible requests can reuse across authorized members", async () => {
  const otherThread = await createThread("workspace", otherUserId);
  const [a, b] = await concurrent(
    () => repository.createReadyArtifactRecord(input()),
    () =>
      repository.createReadyArtifactRecord(
        input({ threadId: otherThread, userId: otherUserId }),
      ),
  );
  assert.equal(a.artifactId, b.artifactId);
  assert.equal(b.reused, true);
});

test("thread visibility is read after the row lock, so concurrent visibility changes govern insertion", async () => {
  const connection = await schema.database.connect();
  let writing:
    ReturnType<typeof repository.createReadyArtifactRecord> | undefined;
  try {
    await connection.query("begin");
    await connection.query("select id from threads where id = $1 for update", [
      threadId,
    ]);
    writing = repository.createReadyArtifactRecord(input());
    await waitForBlockedQuery('%from "threads"%');
    await connection.query(
      "update threads set visibility = 'private' where id = $1",
      [threadId],
    );
    await connection.query("commit");
    const created = await writing;
    const stored = await records();
    assert.equal(stored.artifacts[0]?.id, created.artifactId);
    assert.equal(stored.artifacts[0]?.visibility, "private");
  } finally {
    await connection.query("rollback");
    connection.release();
    if (writing) await Promise.allSettled([writing]);
  }
});

test("a destination visibility change after fast lookup is rechecked by the write", async () => {
  const first = await repository.createReadyArtifactRecord(input());
  assert.equal(
    (
      await repository.findArtifactRecordByRequestKey({
        ...input(),
        requestKey,
        statuses: ["ready"],
      })
    )?.id,
    first.artifactId,
  );
  await schema.db
    .update(schema.threads)
    .set({ visibility: "private" })
    .where(eq(schema.threads.id, threadId));
  const second = await repository.createReadyArtifactRecord(input());
  assert.equal(second.reused, false);
  assert.notEqual(second.artifactId, first.artifactId);
  assert.equal(
    (
      await repository.findArtifactRecordByRequestKey({
        ...input(),
        requestKey,
        statuses: ["ready"],
      })
    )?.id,
    second.artifactId,
  );
});

test("markArtifactReady cannot overwrite another creator's private artifact", async () => {
  threadId = await createThread("private");
  const first = await repository.createReadyArtifactRecord(input());
  const before = await records();
  assert.equal(
    await repository.markArtifactReady({
      artifactId: first.artifactId,
      teamId,
      workspaceId,
      userId: otherUserId,
      payload: { overwritten: true },
      expectedVersionNo: 1,
    }),
    null,
  );
  assert.deepEqual(await records(), before);
});

test("markArtifactReady rechecks visibility after waiting for the artifact row lock", async () => {
  const first = await repository.createReadyArtifactRecord(input());
  const connection = await schema.database.connect();
  let writing: ReturnType<typeof repository.markArtifactReady> | undefined;
  try {
    await connection.query("begin");
    await connection.query(
      "select id from artifacts where id = $1 for update",
      [first.artifactId],
    );
    writing = repository.markArtifactReady({
      artifactId: first.artifactId,
      teamId,
      workspaceId,
      userId: otherUserId,
      payload: { overwritten: true },
      expectedVersionNo: 1,
    });
    await waitForBlockedQuery('%from "artifacts"%');
    await connection.query(
      "update artifacts set visibility = 'private' where id = $1",
      [first.artifactId],
    );
    await connection.query("commit");
    assert.equal(await writing, null);
    const stored = await records();
    assert.equal(stored.versions.length, 1);
    assert.deepEqual(stored.artifacts[0]?.payloadJson, { image: "data" });
  } finally {
    await connection.query("rollback");
    connection.release();
    if (writing) await Promise.allSettled([writing]);
  }
});

test("a ready artifact with a missing current version fails instead of silently creating a replacement", async () => {
  const first = await repository.createReadyArtifactRecord(input());
  await schema.db
    .delete(schema.artifactVersions)
    .where(eq(schema.artifactVersions.artifactId, first.artifactId));
  await assert.rejects(
    repository.createReadyArtifactRecord(input()),
    (error: unknown) =>
      (error as { code?: string }).code === "ARTIFACT_RECORD_UNAVAILABLE",
  );
  assert.equal((await records()).artifacts.length, 1);
});

test("unkeyed writes remain independent creations", async () => {
  const [a, b] = await Promise.all([
    repository.createReadyArtifactRecord(input({ requestKey: null })),
    repository.createReadyArtifactRecord(input({ requestKey: null })),
  ]);
  assert.notEqual(a.artifactId, b.artifactId);
  assert.deepEqual([a.reused, b.reused], [false, false]);
  assert.equal((await records()).artifacts.length, 2);
});

test("storage reference evidence includes current pointers and nested historical JSON without exposing payload", async () => {
  const created = await repository.createReadyArtifactRecord(
    input({
      storageKey: "old-pointer",
      previewStorageKey: "preview",
      payload: { deeply: [{ storage: "historical-json-key" }] },
    }),
  );
  await repository.markArtifactReady({
    artifactId: created.artifactId,
    teamId,
    workspaceId,
    userId,
    payload: { storage: "current-json-key" },
    storageKey: "new-pointer",
    expectedVersionNo: 1,
  });
  const keys = [
    "old-pointer",
    "preview",
    "historical-json-key",
    "current-json-key",
    "new-pointer",
    "unknown",
  ];
  const references = await repository.findArtifactWriteReferences({
    artifactId: created.artifactId,
    teamId,
    workspaceId,
    keys,
  });
  assert.deepEqual(references, {
    artifactExists: true,
    currentVersionNo: 2,
    hasVersions: true,
    referencedKeys: [
      "preview",
      "historical-json-key",
      "current-json-key",
      "new-pointer",
    ],
  });
  assert.deepEqual(
    await repository.findArtifactWriteReferences({
      artifactId: created.artifactId,
      teamId,
      workspaceId,
      keys: [],
    }),
    {
      artifactExists: true,
      currentVersionNo: 2,
      hasVersions: true,
      referencedKeys: [],
    },
  );
  assert.deepEqual(
    await repository.findArtifactWriteReferences({
      artifactId: created.artifactId,
      teamId: randomUUID(),
      workspaceId,
      keys,
    }),
    {
      artifactExists: false,
      currentVersionNo: null,
      hasVersions: false,
      referencedKeys: [],
    },
  );
});
