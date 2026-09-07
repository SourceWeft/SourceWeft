import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createChatModel, createEmbeddingsModel } from "../src/bridge/utils";
import { resolveModelGatewayConfig } from "../src/config";
import { createModelGateway, ModelGatewayError } from "../src/index";
import type {
  ModelGatewayConfig,
  ProviderKind,
  ResolvedRequestTarget,
} from "../src/types";
import { createJsonResponse, createSseResponse } from "./helpers";

const messages = [{ role: "user" as const, content: "hello" }];
const model = "network-test-model";

// Each test exercises the installed SDK against a protocol response, while any
// accidental use of the ambient fetch fails instead of reaching the network.
function isolateAmbientCredentials(t: TestContext) {
  const values = {
    OPENAI_API_KEY: "ambient-openai-key-must-not-be-sent",
    OPENAI_ADMIN_KEY: "ambient-admin-key-must-not-be-sent",
    ANTHROPIC_API_KEY: "ambient-anthropic-key-must-not-be-sent",
    ANTHROPIC_AUTH_TOKEN: "ambient-anthropic-token-must-not-be-sent",
    AZURE_OPENAI_API_KEY: "ambient-azure-key-must-not-be-sent",
    AZURE_OPENAI_API_VERSION: "2024-10-21",
    AZURE_OPENAI_API_INSTANCE_NAME: "ambient-instance-must-not-be-used",
    AZURE_OPENAI_API_DEPLOYMENT_NAME: "ambient-deployment-must-not-be-used",
    AZURE_OPENAI_API_EMBEDDINGS_DEPLOYMENT_NAME:
      "ambient-embedding-must-not-be-used",
    GOOGLE_API_KEY: "ambient-google-key-must-not-be-sent",
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const ambient = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("The SDK bypassed its injected fetch");
  });
  t.after(() => assert.equal(ambient.mock.callCount(), 0));
}

function providerConfig(kind: ProviderKind, fetch: typeof globalThis.fetch) {
  return {
    fetch,
    maxRetries: 0,
    providers: {
      local: {
        kind,
        baseUrl: `http://models.internal:8080${kind === "anthropic" || kind === "azure-openai" ? "" : "/v1"}`,
        apiKey: "workspace-key",
      },
    },
    modelRoutes: {
      "network-test": {
        strategy: "priority",
        targets: [{ provider: "local", model, priority: 1 }],
      },
    },
  } satisfies ModelGatewayConfig;
}

function openAiChatResponse(stream: boolean) {
  if (stream) {
    return createSseResponse([
      `data: ${JSON.stringify({
        id: "chat-network",
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chat-network",
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  }
  return createJsonResponse({
    id: "chat-network",
    object: "chat.completion",
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

const compatibleChatKinds: ProviderKind[] = [
  "openai",
  "openai-compatible",
  "openrouter",
  "deepinfra",
  "deepseek",
  "cloudflare-aig",
  "siliconflow-cn",
];

for (const kind of compatibleChatKinds) {
  for (const stream of [false, true]) {
    test(`${kind} ${stream ? "stream" : "chat"} uses injected fetch and the explicit credential`, async (t) => {
      isolateAmbientCredentials(t);
      const requests: Request[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const body = await request.json();
        assert.equal(body.stream, stream);
        assert.equal(body.model, model);
        return openAiChatResponse(stream);
      };
      const gateway = createModelGateway(providerConfig(kind, fetch));

      if (stream) {
        let content = "";
        for await (const event of gateway.chat.stream(
          { model: "network-test", messages },
          { maxRetries: 0 },
        )) {
          assert.notEqual(event.type, "error");
          if (event.type === "chunk") content += event.chunk.content;
        }
        assert.equal(content, "hello");
      } else {
        const result = await gateway.chat.complete(
          { model: "network-test", messages },
          { maxRetries: 0 },
        );
        assert.equal(result.raw.content, "hello");
      }

      assert.equal(requests.length, 1);
      const request = requests[0]!;
      assert.equal(
        request.url,
        `http://models.internal:8080/v1${kind === "deepinfra" ? "/openai" : ""}/chat/completions`,
      );
      assert.equal(
        request.headers.get("authorization"),
        "Bearer workspace-key",
      );
      assert.doesNotMatch(JSON.stringify([...request.headers]), /ambient-/);
    });
  }
}

for (const kind of [
  "openai",
  "openai-compatible",
  "openrouter",
  "deepinfra",
  "siliconflow-cn",
] satisfies ProviderKind[]) {
  test(`${kind} query and batch embeddings use injected fetch with the explicit credential`, async (t) => {
    isolateAmbientCredentials(t);
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const body = await request.json();
      assert.equal(body.model, model);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return createJsonResponse({
        object: "list",
        model,
        data: inputs.map((_: string, index: number) => ({
          object: "embedding",
          index,
          embedding: [index, 0.5],
        })),
        usage: { prompt_tokens: 2, total_tokens: 2 },
      });
    };
    const gateway = createModelGateway(providerConfig(kind, fetch));
    const result = await gateway.embeddings.embed({
      model: "network-test",
      text: "hello",
      encodingFormat: "float",
    });
    assert.deepEqual(result.embedding, [0, 0.5]);
    const batch = await gateway.embeddings.embedBatch({
      model: "network-test",
      texts: ["hello", "world"],
      encodingFormat: "float",
    });
    assert.deepEqual(batch.embeddings, [
      [0, 0.5],
      [1, 0.5],
    ]);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(
        request.url,
        `http://models.internal:8080/v1${kind === "deepinfra" ? "/openai" : ""}/embeddings`,
      );
      assert.equal(
        request.headers.get("authorization"),
        "Bearer workspace-key",
      );
      assert.doesNotMatch(JSON.stringify([...request.headers]), /ambient-/);
    }
  });
}

test("Azure chat and embeddings use injected fetch and the explicit API key", async (t) => {
  isolateAmbientCredentials(t);
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname.endsWith("/embeddings")) {
      assert.equal((await request.json()).encoding_format, "base64");
      const vector = Buffer.alloc(8);
      vector.writeFloatLE(0.25, 0);
      vector.writeFloatLE(0.5, 4);
      return createJsonResponse({
        data: [{ index: 0, embedding: vector.toString("base64") }],
      });
    }
    return openAiChatResponse(false);
  };
  const gateway = createModelGateway(providerConfig("azure-openai", fetch));
  const result = await gateway.chat.complete(
    { model: "network-test", messages },
    { maxRetries: 0 },
  );
  assert.equal(result.raw.content, "hello");
  const embedding = await gateway.embeddings.embed({
    model: "network-test",
    text: "hello",
  });
  assert.deepEqual(embedding.embedding, [0.25, 0.5]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, "http://models.internal:8080");
    assert.match(url.pathname, /\/openai\/deployments\/network-test-model\//);
    assert.equal(url.searchParams.get("api-version"), "2024-10-21");
    assert.equal(request.headers.get("api-key"), "workspace-key");
    assert.doesNotMatch(JSON.stringify([...request.headers]), /ambient-/);
  }
});

test("Anthropic uses injected fetch and does not add the ambient auth token", async (t) => {
  isolateAmbientCredentials(t);
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return createJsonResponse({
      id: "msg-network",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  };
  const gateway = createModelGateway(providerConfig("anthropic", fetch));
  const result = await gateway.chat.complete(
    { model: "network-test", messages, maxTokens: 32 },
    { maxRetries: 0 },
  );
  assert.equal(result.raw.content, "hello");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "http://models.internal:8080/v1/messages");
  assert.equal(requests[0]!.headers.get("x-api-key"), "workspace-key");
  assert.equal(requests[0]!.headers.get("authorization"), null);
  assert.doesNotMatch(JSON.stringify([...requests[0]!.headers]), /ambient-/);
});

test("Anthropic streaming uses the same injected fetch and explicit credential", async (t) => {
  isolateAmbientCredentials(t);
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    assert.equal((await request.json()).stream, true);
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg-network",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    return createSseResponse(
      events.map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      ),
    );
  };
  const gateway = createModelGateway(providerConfig("anthropic", fetch));
  let content = "";
  for await (const event of gateway.chat.stream(
    { model: "network-test", messages, maxTokens: 32 },
    { maxRetries: 0 },
  )) {
    assert.notEqual(event.type, "error");
    if (event.type === "chunk") content += event.chunk.content;
  }
  assert.equal(content, "hello");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "http://models.internal:8080/v1/messages");
  assert.equal(requests[0]!.headers.get("x-api-key"), "workspace-key");
  assert.equal(requests[0]!.headers.get("authorization"), null);
  assert.doesNotMatch(JSON.stringify([...requests[0]!.headers]), /ambient-/);
});

test("BYOK reuses a globally disabled provider definition but never its credential", async (t) => {
  isolateAmbientCredentials(t);
  const requests: Request[] = [];
  const config = providerConfig("openai-compatible", async (input, init) => {
    requests.push(new Request(input, init));
    return openAiChatResponse(false);
  });
  const gateway = createModelGateway({
    ...config,
    providers: {
      local: {
        ...config.providers.local,
        enabled: false,
        byokEnabled: true,
        apiKey: "system-key-must-not-be-sent",
      },
    },
  });
  await assert.rejects(
    gateway.chat.complete({ model: "network-test", messages }),
    /No globally ready route target/,
  );
  const result = await gateway.chat.complete({
    model,
    messages,
    executionMode: "BYOK",
    byok: { provider: "local", apiKey: "user-byok-key" },
  });
  assert.equal(result.raw.content, "hello");
  assert.equal(result.routeDecision?.mode, "BYOK");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]!.headers.get("authorization"),
    "Bearer user-byok-key",
  );
  await assert.rejects(
    gateway.chat.complete({
      model,
      messages,
      executionMode: "BYOK",
      byok: { provider: "local" },
    }),
    (error: unknown) => error instanceof ModelGatewayError && !error.retryable,
  );
  assert.equal(requests.length, 1);
});

test("native Gemini chat and embeddings preserve a host transport policy refusal", async (t) => {
  isolateAmbientCredentials(t);
  let calls = 0;
  const refusal = new ModelGatewayError({
    code: "POLICY",
    message: "Endpoint is not allowed",
    retryable: false,
  });
  const gateway = createModelGateway(
    providerConfig("gemini", async () => {
      calls += 1;
      throw refusal;
    }),
  );
  const isHostRefusal = (error: unknown) => {
    assert.equal(error, refusal);
    return true;
  };
  await assert.rejects(
    gateway.chat.complete({ model: "network-test", messages }),
    isHostRefusal,
  );
  await assert.rejects(
    gateway.embeddings.embed({ model: "network-test", text: "hello" }),
    isHostRefusal,
  );
  assert.equal(calls, 2);
});

test("the bridge refuses missing chat and embeddings keys before an SDK can read ambient credentials", (t) => {
  isolateAmbientCredentials(t);
  const config = resolveModelGatewayConfig(
    providerConfig("openai", async () => {
      throw new Error("Missing credentials must fail before fetching");
    }),
  );
  const target: ResolvedRequestTarget = {
    provider: "local",
    providerKind: "openai",
    providerModel: model,
    baseUrl: "http://models.internal:8080/v1",
    apiKey: undefined,
    defaultHeaders: {},
    supports: ["chat", "embeddings"],
    routeDecision: {
      alias: "network-test",
      mode: "BYOK",
      strategy: "priority",
      provider: "local",
      providerKind: "openai",
    },
    requestMetadata: {},
  };
  const isCredentialPolicy = (error: unknown) => {
    assert.ok(error instanceof ModelGatewayError);
    assert.equal(error.code, "POLICY");
    assert.equal(error.retryable, false);
    assert.match(error.message, /explicit credential/);
    return true;
  };
  assert.throws(
    () => createChatModel({ config, target, payload: { model, messages } }),
    isCredentialPolicy,
  );
  assert.throws(
    () =>
      createEmbeddingsModel({
        config,
        target,
        payload: { model, text: "hello" },
      }),
    isCredentialPolicy,
  );
});

test("an SDK-wrapped transport policy refusal does not fail over to a second provider", async (t) => {
  isolateAmbientCredentials(t);
  const refusal = new ModelGatewayError({
    code: "POLICY",
    message: "Endpoint is not allowed",
    retryable: false,
  });
  const requests: Request[] = [];
  const config = providerConfig("openai-compatible", async (input, init) => {
    requests.push(new Request(input, init));
    throw refusal;
  });
  const gateway = createModelGateway({
    ...config,
    providers: {
      ...config.providers,
      second: {
        kind: "openai-compatible",
        baseUrl: "http://second.internal:8080/v1",
        apiKey: "second-key",
      },
    },
    modelRoutes: {
      "network-test": {
        strategy: "priority",
        targets: [
          { provider: "local", model, priority: 1 },
          { provider: "second", model, priority: 2 },
        ],
      },
    },
  });
  await assert.rejects(
    gateway.chat.complete(
      { model: "network-test", messages, fallbackPolicy: "configured" },
      { maxRetries: 0 },
    ),
    (error: unknown) => error === refusal,
  );
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]!.url).hostname, "models.internal");
});
