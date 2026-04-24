import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";
import { createJsonResponse } from "./helpers";

test("embeddings.embedBatch normalizes LangChain embeddings output", async () => {
  const gateway = createModelGateway({
    allowedModelAliases: ["embed-default"],
    providers: {
      gemini: {
        kind: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-key",
      },
    },
    modelRoutes: {
      "embed-default": {
        strategy: "priority",
        targets: [{ provider: "gemini", model: "text-embedding-004", priority: 1 }],
      },
    },
    langchainFactories: {
      createEmbeddingsModel: () => ({
        async embedQuery() {
          return [0.9, 0.8];
        },
        async embedDocuments(texts: string[]) {
          return texts.map((text, index) => [index, text.length]);
        },
      }),
    },
  });

  const result = await gateway.embeddings.embedBatch({
    model: "embed-default",
    texts: ["hello", "world"],
  });

  assert.equal(result.model, "text-embedding-004");
  assert.deepEqual(result.embeddings, [
    [0, 5],
    [1, 5],
  ]);
  assert.equal(result.provider, "gemini");
});

test("rerank.rank supports siliconflow via openai-compatible provider", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];

  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return createJsonResponse({
        model: "BAAI/bge-reranker-v2-m3",
        results: [{ index: 0, score: 0.77 }],
      });
    },
    providers: {
      siliconflow: {
        kind: "openai-compatible",
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "sf-key",
      },
    },
    modelRoutes: {
      "rerank-default": {
        strategy: "priority",
        targets: [{ provider: "siliconflow", model: "BAAI/bge-reranker-v2-m3", priority: 1 }],
      },
    },
  });

  const result = await gateway.rerank.rank({
    model: "rerank-default",
    query: "search docs",
    documents: ["first doc"],
  });

  assert.equal(requests[0]?.url, "https://api.siliconflow.cn/v1/rerank");
  assert.equal(result.results[0]?.relevanceScore, 0.77);
  assert.equal(result.provider, "siliconflow");
});
