import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import {
  runRetrieval,
  type RetrievalDataAccess,
  type RetrievalInput,
} from "@sourceweft/builtin-retrieval";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import type { EmbeddingIndexIdentity } from "../../shared/model-gateway/embedding-identity";

// Catalog network I/O is outside this test. Every search and audit repository
// operation below uses PostgreSQL, including the intentionally broken SQL.
vi.mock("../../shared/model-gateway/model-catalog/registry", () => ({
  modelCatalog: { refresh: vi.fn().mockResolvedValue(undefined) },
}));

let schema: typeof import("@sourceweft/db");
let repository: typeof import("./retrieval-repository");
let isolated:
  Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
let directory: string | undefined;
let identity: EmbeddingIndexIdentity;
let brokenColumn = false;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalActivation = process.env.SOURCEWEFT_RETRIEVAL_TEST_ENABLED;
const teamId = randomUUID();
const workspaceId = randomUUID();
const sourceId = randomUUID();
const documentId = randomUUID();
const chunkId = randomUUID();
const threadId = randomUUID();
const messageId = randomUUID();
const profileId = randomUUID();

beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("retrieval_error");
  process.env.DATABASE_URL = isolated.url;
  process.env.SOURCEWEFT_RETRIEVAL_TEST_ENABLED = "true";
  schema = await import("@sourceweft/db");
  repository = await import("./retrieval-repository");
  const { syncGlobalModelGatewayConfigFromFile } =
    await import("../../shared/model-gateway/config-sync");
  const { prepareEmbeddingProfile } =
    await import("../../shared/model-gateway/embedding-identity");
  directory = await mkdtemp(join(tmpdir(), "sourceweft-retrieval-error-"));
  const configPath = join(directory, "gateway.json");
  await writeFile(
    configPath,
    JSON.stringify({
      gateways: [
        {
          slug: "retrieval-test",
          providerName: "retrieval-test",
          providerKind: "openai-compatible",
          baseUrl: "https://retrieval-test.invalid/v1",
          activation: {
            env: "SOURCEWEFT_RETRIEVAL_TEST_ENABLED",
            default: false,
          },
          isDefault: true,
          supports: ["embeddings"],
          modelCatalog: { enabled: false },
        },
      ],
      chatProfiles: [
        {
          profileAlias: "chat",
          modelAlias: "chat",
          gatewaySlug: "retrieval-test",
          providerName: "retrieval-test",
          targetModel: "chat",
          isDefault: true,
          isActive: true,
        },
      ],
      embeddingProfiles: [
        {
          profileId,
          profileAlias: "embedding",
          modelAlias: "embedding",
          gatewaySlug: "retrieval-test",
          providerName: "retrieval-test",
          targetModel: "embedding",
          requestedDimensions: 2,
          isDefault: true,
          isActive: true,
        },
      ],
    }),
  );
  await syncGlobalModelGatewayConfigFromFile(configPath, {
    syncPricing: false,
  });
  ({ identity } = await prepareEmbeddingProfile());
  const { db } = schema;
  await db
    .insert(schema.workspaces)
    .values({
      id: workspaceId,
      organizationId: teamId,
      name: "Retrieval failure test",
      slug: workspaceId,
    });
  await db
    .insert(schema.threads)
    .values({
      id: threadId,
      teamId,
      workspaceId,
      title: "Retrieval failure test",
    });
  await db
    .insert(schema.messages)
    .values({
      id: messageId,
      teamId,
      workspaceId,
      threadId,
      role: "user",
      content: "query",
    });
  await db
    .insert(schema.sources)
    .values({
      id: sourceId,
      teamId,
      workspaceId,
      title: "Indexed evidence",
      status: "indexed",
    });
  await db.insert(schema.documents).values({
    id: documentId,
    teamId,
    workspaceId,
    sourceId,
    contentText: "Existing vector evidence",
    status: "ready",
    documentMetadata: { embeddingIdentity: identity },
  });
  await db
    .insert(schema.chunks)
    .values({
      id: chunkId,
      teamId,
      workspaceId,
      sourceId,
      documentId,
      chunkNo: 0,
      content: "Existing vector evidence",
      searchParts: ["existing", "vector", "evidence"],
    });
  await db
    .insert(schema.chunkEmbeddings)
    .values({
      id: randomUUID(),
      teamId,
      workspaceId,
      chunkId,
      embeddingProfileId: profileId,
      modelAlias: "embedding",
      dim: 2,
      embedding: [1, 0],
    });
}, 120_000);

async function breakBm25Query() {
  await schema.database.query(
    "alter table chunks rename column search_parts to bm25_search_parts_unavailable",
  );
  brokenColumn = true;
}

afterEach(async () => {
  if (!schema) return;
  if (brokenColumn) {
    await schema.database.query(
      "alter table chunks rename column bm25_search_parts_unavailable to search_parts",
    );
    brokenColumn = false;
  }
  await schema.db.delete(schema.retrievalRuns);
});

afterAll(async () => {
  if (schema) await schema.database.end();
  if (isolated) await isolated.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalActivation === undefined)
    delete process.env.SOURCEWEFT_RETRIEVAL_TEST_ENABLED;
  else process.env.SOURCEWEFT_RETRIEVAL_TEST_ENABLED = originalActivation;
});

function run(options?: {
  strategy?: "bm25_only" | "exact_vector";
  input?: Partial<RetrievalInput>;
  breakAnchor?: boolean;
}) {
  let bm25Calls = 0;
  const dataAccess: RetrievalDataAccess = {
    findDefaultEmbeddingProfile: repository.findDefaultEmbeddingProfile,
    listSourceChunksByProfile: repository.listSourceChunksByProfile,
    searchChunksByBm25: async (input) => {
      bm25Calls += 1;
      if (options?.breakAnchor && bm25Calls === 2) await breakBm25Query();
      return repository.searchChunksByBm25(input);
    },
    searchChunksByVectorExact: (input) =>
      repository.searchChunksByVectorExact({
        ...input,
        embeddingIdentity: identity,
      }),
    searchChunksByVectorAnn: (input) =>
      repository.searchChunksByVectorAnn({
        ...input,
        embeddingIdentity: identity,
      }),
    listDocumentChunkStats: (input) =>
      repository.listDocumentChunkStats({
        ...input,
        documents: [...input.documents],
      }),
    listDocumentChunksInRange: repository.listDocumentChunksInRange,
    listDocumentChunksForDocument: repository.listDocumentChunksForDocument,
    createRetrievalRun: repository.createRetrievalRun,
    createRetrievalHits: (input) =>
      repository.createRetrievalHits({ ...input, hits: [...input.hits] }),
  };
  return runRetrieval(
    {
      teamId,
      workspaceId,
      threadId,
      userId: "test-user",
      userMessageId: messageId,
      queryText: "evidence",
      sourceIds: [sourceId],
      ...options?.input,
    },
    {
      dataAccess,
      embeddingGateway: { embed: async () => [1, 0] },
      rerankGateway: {
        rank: async ({ documents }) =>
          documents.map((_, index) => ({ index, relevanceScore: 1 })),
      },
      planStrategy: () => ({
        strategy: options?.strategy ?? "exact_vector",
        requestedDimensions: 2,
        annIndexUsed: null,
      }),
    },
  );
}

function isMissingBm25Column(error: unknown) {
  const cause = (
    error as Error & { cause?: { code?: string; message?: string } }
  ).cause;
  return (
    cause?.code === "42703" && Boolean(cause.message?.includes("search_parts"))
  );
}

test("real SQL zero matches return a successful empty result and audit", async () => {
  const result = await run({
    strategy: "bm25_only",
    input: { sourceIds: [randomUUID()] },
  });
  assert.deepEqual(result.fusedCandidates, []);
  assert.deepEqual(result.degradations, []);
  const records = await schema.db.select().from(schema.retrievalRuns);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.finalResultCount, 0);
  assert.equal(records[0]?.metadataJson.degradations, undefined);
});

for (const strategy of ["bm25_only", "exact_vector"] as const) {
  test(`real ${strategy} SQL errors reject without recording successful zero matches`, async () => {
    await breakBm25Query();
    await assert.rejects(run({ strategy }), isMissingBm25Column);
    assert.deepEqual(await schema.db.select().from(schema.retrievalRuns), []);
  });
}

test("real BM25-only failure cannot be waived by allow_vector", async () => {
  await breakBm25Query();
  await assert.rejects(
    run({
      strategy: "bm25_only",
      input: { tuning: { bm25FailurePolicy: "allow_vector" } },
    }),
    isMissingBm25Column,
  );
  assert.deepEqual(await schema.db.select().from(schema.retrievalRuns), []);
});

test("real hybrid SQL failure requires explicit permission and persists degradation alongside vector hits", async () => {
  await breakBm25Query();
  const result = await run({
    input: { tuning: { bm25FailurePolicy: "allow_vector" } },
  });
  assert.equal(result.fusedCandidates[0]?.chunkId, chunkId);
  assert.equal(result.degradations[0]?.stage, "bm25-search");
  const records = await schema.db.select().from(schema.retrievalRuns);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.finalResultCount, 1);
  assert.deepEqual(records[0]?.metadataJson.degradations, result.degradations);
  const hits = await schema.db.select().from(schema.retrievalHits);
  assert.deepEqual(hits.map((hit) => hit.sourceStage).sort(), [
    "rerank",
    "rrf",
    "vector",
  ]);
});

test("real anchor SQL errors reject by default", async () => {
  await assert.rejects(
    run({ breakAnchor: true, input: { anchorSourceIds: [sourceId] } }),
    isMissingBm25Column,
  );
  assert.deepEqual(await schema.db.select().from(schema.retrievalRuns), []);
});

test("explicit permission also records real anchor SQL degradation", async () => {
  const result = await run({
    breakAnchor: true,
    input: {
      anchorSourceIds: [sourceId],
      tuning: { bm25FailurePolicy: "allow_vector" },
    },
  });
  assert.equal(result.fusedCandidates[0]?.chunkId, chunkId);
  assert.equal(result.degradations[0]?.stage, "anchor-bm25-search");
  const records = await schema.db.select().from(schema.retrievalRuns);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.metadataJson.degradations, result.degradations);
});
