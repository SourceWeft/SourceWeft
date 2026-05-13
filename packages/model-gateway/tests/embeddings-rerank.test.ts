import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeepInfraProvider,
  createModelGateway,
  createSiliconflowCNProvider,
} from "../src/index";
import { DeepInfraChatAdapter } from "../src/adapters/deepinfra-chat";
import { DeepInfraEmbeddingsAdapter } from "../src/adapters/deepinfra-embeddings";
import { SiliconflowCNChatAdapter } from "../src/adapters/siliconflow-cn-chat";
import { SiliconflowCNEmbeddingsAdapter } from "../src/adapters/siliconflow-cn-embeddings";
import { createJsonResponse } from "./helpers";

test("createDeepInfraProvider defaults to provider root URL", () => {
  assert.deepEqual(createDeepInfraProvider({ apiKey: "deepinfra-key" }), {
    kind: "deepinfra",
    baseUrl: "https://api.deepinfra.com/v1",
    apiKey: "deepinfra-key",
    defaultHeaders: undefined,
    supports: ["chat", "embeddings", "rerank", "asr", "image"],
    enabled: true,
  });
});

test("DeepInfra chat and embeddings adapters expose provider identity", () => {
  assert.equal(new DeepInfraChatAdapter().kind, "deepinfra");
  assert.equal(new DeepInfraEmbeddingsAdapter().kind, "deepinfra");
});

test("createSiliconflowCNProvider defaults to SiliconFlow CN API", () => {
  assert.deepEqual(createSiliconflowCNProvider({ apiKey: "sf-key" }), {
    kind: "siliconflow-cn",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "sf-key",
    defaultHeaders: undefined,
    supports: [
      "chat",
      "embeddings",
      "rerank",
      "asr",
      "image",
      "tool_calling",
      "json_schema",
    ],
    enabled: true,
  });
});

test("SiliconflowCN chat and embeddings adapters expose provider identity", () => {
  assert.equal(new SiliconflowCNChatAdapter().kind, "siliconflow-cn");
  assert.equal(new SiliconflowCNEmbeddingsAdapter().kind, "siliconflow-cn");
});

test("DeepInfra rerank preserves inference_status cost", async () => {
  const gateway = createModelGateway({
    fetch: async () =>
      createJsonResponse({
        request_id: "request-1",
        inference_status: {
          runtime_ms: 118,
          cost: 0.000089,
          tokens_input: 89,
        },
        scores: [0.9948431253433228],
        input_tokens: 89,
      }),
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "rerank-default": {
        strategy: "priority",
        targets: [
          {
            provider: "deepinfra",
            model: "Qwen/Qwen3-Reranker-0.6B",
            priority: 1,
          },
        ],
      },
    },
  });

  const result = await gateway.rerank.rank({
    model: "rerank-default",
    query: "What is the capital of United States of America?",
    documents: ["The capital of USA is Washington DC."],
  });

  assert.equal(result.usage?.inputTokens, 89);
  assert.equal(result.usage?.providerCostUsd, 0.000089);
  assert.equal(result.usage?.providerCostSource, "inference_status.cost");
});

test("DeepInfra embeddings reject base64 encoding format", async () => {
  const gateway = createModelGateway({
    allowedModelAliases: ["embed-default"],
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "embed-default": {
        strategy: "priority",
        targets: [{ provider: "deepinfra", model: "BAAI/bge-m3", priority: 1 }],
      },
    },
  });

  await assert.rejects(
    () =>
      gateway.embeddings.embed({
        model: "embed-default",
        text: "hello",
        encodingFormat: "base64",
      }),
    (error: unknown) => {
      const normalized = error as {
        code?: string;
        provider?: string;
        retryable?: boolean;
      };
      assert.equal(normalized.code, "BAD_REQUEST");
      assert.equal(normalized.provider, "deepinfra");
      assert.equal(normalized.retryable, false);
      return true;
    },
  );
});

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

test("embeddings.embed emits generation observation events", async () => {
  const events: Array<{ type: string; event: Record<string, unknown> }> = [];
  const gateway = createModelGateway({
    allowedModelAliases: ["embed-default"],
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
      },
    },
    modelRoutes: {
      "embed-default": {
        strategy: "priority",
        targets: [{ provider: "openai", model: "text-embedding-3-small", priority: 1 }],
      },
    },
    observeSink: {
      onGenerationStart(event) {
        events.push({ type: "start", event: event as unknown as Record<string, unknown> });
      },
      onGenerationEnd(event) {
        events.push({ type: "end", event: event as unknown as Record<string, unknown> });
      },
    },
    langchainFactories: {
      createEmbeddingsModel: () => ({
        async embedQuery() {
          return [0.1, 0.2, 0.3];
        },
        async embedDocuments() {
          return [];
        },
      }),
    },
  });

  await gateway.embeddings.embed(
    {
      model: "embed-default",
      text: "hello",
      metadata: { teamId: "team-1", workspaceId: "workspace-1" },
    },
    { traceId: "trace-embed" },
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.event.operation, "embeddings.embed");
  assert.equal(events[0]?.event.provider, "openai");
  assert.equal(events[1]?.event.spanId, events[0]?.event.spanId);
  assert.deepEqual((events[1]?.event.output as Record<string, unknown>).dimensions, 3);
});

test("embeddings.embed ignores generation observation failures", async () => {
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const gateway = createModelGateway({
    allowedModelAliases: ["embed-default"],
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
      },
    },
    modelRoutes: {
      "embed-default": {
        strategy: "priority",
        targets: [{ provider: "openai", model: "text-embedding-3-small", priority: 1 }],
      },
    },
    logger: {
      warn(_message, data) {
        warnings.push(data);
      },
    },
    observeSink: {
      onGenerationStart() {
        throw new Error("start observer down");
      },
      onGenerationEnd() {
        throw new Error("end observer down");
      },
    },
    langchainFactories: {
      createEmbeddingsModel: () => ({
        async embedQuery() {
          return [0.1, 0.2, 0.3];
        },
        async embedDocuments() {
          return [];
        },
      }),
    },
  });

  const result = await gateway.embeddings.embed(
    {
      model: "embed-default",
      text: "hello",
      metadata: { teamId: "team-1", workspaceId: "workspace-1" },
    },
    { traceId: "trace-embed-observe-failure" },
  );

  assert.deepEqual(result.embedding, [0.1, 0.2, 0.3]);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0]?.error, "start observer down");
  assert.equal(warnings[1]?.error, "end observer down");
});

test("rerank.rank supports SiliconflowCN provider", async () => {
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
      SiliconflowCN: {
        kind: "siliconflow-cn",
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "sf-key",
      },
    },
    modelRoutes: {
      "rerank-default": {
        strategy: "priority",
        targets: [{ provider: "SiliconflowCN", model: "BAAI/bge-reranker-v2-m3", priority: 1 }],
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
  assert.equal(result.provider, "SiliconflowCN");
});

test("rerank.rank emits provider-wire generation observation events", async () => {
  const events: Array<{ type: string; event: Record<string, unknown> }> = [];
  const gateway = createModelGateway({
    fetch: async () =>
      createJsonResponse({
        model: "BAAI/bge-reranker-v2-m3",
        results: [{ index: 0, score: 0.77 }],
      }),
    providers: {
      SiliconflowCN: {
        kind: "siliconflow-cn",
        baseUrl: "https://api.siliconflow.cn/v1",
        apiKey: "sf-key",
      },
    },
    modelRoutes: {
      "rerank-default": {
        strategy: "priority",
        targets: [{ provider: "SiliconflowCN", model: "BAAI/bge-reranker-v2-m3", priority: 1 }],
      },
    },
    observeSink: {
      onGenerationStart(event) {
        events.push({ type: "start", event: event as unknown as Record<string, unknown> });
      },
      onGenerationEnd(event) {
        events.push({ type: "end", event: event as unknown as Record<string, unknown> });
      },
    },
  });

  await gateway.rerank.rank(
    {
      model: "rerank-default",
      query: "search docs",
      documents: ["first doc"],
      metadata: { teamId: "team-1", workspaceId: "workspace-1" },
    },
    { traceId: "trace-rerank" },
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.event.operation, "rerank.rank");
  assert.equal(events[1]?.event.rawCaptureMode, "provider_wire");
  assert.equal((events[1]?.event.output as Record<string, unknown>).resultCount, 1);
});

test("rerank.rank supports DeepInfra inference endpoint", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];

  const gateway = createModelGateway({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return createJsonResponse({
        scores: [[0.82, 0.11]],
      });
    },
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://api.deepinfra.com/v1",
        apiKey: "deepinfra-key",
      },
    },
    modelRoutes: {
      "rerank-default": {
        strategy: "priority",
        targets: [{ provider: "deepinfra", model: "Qwen/Qwen3-Reranker-4B", priority: 1 }],
      },
    },
  });

  const result = await gateway.rerank.rank({
    model: "rerank-default",
    query: "capital of usa",
    documents: ["Washington DC", "Paris"],
    topN: 1,
  });

  assert.equal(
    requests[0]?.url,
    "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-4B",
  );
  assert.equal(requests[0]?.init.headers instanceof Headers, false);
  assert.equal(
    (requests[0]?.init.headers as Record<string, string> | undefined)?.Authorization,
    "Bearer deepinfra-key",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    queries: ["capital of usa"],
    documents: ["Washington DC", "Paris"],
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.index, 0);
  assert.equal(result.results[0]?.relevanceScore, 0.82);
  assert.equal(result.provider, "deepinfra");
});
