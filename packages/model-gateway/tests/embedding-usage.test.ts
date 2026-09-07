import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway, TargetHealthRegistry } from "../src/index";
import { getEmbeddingsAdapter } from "../src/adapters/registry";
import {
  ObservedAzureOpenAIEmbeddings,
  ObservedOpenAIEmbeddings,
} from "../src/adapters/observed-embeddings";
import { fetchWithRequestSignal } from "../src/request-options";
import type {
  ModelGatewayConfig,
  ObserveGenerationEnd,
  ObserveGenerationError,
  ProviderKind,
} from "../src/types";

function fixture(
  kind: ProviderKind,
  fetch: typeof globalThis.fetch,
  batchSize?: number,
) {
  const ends: ObserveGenerationEnd[] = [];
  const errors: ObserveGenerationError[] = [];
  const config: ModelGatewayConfig = {
    providers: {
      [kind]: {
        kind,
        baseUrl: "https://embedding.invalid/v1",
        apiKey: "explicit-test-key",
      },
    },
    modelRoutes: {
      embed: {
        strategy: "priority",
        targets: [{ provider: kind, model: "embedding-model", priority: 1 }],
      },
    },
    fetch,
    maxRetries: 0,
    timeoutMs: 10_000,
    targetHealth: new TargetHealthRegistry(),
    observeSink: {
      onGenerationEnd: (event) => {
        ends.push(event);
      },
      onGenerationError: (event) => {
        errors.push(event);
      },
    },
  };
  if (batchSize !== undefined) {
    // Exercise SDK-owned batching through its public batchSize option. The
    // factory still uses the production adapter and real HTTP/protocol SDK.
    config.langchainFactories = {
      createEmbeddingsModel: ({
        target,
        payload,
        options,
        config: resolved,
      }) => {
        const model = getEmbeddingsAdapter(kind).createModel(target, payload, {
          ...options,
          fetch: fetchWithRequestSignal(resolved.fetch, options?.signal),
        });
        assert.ok(
          model instanceof ObservedOpenAIEmbeddings ||
            model instanceof ObservedAzureOpenAIEmbeddings,
        );
        model.batchSize = batchSize;
        return model;
      },
    };
  }
  return { config, ends, errors };
}
async function inputs(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const body = (await new Request(input, init).json()) as {
    input: string | string[];
  };
  return Array.isArray(body.input) ? body.input : [body.input];
}
function response(
  texts: string[],
  options: {
    tokens?: number | null;
    id?: string | null;
    vector?: number[];
  } = {},
) {
  const tokens = options.tokens === undefined ? 37 : options.tokens;
  return new Response(
    JSON.stringify({
      object: "list",
      model: "embedding-model",
      data: texts.map((_text, index) => ({
        object: "embedding",
        index,
        embedding: options.vector ?? [index, 0.5, 1],
      })),
      ...(tokens === null
        ? {}
        : { usage: { prompt_tokens: tokens, total_tokens: tokens } }),
    }),
    {
      headers: {
        "content-type": "application/json",
        ...(options.id ? { "x-request-id": options.id } : {}),
      },
    },
  );
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const kind of [
  "openai",
  "openai-compatible",
  "openrouter",
  "deepinfra",
  "siliconflow-cn",
  "azure-openai",
] as const) {
  test(`${kind} real SDK query exposes usage=37 and its request identity`, async (t) => {
    if (kind === "azure-openai") {
      const previous = process.env.AZURE_OPENAI_API_VERSION;
      process.env.AZURE_OPENAI_API_VERSION = "2025-04-01-preview";
      t.after(() => {
        if (previous === undefined) delete process.env.AZURE_OPENAI_API_VERSION;
        else process.env.AZURE_OPENAI_API_VERSION = previous;
      });
    }
    let requests = 0;
    const { config, ends } = fixture(kind, async (input, init) => {
      requests++;
      return response(await inputs(input, init), { id: `${kind}-request` });
    });
    const result = await createModelGateway(config).embeddings.embed({
      model: "embed",
      text: "hello",
      encodingFormat: "float",
    });
    assert.equal(requests, 1);
    assert.equal(result.usage?.outputTokens, undefined);
    assert.deepEqual(result.usage, { inputTokens: 37, totalTokens: 37 });
    assert.equal(
      result.observation?.identity.providerRequestId,
      `${kind}-request`,
    );
    assert.deepEqual(result.observation?.identity.providerRequestIds, [
      `${kind}-request`,
    ]);
    assert.equal(ends.length, 1);
    assert.equal(ends[0]!.usage?.totalTokens, 37);
    assert.equal(ends[0]!.observation?.spanId, ends[0]!.spanId);
  });
}

test("SDK batches three inputs into two requests: usage=74 and two receipts, without a fake singular request ID", async () => {
  let requests = 0;
  const { config, ends } = fixture(
    "openai-compatible",
    async (input, init) =>
      response(await inputs(input, init), { id: `batch-${++requests}` }),
    2,
  );
  const result = await createModelGateway(config).embeddings.embedBatch({
    model: "embed",
    texts: ["a", "b", "c"],
    encodingFormat: "float",
  });
  assert.equal(requests, 2);
  assert.equal(result.embeddings.length, 3);
  assert.deepEqual(result.usage, { inputTokens: 74, totalTokens: 74 });
  assert.equal(result.observation?.identity.providerRequestId, undefined);
  assert.deepEqual(result.observation?.identity.providerRequestIds?.sort(), [
    "batch-1",
    "batch-2",
  ]);
  assert.equal(ends[0]!.usage?.totalTokens, 74);
});

test("a successful SDK retry is counted once, not once per HTTP attempt", async () => {
  let requests = 0;
  const { config, ends, errors } = fixture(
    "openai-compatible",
    async (input, init) => {
      const texts = await inputs(input, init);
      requests++;
      if (requests === 1)
        return new Response(
          JSON.stringify({ error: { message: "retry me" } }),
          {
            status: 500,
            headers: {
              "content-type": "application/json",
              "x-request-id": "failed-http-attempt",
            },
          },
        );
      return response(texts, { id: "success-http-attempt" });
    },
  );
  config.maxRetries = 1;
  const result = await createModelGateway(config).embeddings.embed({
    model: "embed",
    text: "retry",
  });
  assert.equal(requests, 2);
  assert.equal(result.usage?.totalTokens, 37);
  assert.deepEqual(result.observation?.identity.providerRequestIds, [
    "success-http-attempt",
  ]);
  assert.equal(ends.length, 1);
  assert.equal(errors.length, 0);
});

test("concurrent logical embedding calls retain independent batch usage and request IDs", async () => {
  const { config } = fixture(
    "openai-compatible",
    async (input, init) => {
      const texts = await inputs(input, init);
      if (texts[0]!.startsWith("slow")) await tick();
      return response(texts, {
        tokens: texts[0]!.startsWith("slow") ? 37 : 11,
        id: texts[0]!,
      });
    },
    2,
  );
  const gateway = createModelGateway(config);
  const [slow, fast] = await Promise.all([
    gateway.embeddings.embedBatch({
      model: "embed",
      texts: ["slow-a", "slow-b", "slow-c"],
    }),
    gateway.embeddings.embedBatch({
      model: "embed",
      texts: ["fast-a", "fast-b", "fast-c"],
    }),
  ]);
  assert.equal(slow.usage?.totalTokens, 74);
  assert.equal(fast.usage?.totalTokens, 22);
  assert.deepEqual(slow.observation?.identity.providerRequestIds?.sort(), [
    "slow-a",
    "slow-c",
  ]);
  assert.deepEqual(fast.observation?.identity.providerRequestIds?.sort(), [
    "fast-a",
    "fast-c",
  ]);
});

test("missing usage and request IDs stay unknown; mixed batches expose only known usage with an incomplete diagnostic", async () => {
  const { config } = fixture(
    "openai-compatible",
    async (input, init) => {
      const texts = await inputs(input, init);
      return response(texts, { tokens: texts[0] === "known" ? 37 : null });
    },
    1,
  );
  const gateway = createModelGateway(config);
  const missing = await gateway.embeddings.embed({
    model: "embed",
    text: "unknown",
  });
  assert.equal(missing.usage, undefined);
  assert.equal(missing.observation?.identity.providerRequestId, undefined);
  assert.equal(missing.observation?.identity.providerRequestIds, undefined);
  const mixed = await gateway.embeddings.embedBatch({
    model: "embed",
    texts: ["known", "unknown"],
  });
  assert.deepEqual(mixed.usage, { inputTokens: 37, totalTokens: 37 });
  assert.equal(
    mixed.observation?.diagnostics?.find(
      (item) =>
        item.code === "EMBEDDING_USAGE_INCOMPLETE" &&
        item.field === "totalTokens",
    )?.omittedCount,
    1,
  );
});

test("request identity capture enforces UTF-8 per-ID and per-call limits without losing usage", async () => {
  let count = 0;
  const { config } = fixture(
    "openai-compatible",
    async (input, init) => {
      const texts = await inputs(input, init);
      const index = count++;
      // Latin-1 is valid in HTTP Headers but occupies two UTF-8 bytes per é.
      return response(texts, {
        id: index === 0 ? "é".repeat(129) : "é".repeat(128),
      });
    },
    1,
  );
  const result = await createModelGateway(config).embeddings.embedBatch({
    model: "embed",
    texts: Array.from({ length: 67 }, (_, i) => String(i)),
  });
  const ids = result.observation?.identity.providerRequestIds ?? [];
  assert.equal(ids.length, 64);
  assert.equal(
    ids.reduce((sum, id) => sum + Buffer.byteLength(id), 0),
    16 * 1024,
  );
  assert.equal(result.usage?.totalTokens, 67 * 37);
  assert.equal(result.observation?.identity.providerRequestId, undefined);
  assert.equal(
    result.observation?.diagnostics?.find(
      (item) => item.code === "IDENTITY_TRUNCATED",
    )?.omittedCount,
    3,
  );
});

test("failed parallel batching retains already known usage and ignores responses arriving after termination", async () => {
  let releaseLate!: () => void;
  const late = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  const { config, errors } = fixture(
    "openai-compatible",
    async (input, init) => {
      const texts = await inputs(input, init);
      if (texts[0] === "fail") {
        await tick();
        return new Response(
          JSON.stringify({ error: { message: "batch failed" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (texts[0] === "late") await late;
      return response(texts, { id: texts[0]! });
    },
    1,
  );
  const gateway = createModelGateway(config);
  await assert.rejects(
    () =>
      gateway.embeddings.embedBatch({
        model: "embed",
        texts: ["known", "fail", "late"],
      }),
    /batch failed/,
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.usage?.totalTokens, 37);
  assert.deepEqual(errors[0]!.observation?.identity.providerRequestIds, [
    "known",
  ]);
  assert.ok(
    errors[0]!.observation?.diagnostics?.some(
      (item) => item.code === "EMBEDDING_BATCH_INCOMPLETE",
    ),
  );
  const snapshot = JSON.stringify(errors[0]);
  releaseLate();
  await tick();
  await tick();
  assert.equal(JSON.stringify(errors[0]), snapshot);
  const next = await gateway.embeddings.embed({ model: "embed", text: "next" });
  assert.equal(next.usage?.totalTokens, 37);
  assert.deepEqual(next.observation?.identity.providerRequestIds, ["next"]);
});

test("an aborted logical call ignores a non-cooperative HTTP response that completes later", async () => {
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { config, errors } = fixture(
    "openai-compatible",
    async (input, init) => {
      const texts = await inputs(input, init);
      started();
      await held;
      return response(texts, { id: "late-aborted-id" });
    },
  );
  const controller = new AbortController();
  const pending = createModelGateway(config).embeddings.embed(
    { model: "embed", text: "held" },
    { signal: controller.signal },
  );
  await start;
  controller.abort();
  await assert.rejects(() => pending);
  assert.equal(errors[0]!.usage, undefined);
  const snapshot = JSON.stringify(errors[0]);
  release();
  await tick();
  await tick();
  assert.equal(JSON.stringify(errors[0]), snapshot);
});

test("large embedding vectors pass through the real SDK with one parse, no Response clone and no vector copy", async () => {
  let parses = 0;
  let parsed: { data: { embedding: number[] }[] } | undefined;
  const vector = Array.from({ length: 100_000 }, (_, index) => index / 100_000);
  const { config } = fixture("openai-compatible", async (input, init) => {
    const responseObject = response(await inputs(input, init), {
      vector,
      id: "large-vector",
    });
    responseObject.clone = () => {
      throw new Error("must not clone the vector response");
    };
    const parse = responseObject.json.bind(responseObject);
    responseObject.json = async () => {
      parses++;
      const value = await parse();
      parsed = value;
      return value;
    };
    return responseObject;
  });
  const result = await createModelGateway(config).embeddings.embed({
    model: "embed",
    text: "large",
    encodingFormat: "float",
  });
  assert.equal(parses, 1);
  assert.strictEqual(result.embedding, parsed!.data[0]!.embedding);
  assert.equal(result.embedding.length, 100_000);
  assert.equal(result.usage?.totalTokens, 37);
  assert.ok(JSON.stringify(result.observation).length < 1000);
});
