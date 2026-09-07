import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import type { EmbeddingIndexIdentity } from "../../shared/model-gateway/embedding-identity";
import { eq } from "drizzle-orm";
let {
  chunkEmbeddings,
  database,
  db,
  documents,
  modelGatewayConfigs,
  modelGatewayConfigVersions,
  sourceRevisions,
  sources,
  workspaces,
} = {} as typeof import("@sourceweft/db");
let createSourceDocumentChunksAndEmbeddings: typeof import("./repository").createSourceDocumentChunksAndEmbeddings;
let createSourceRevisionRecord: typeof import("./revision-repository").createSourceRevisionRecord;
let prepareEmbeddingProfile: typeof import("../../shared/model-gateway/embedding-identity").prepareEmbeddingProfile;
let syncFromFile: typeof import("../../shared/model-gateway/config-sync").syncGlobalModelGatewayConfigFromFile;
let identity: EmbeddingIndexIdentity;
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let configDirectory: string;
let configPath: string;
const originalDatabaseUrl = process.env.DATABASE_URL;
vi.mock("../../shared/model-gateway/model-catalog/registry", () => ({
  modelCatalog: { refresh: vi.fn().mockResolvedValue(undefined) },
}));
beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("index_revision");
  process.env.DATABASE_URL = isolated.url;
  ({
    chunkEmbeddings,
    database,
    db,
    documents,
    modelGatewayConfigs,
    modelGatewayConfigVersions,
    sourceRevisions,
    sources,
    workspaces,
  } = await import("@sourceweft/db"));
  ({ createSourceDocumentChunksAndEmbeddings } = await import("./repository"));
  ({ createSourceRevisionRecord } = await import("./revision-repository"));
  ({ prepareEmbeddingProfile } =
    await import("../../shared/model-gateway/embedding-identity"));
  ({ syncGlobalModelGatewayConfigFromFile: syncFromFile } =
    await import("../../shared/model-gateway/config-sync"));
  configDirectory = await mkdtemp(join(tmpdir(), "sourceweft-index-config-"));
  configPath = join(configDirectory, "gateway.json");
}, 120_000);
afterAll(async () => {
  if (database) await database.end();
  if (isolated) await isolated.close();
  if (configDirectory)
    await rm(configDirectory, { recursive: true, force: true });
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

let teamId: string;
let workspaceId: string;
let sourceId: string;
let gatewayId: string;
let profileId: string;
const scope = () => ({ teamId, workspaceId, sourceId });

beforeEach(async () => {
  [teamId, workspaceId, sourceId, gatewayId, profileId] = Array.from(
    { length: 5 },
    () => randomUUID(),
  ) as [string, string, string, string, string];
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: teamId,
    name: "Index concurrency test",
    slug: workspaceId,
  });
  await db.insert(sources).values({
    id: sourceId,
    teamId,
    workspaceId,
    title: "Test source",
    contentText: "original",
  });
  await writeFile(
    configPath,
    JSON.stringify({
      gateways: [
        {
          slug: gatewayId,
          providerName: "test-provider",
          providerKind: "openai-compatible",
          baseUrl: "https://test.invalid/v1",
          isDefault: true,
          supports: ["embeddings"],
          activation: { env: "SOURCEWEFT_INDEX_TEST_ENABLED", default: true },
          modelCatalog: { enabled: false },
        },
      ],
      chatProfiles: [
        {
          profileAlias: `chat-${profileId}`,
          modelAlias: `chat-${profileId}`,
          gatewaySlug: gatewayId,
          providerName: "test-provider",
          targetModel: "test-chat",
          isDefault: true,
          isActive: true,
        },
      ],
      embeddingProfiles: [
        {
          profileId,
          profileAlias: profileId,
          modelAlias: profileId,
          gatewaySlug: gatewayId,
          providerName: "test-provider",
          targetModel: "test-embedding",
          requestedDimensions: 2,
          isDefault: true,
          isActive: true,
        },
      ],
    }),
  );
  await syncFromFile(configPath, { syncPricing: false });
  const prepared = await prepareEmbeddingProfile();
  identity = prepared.identity;
  gatewayId = prepared.profile.gatewayConfigId;
});

afterEach(async () => {
  if (!db) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db
    .delete(modelGatewayConfigs)
    .where(eq(modelGatewayConfigs.id, gatewayId));
  await db
    .delete(modelGatewayConfigVersions)
    .where(eq(modelGatewayConfigVersions.sourcePath, configPath));
});

function input(sourceRevisionId: string | null, text = "indexed content") {
  return {
    ...scope(),
    sourceRevisionId,
    sourceTitle: "Test source",
    sourceContentText: text,
    embeddingProfileId: profileId,
    embeddingIdentity: identity,
    modelAlias: profileId,
    embeddings: [[0.25, 0.75]],
    requireEmbeddings: true,
    requestedDimensions: 2,
    chunks: [{ text, startIndex: 0, endIndex: text.length, tokenCount: 2 }],
    markSourceIndexed: true,
  };
}

async function indexSnapshot() {
  return {
    vectors: await db
      .select()
      .from(chunkEmbeddings)
      .where(eq(chunkEmbeddings.embeddingProfileId, profileId)),
    documents: await db
      .select()
      .from(documents)
      .where(eq(documents.sourceId, sourceId)),
    sources: await db.select().from(sources).where(eq(sources.id, sourceId)),
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitForBlockedSourceWrite() {
  // Observe the real server's lock wait, rather than assuming a scheduler delay
  // proves the second transaction cannot advance.
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await database.query(`
      select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like '%from "sources"%' and query like '%for update%'
    `);
    if (result.rows.length > 0) return;
    await delay(10);
  }
  throw new Error(
    "Expected a concurrent source write to wait for its row lock",
  );
}

test("an old or revision-less index job cannot delete a newer revision's vectors", async () => {
  const first = await createSourceRevisionRecord(scope());
  await createSourceDocumentChunksAndEmbeddings(input(first.id, "first"));
  const second = await createSourceRevisionRecord(scope());
  await createSourceDocumentChunksAndEmbeddings(input(second.id, "second"));
  const before = await indexSnapshot();
  assert.equal(
    await createSourceDocumentChunksAndEmbeddings(input(first.id, "stale")),
    null,
  );
  assert.equal(
    await createSourceDocumentChunksAndEmbeddings(input(null, "legacy stale")),
    null,
  );
  assert.deepEqual(await indexSnapshot(), before);
});

test("revision advancement waits until an in-flight index transaction commits", async () => {
  const revision = await createSourceRevisionRecord(scope());
  const locked = barrier();
  const resume = barrier();
  const indexing = createSourceDocumentChunksAndEmbeddings(input(revision.id), {
    onStage: async (stage) => {
      if (stage === "source_locked") {
        locked.release();
        await resume.promise;
      }
    },
  });
  let advancing: ReturnType<typeof createSourceRevisionRecord> | undefined;
  try {
    await locked.promise;
    advancing = createSourceRevisionRecord(scope());
    await waitForBlockedSourceWrite();
    const [before] = await db
      .select()
      .from(sourceRevisions)
      .where(eq(sourceRevisions.id, revision.id));
    assert.equal(before?.isLatest, true);
    resume.release();
    assert.ok(await indexing);
    const next = await advancing;
    assert.equal(next.revisionNo, 2);
    await createSourceDocumentChunksAndEmbeddings(
      input(next.id, "new revision"),
    );
    const snapshot = await indexSnapshot();
    assert.equal(snapshot.vectors.length, 1);
    assert.equal(
      snapshot.documents.find((doc) => doc.sourceRevisionId === next.id)
        ?.contentText,
      "new revision",
    );
  } finally {
    resume.release();
    await Promise.allSettled([indexing, ...(advancing ? [advancing] : [])]);
  }
});

test("two index replacements of the same revision serialize and leave one vector set", async () => {
  const revision = await createSourceRevisionRecord(scope());
  const locked = barrier();
  const resume = barrier();
  const first = createSourceDocumentChunksAndEmbeddings(
    input(revision.id, "first"),
    {
      onStage: async (stage) => {
        if (stage === "source_locked") {
          locked.release();
          await resume.promise;
        }
      },
    },
  );
  let second:
    ReturnType<typeof createSourceDocumentChunksAndEmbeddings> | undefined;
  try {
    await locked.promise;
    second = createSourceDocumentChunksAndEmbeddings(
      input(revision.id, "second"),
    );
    await waitForBlockedSourceWrite();
    resume.release();
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a && b);
    const snapshot = await indexSnapshot();
    assert.deepEqual(
      snapshot.vectors.map((row) => row.chunkId),
      b.chunkIds,
    );
    assert.equal(
      snapshot.documents.find((row) => row.id === b.documentId)?.contentText,
      "second",
    );
  } finally {
    resume.release();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

test("concurrent revision creators allocate distinct sequential revisions", async () => {
  const revisions = await Promise.all([
    createSourceRevisionRecord(scope()),
    createSourceRevisionRecord(scope()),
  ]);
  assert.deepEqual(
    revisions.map((revision) => revision.revisionNo).sort(),
    [1, 2],
  );
  const stored = await db
    .select()
    .from(sourceRevisions)
    .where(eq(sourceRevisions.sourceId, sourceId));
  assert.equal(stored.filter((revision) => revision.isLatest).length, 1);
  assert.equal(stored.find((revision) => revision.isLatest)?.revisionNo, 2);
});

test("late revision invalidation rolls back every delete and insert", async () => {
  const revision = await createSourceRevisionRecord(scope());
  await createSourceDocumentChunksAndEmbeddings(input(revision.id, "baseline"));
  const before = await indexSnapshot();
  const result = await createSourceDocumentChunksAndEmbeddings(
    input(revision.id, "must roll back"),
    {
      onStage: async (stage) => {
        if (stage !== "before_source_status") return;
        // Simulate a legacy writer that does not yet follow the source lock.
        // This is a real second transaction, not a mock query result.
        await db
          .update(sourceRevisions)
          .set({ isLatest: false })
          .where(eq(sourceRevisions.id, revision.id));
      },
    },
  );
  assert.equal(result, null);
  assert.deepEqual(await indexSnapshot(), before);
});

test("an error after embedding writes rolls the whole replacement back", async () => {
  const revision = await createSourceRevisionRecord(scope());
  await createSourceDocumentChunksAndEmbeddings(input(revision.id, "baseline"));
  const before = await indexSnapshot();
  const failure = new Error("injected after embeddings");
  await assert.rejects(
    createSourceDocumentChunksAndEmbeddings(
      input(revision.id, "must roll back"),
      {
        onStage: async (stage) => {
          if (stage === "before_source_status") throw failure;
        },
      },
    ),
    (error) => error === failure,
  );
  assert.deepEqual(await indexSnapshot(), before);
});
