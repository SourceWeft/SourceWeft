import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../../src/index";
import {
  DEEPINFRA_EMBED_MODEL,
  createIntegrationGatewayConfig,
  createMockGatewayError,
  createPriorityRoute,
  createProviderConfig,
  readIntegrationEnv,
  requireProvider,
} from "./setup";

const EMBED_ALIAS = "embed-default";

test(
  "embeddings.embed via DeepInfra returns a numeric vector",
  { skip: !readIntegrationEnv().deepinfra },
  async () => {
    const provider = requireProvider(readIntegrationEnv().deepinfra, "DEEPINFRA_API_KEY");
    const gateway = createModelGateway(
      createIntegrationGatewayConfig({
        aliases: [EMBED_ALIAS],
        providers: {
          deepinfra: createProviderConfig({
            kind: "deepinfra",
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          }),
        },
        routes: {
          [EMBED_ALIAS]: createPriorityRoute({
            provider: "deepinfra",
            model: DEEPINFRA_EMBED_MODEL,
          }),
        },
      }),
    );

    const result = await gateway.embeddings.embed({
      model: EMBED_ALIAS,
      text: "integration vector sample",
    });

    assert.equal(result.provider, "deepinfra");
    assert.equal(result.providerModel, DEEPINFRA_EMBED_MODEL);
    assert.ok(Array.isArray(result.embedding));
    assert.ok(result.embedding.length > 0);
    assert.ok(result.embedding.every((value) => typeof value === "number"));
  },
);

test(
  "embeddings.embedBatch via DeepInfra returns one vector per text",
  { skip: !readIntegrationEnv().deepinfra },
  async () => {
    const provider = requireProvider(readIntegrationEnv().deepinfra, "DEEPINFRA_API_KEY");
    const gateway = createModelGateway(
      createIntegrationGatewayConfig({
        aliases: [EMBED_ALIAS],
        providers: {
          deepinfra: createProviderConfig({
            kind: "deepinfra",
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          }),
        },
        routes: {
          [EMBED_ALIAS]: createPriorityRoute({
            provider: "deepinfra",
            model: DEEPINFRA_EMBED_MODEL,
          }),
        },
      }),
    );

    const result = await gateway.embeddings.embedBatch({
      model: EMBED_ALIAS,
      texts: ["alpha", "beta"],
    });

    assert.equal(result.embeddings.length, 2);
    assert.ok(result.embeddings.every((embedding) => embedding.length > 0));
    assert.equal(result.provider, "deepinfra");
  },
);

test("embeddings.embed surfaces normalized timeout errors", async () => {
  const gateway = createModelGateway({
    allowedModelAliases: [EMBED_ALIAS],
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiKey: "test-key",
      },
    },
    modelRoutes: {
      [EMBED_ALIAS]: createPriorityRoute({
        provider: "deepinfra",
        model: DEEPINFRA_EMBED_MODEL,
      }),
    },
    langchainFactories: {
      createEmbeddingsModel: () => ({
        async embedQuery() {
          const abortError = Object.assign(new Error("Timed out"), {
            name: "AbortError",
          });
          throw abortError;
        },
        async embedDocuments() {
          return [];
        },
      }),
    },
  });

  await assert.rejects(
    () =>
      gateway.embeddings.embed({
        model: EMBED_ALIAS,
        text: "hello",
      }),
    (error: unknown) => {
      const normalized = error as { code?: string; retryable?: boolean; message?: string };
      assert.equal(normalized.code, "TIMEOUT");
      assert.equal(normalized.retryable, true);
      assert.equal(normalized.message, "Timed out");
      return true;
    },
  );
});

test("embeddings.embedBatch surfaces explicit provider errors", async () => {
  const gateway = createModelGateway({
    allowedModelAliases: [EMBED_ALIAS],
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1/openai",
        apiKey: "test-key",
      },
    },
    modelRoutes: {
      [EMBED_ALIAS]: createPriorityRoute({
        provider: "deepinfra",
        model: DEEPINFRA_EMBED_MODEL,
      }),
    },
    langchainFactories: {
      createEmbeddingsModel: () => ({
        async embedQuery() {
          return [0.1, 0.2];
        },
        async embedDocuments() {
          throw createMockGatewayError({
            code: "AUTH",
            message: "Invalid embedding key",
            retryable: false,
            statusCode: 401,
            provider: "deepinfra",
          });
        },
      }),
    },
  });

  await assert.rejects(
    () =>
      gateway.embeddings.embedBatch({
        model: EMBED_ALIAS,
        texts: ["alpha", "beta"],
      }),
    (error: unknown) => {
      const normalized = error as {
        code?: string;
        retryable?: boolean;
        statusCode?: number;
        provider?: string;
      };
      assert.equal(normalized.code, "AUTH");
      assert.equal(normalized.retryable, false);
      assert.equal(normalized.statusCode, 401);
      assert.equal(normalized.provider, "deepinfra");
      return true;
    },
  );
});
