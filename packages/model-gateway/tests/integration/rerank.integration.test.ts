import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../../src/index";
import { createJsonResponse } from "../helpers";
import {
  OPENROUTER_RERANK_MODEL,
  createIntegrationGatewayConfig,
  createPriorityRoute,
  createProviderConfig,
  readIntegrationEnv,
  requireProvider,
} from "./setup";

const RERANK_ALIAS = "rerank-default";

test(
  "rerank.rank via OpenRouter returns sorted results",
  { skip: !readIntegrationEnv().openrouter },
  async () => {
    const provider = requireProvider(readIntegrationEnv().openrouter, "OPENROUTER_API_KEY");
    const gateway = createModelGateway(
      createIntegrationGatewayConfig({
        aliases: [RERANK_ALIAS],
        providers: {
          openrouter: createProviderConfig({
            kind: "openrouter",
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          }),
        },
        routes: {
          [RERANK_ALIAS]: createPriorityRoute({
            provider: "openrouter",
            model: OPENROUTER_RERANK_MODEL,
          }),
        },
      }),
    );

    const result = await gateway.rerank.rank({
      model: RERANK_ALIAS,
      query: "What is the capital of France?",
      documents: [
        "Paris is the capital of France.",
        "London is the capital of England.",
        "Berlin is the capital of Germany.",
      ],
      topN: 2,
      returnDocuments: true,
    });

    assert.equal(result.provider, "openrouter");
    assert.equal(result.providerModel, OPENROUTER_RERANK_MODEL);
    assert.ok(result.results.length > 0);
    assert.ok(result.results.length <= 2);
    for (let index = 1; index < result.results.length; index += 1) {
      assert.ok(
        result.results[index - 1]!.relevanceScore >= result.results[index]!.relevanceScore,
      );
    }
  },
);

test(
  "rerank.rank via OpenRouter can return source documents",
  { skip: !readIntegrationEnv().openrouter },
  async () => {
    const provider = requireProvider(readIntegrationEnv().openrouter, "OPENROUTER_API_KEY");
    const gateway = createModelGateway(
      createIntegrationGatewayConfig({
        aliases: [RERANK_ALIAS],
        providers: {
          openrouter: createProviderConfig({
            kind: "openrouter",
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          }),
        },
        routes: {
          [RERANK_ALIAS]: createPriorityRoute({
            provider: "openrouter",
            model: OPENROUTER_RERANK_MODEL,
          }),
        },
      }),
    );

    const documents = [
      { id: "doc_1", content: "Embeddings turn text into dense vectors." },
      { id: "doc_2", content: "This one is about unrelated weather." },
    ];
    const result = await gateway.rerank.rank({
      model: RERANK_ALIAS,
      query: "Which passage explains embeddings?",
      documents,
      topN: 1,
      returnDocuments: true,
    });

    assert.equal(result.results.length, 1);
    assert.deepEqual(result.results[0]?.document, documents[result.results[0]!.index]);
  },
);

test("rerank.rank maps HTTP auth failures into gateway errors", async () => {
  const gateway = createModelGateway({
    fetch: async () =>
      createJsonResponse(
        {
          error: {
            message: "Invalid rerank key",
            type: "openrouter",
          },
        },
        { status: 401 },
      ),
    allowedModelAliases: [RERANK_ALIAS],
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "invalid-key",
      },
    },
    modelRoutes: {
      [RERANK_ALIAS]: createPriorityRoute({
        provider: "openrouter",
        model: OPENROUTER_RERANK_MODEL,
      }),
    },
  });

  await assert.rejects(
    () =>
      gateway.rerank.rank({
        model: RERANK_ALIAS,
        query: "hello",
        documents: ["world"],
      }),
    (error: unknown) => {
      const normalized = error as {
        code?: string;
        statusCode?: number;
        provider?: string;
        message?: string;
      };
      assert.equal(normalized.code, "AUTH");
      assert.equal(normalized.statusCode, 401);
      assert.equal(normalized.provider, "openrouter");
      assert.equal(normalized.message, "Invalid rerank key");
      return true;
    },
  );
});

test("rerank.rank maps HTTP rate limits into retryable gateway errors", async () => {
  const gateway = createModelGateway({
    fetch: async () =>
      createJsonResponse(
        {
          error: {
            message: "Slow down",
            type: "openrouter",
          },
        },
        { status: 429 },
      ),
    maxRetries: 0,
    allowedModelAliases: [RERANK_ALIAS],
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
      },
    },
    modelRoutes: {
      [RERANK_ALIAS]: createPriorityRoute({
        provider: "openrouter",
        model: OPENROUTER_RERANK_MODEL,
      }),
    },
  });

  await assert.rejects(
    () =>
      gateway.rerank.rank({
        model: RERANK_ALIAS,
        query: "hello",
        documents: ["world"],
      }),
    (error: unknown) => {
      const normalized = error as {
        code?: string;
        retryable?: boolean;
        statusCode?: number;
      };
      assert.equal(normalized.code, "RATE_LIMIT");
      assert.equal(normalized.retryable, true);
      assert.equal(normalized.statusCode, 429);
      return true;
    },
  );
});
