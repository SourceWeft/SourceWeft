import assert from "node:assert/strict";
import test from "node:test";
import {
  runRetrieval,
  type EmbeddingProfile,
  type EmbeddingVectorStrategy,
  type RetrievalCandidate,
  type RetrievalDataAccess,
  type RetrievalInput,
} from "../src";

const profile: EmbeddingProfile = {
  id: "profile-1",
  profileAlias: "embedding",
  gatewayConfigId: "gateway-1",
  modelAlias: "embedding-model",
  requestedDimensions: 2,
  vectorStrategy: "exact_vector",
  isDefault: true,
  isActive: true,
};
const candidate: RetrievalCandidate = {
  chunkId: "chunk-1",
  documentId: "doc-1",
  sourceId: "source-1",
  sourceTitle: "Source",
  chunkNo: 0,
  content: "Existing vector evidence",
  score: 0.75,
  stage: "vector",
};

function fixture(options?: {
  strategy?: EmbeddingVectorStrategy;
  bm25?: RetrievalDataAccess["searchChunksByBm25"];
  vectors?: RetrievalDataAccess["searchChunksByVectorExact"];
}) {
  const audit: Parameters<RetrievalDataAccess["createRetrievalRun"]>[0][] = [];
  const hits: Parameters<RetrievalDataAccess["createRetrievalHits"]>[0][] = [];
  let embeddingCalls = 0;
  let vectorCalls = 0;
  const vectors = async (
    input: Parameters<RetrievalDataAccess["searchChunksByVectorExact"]>[0],
  ) => {
    vectorCalls += 1;
    return options?.vectors ? options.vectors(input) : [candidate];
  };
  const dataAccess: RetrievalDataAccess = {
    findDefaultEmbeddingProfile: async () => profile,
    listSourceChunksByProfile: async () => [],
    searchChunksByBm25: options?.bm25 ?? (async () => []),
    searchChunksByVectorExact: vectors,
    searchChunksByVectorAnn: vectors,
    listDocumentChunkStats: async () => [],
    listDocumentChunksInRange: async () => [],
    listDocumentChunksForDocument: async () => [],
    createRetrievalRun: async (input) => {
      audit.push(input);
      return "run-1";
    },
    createRetrievalHits: async (input) => {
      hits.push(input);
    },
  };
  const input: RetrievalInput = {
    workspaceId: "ws-1",
    teamId: "team-1",
    threadId: "thread-1",
    userId: "user-1",
    userMessageId: "message-1",
    queryText: "query",
    sourceIds: ["source-1", "source-2"],
  };
  return {
    audit,
    hits,
    counts: () => ({ embeddingCalls, vectorCalls }),
    run: (overrides?: Partial<RetrievalInput>) =>
      runRetrieval(
        { ...input, ...overrides },
        {
          dataAccess,
          embeddingGateway: {
            embed: async () => {
              embeddingCalls += 1;
              return [1, 0];
            },
          },
          rerankGateway: {
            rank: async ({ documents }) =>
              documents.map((_, index) => ({ index, relevanceScore: 1 })),
          },
          planStrategy: () => ({
            strategy: options?.strategy ?? "exact_vector",
            requestedDimensions: 2,
            annIndexUsed:
              options?.strategy === "ann_hnsw" ? "vector_idx" : null,
          }),
        },
      ),
  };
}

for (const strategy of ["bm25_only", "exact_vector", "ann_hnsw"] as const) {
  test(`${strategy} preserves the original BM25 error by default`, async () => {
    const failure = new Error("BM25 index unavailable");
    const f = fixture({
      strategy,
      bm25: async () => {
        throw failure;
      },
    });
    await assert.rejects(f.run(), (error) => error === failure);
    assert.equal(f.counts().vectorCalls, 0);
    assert.equal(
      f.audit.length,
      0,
      "failed runs must not record a successful empty retrieval",
    );
    assert.equal(f.hits.length, 0);
  });
}

test("bm25_only still fails when vector degradation is allowed", async () => {
  const failure = new Error("BM25 index unavailable");
  const f = fixture({
    strategy: "bm25_only",
    bm25: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    f.run({ tuning: { bm25FailurePolicy: "allow_vector" } }),
    (error) => error === failure,
  );
  assert.deepEqual(f.counts(), { embeddingCalls: 0, vectorCalls: 0 });
  assert.equal(f.audit.length, 0);
});

for (const strategy of ["exact_vector", "ann_hnsw"] as const) {
  test(`${strategy} explicitly allowed degradation retains vectors in result and audit`, async () => {
    const f = fixture({
      strategy,
      bm25: async () => {
        throw new Error("BM25 index unavailable");
      },
    });
    const result = await f.run({
      tuning: { bm25FailurePolicy: "allow_vector" },
    });
    assert.equal(result.fusedCandidates[0]?.chunkId, candidate.chunkId);
    assert.deepEqual(result.degradations, [
      { stage: "bm25-search", reason: "BM25 index unavailable" },
    ]);
    assert.deepEqual(
      f.audit[0]?.metadataJson?.degradations,
      result.degradations,
    );
    assert.equal(f.audit[0]?.finalResultCount, 1);
    assert.deepEqual(
      f.hits[0]?.hits.map((hit) => hit.sourceStage),
      ["vector", "rrf", "rerank"],
    );
  });
}

for (const strategy of ["bm25_only", "exact_vector"] as const) {
  test(`${strategy} treats legitimate zero matches as a successful empty retrieval`, async () => {
    const f = fixture({ strategy, vectors: async () => [] });
    const result = await f.run();
    assert.deepEqual(result.fusedCandidates, []);
    assert.deepEqual(result.degradations, []);
    assert.equal(f.audit[0]?.finalResultCount, 0);
    assert.equal(f.audit[0]?.metadataJson?.degradations, undefined);
  });
}

for (const strategy of ["bm25_only", "exact_vector"] as const) {
  test(`${strategy} does not swallow failures in the anchor branch`, async () => {
    const failure = new Error("anchor query failed");
    const f = fixture({
      strategy,
      bm25: async ({ sourceIds }) => {
        if (sourceIds.length === 1) throw failure;
        return [];
      },
    });
    await assert.rejects(
      f.run({ anchorSourceIds: ["source-1"] }),
      (error) => error === failure,
    );
    assert.equal(f.audit.length, 0);
  });
}

test("explicitly allowed anchor failure returns and audits its own degradation", async () => {
  const f = fixture({
    bm25: async ({ sourceIds }) => {
      if (sourceIds.length === 1) throw new Error("anchor query failed");
      return [{ ...candidate, stage: "bm25" }];
    },
  });
  const result = await f.run({
    anchorSourceIds: ["source-1"],
    tuning: { bm25FailurePolicy: "allow_vector" },
  });
  assert.deepEqual(result.degradations, [
    { stage: "anchor-bm25-search", reason: "anchor query failed" },
  ]);
  assert.deepEqual(f.audit[0]?.metadataJson?.degradations, result.degradations);
  assert.equal(result.fusedCandidates.length, 1);
  assert.equal(f.counts().vectorCalls, 2);
});

test("allowing BM25 degradation never swallows a failing vector channel", async () => {
  const failure = new Error("vector query failed");
  const f = fixture({
    bm25: async () => {
      throw new Error("BM25 query failed");
    },
    vectors: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    f.run({ tuning: { bm25FailurePolicy: "allow_vector" } }),
    (error) => error === failure,
  );
  assert.equal(f.audit.length, 0);
});
