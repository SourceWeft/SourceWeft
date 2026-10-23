import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway, TargetHealthRegistry } from "../src/index";
import type { ModelGatewayConfig } from "../src/types";
import { createJsonResponse } from "./helpers";

/**
 * The production shape this guards: one embedding alias served by the same
 * model on two Providers (`BAAI/bge-m3` on DeepInfra, `Pro/BAAI/bge-m3` on
 * SiliconFlow). Both targets answer through the injected fetch, keyed by
 * host, so the test never leaves the process.
 */
function twoProviderConfig(
  primary: typeof globalThis.fetch,
  backup: typeof globalThis.fetch,
  overrides: Partial<ModelGatewayConfig> = {},
): ModelGatewayConfig {
  return {
    maxRetries: 0,
    timeoutMs: 10_000,
    targetHealth: new TargetHealthRegistry(),
    providers: {
      deepinfra: {
        kind: "deepinfra",
        baseUrl: "https://primary.invalid/v1",
        apiKey: "primary-key",
      },
      "siliconflow-cn": {
        kind: "siliconflow-cn",
        baseUrl: "https://backup.invalid/v1",
        apiKey: "backup-key",
      },
    },
    modelRoutes: {
      "embed-default": {
        strategy: "priority",
        targets: [
          { provider: "deepinfra", model: "BAAI/bge-m3", priority: 1 },
          {
            provider: "siliconflow-cn",
            model: "Pro/BAAI/bge-m3",
            priority: 2,
          },
        ],
      },
    },
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      return url.host === "primary.invalid"
        ? primary(input, init)
        : backup(input, init);
    },
    ...overrides,
  };
}

async function requestedInputs(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) {
  const body = (await new Request(input, init).json()) as {
    model: string;
    input: string | string[];
  };
  return {
    model: body.model,
    inputs: Array.isArray(body.input) ? body.input : [body.input],
  };
}

function vectors(texts: string[], model: string) {
  return createJsonResponse({
    object: "list",
    model,
    data: texts.map((_text, index) => ({
      object: "embedding",
      index,
      embedding: [index, 0.5, 1],
    })),
    usage: { prompt_tokens: 3, total_tokens: 3 },
  });
}

const failures: Array<{
  name: string;
  primary: typeof globalThis.fetch;
}> = [
  {
    name: "402 (account balance)",
    primary: async () =>
      createJsonResponse(
        { error: { message: "Insufficient balance", type: "payment" } },
        { status: 402 },
      ),
  },
  {
    name: "503 (upstream down)",
    primary: async () =>
      createJsonResponse(
        { error: { message: "Service unavailable" } },
        { status: 503 },
      ),
  },
  {
    name: "request timeout",
    primary: (_input, init) =>
      new Promise((_resolve, reject) => {
        // Never answer; the per-attempt timeout aborts the request. The
        // timeout signal does not keep Node's event loop alive on its own, so
        // hold it open until the abort arrives.
        const keepAlive = setInterval(() => {}, 1_000);
        init?.signal?.addEventListener("abort", () => {
          clearInterval(keepAlive);
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      }),
  },
];

for (const failure of failures) {
  test(`embeddings.embed fails over to the same model on the second Provider after a ${failure.name}`, async () => {
    const calls: string[] = [];
    const gateway = createModelGateway(
      twoProviderConfig(
        async (input, init) => {
          calls.push("deepinfra");
          return failure.primary(input, init);
        },
        async (input, init) => {
          calls.push("siliconflow-cn");
          const { model, inputs } = await requestedInputs(input, init);
          return vectors(inputs, model);
        },
        failure.name === "request timeout" ? { timeoutMs: 50 } : {},
      ),
    );

    const result = await gateway.embeddings.embed({
      model: "embed-default",
      text: "hello",
      encodingFormat: "float",
    });

    assert.deepEqual(calls, ["deepinfra", "siliconflow-cn"]);
    assert.equal(result.provider, "siliconflow-cn");
    assert.equal(result.providerModel, "Pro/BAAI/bge-m3");
    assert.deepEqual(result.embedding, [0, 0.5, 1]);
  });
}

test("embeddings.embedBatch fails over to the second Provider and keeps every input", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoProviderConfig(
      async () => {
        calls.push("deepinfra");
        return createJsonResponse(
          { error: { message: "Insufficient balance" } },
          { status: 402 },
        );
      },
      async (input, init) => {
        calls.push("siliconflow-cn");
        const { model, inputs } = await requestedInputs(input, init);
        assert.equal(model, "Pro/BAAI/bge-m3");
        return vectors(inputs, model);
      },
    ),
  );

  const result = await gateway.embeddings.embedBatch({
    model: "embed-default",
    texts: ["hello", "world"],
    encodingFormat: "float",
  });

  assert.deepEqual(calls, ["deepinfra", "siliconflow-cn"]);
  assert.equal(result.provider, "siliconflow-cn");
  assert.deepEqual(result.embeddings, [
    [0, 0.5, 1],
    [1, 0.5, 1],
  ]);
});

test("embeddings.embed does not fail over on a request error", async () => {
  const calls: string[] = [];
  const gateway = createModelGateway(
    twoProviderConfig(
      async () => {
        calls.push("deepinfra");
        return createJsonResponse(
          { error: { message: "input too long" } },
          { status: 400 },
        );
      },
      async () => {
        calls.push("siliconflow-cn");
        return vectors(["hello"], "Pro/BAAI/bge-m3");
      },
    ),
  );

  await assert.rejects(
    gateway.embeddings.embed({
      model: "embed-default",
      text: "hello",
      encodingFormat: "float",
    }),
    (error: { code?: string }) => error.code === "BAD_REQUEST",
  );
  assert.deepEqual(calls, ["deepinfra"]);
});
