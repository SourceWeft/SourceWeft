import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ChatOpenAICompletions } from "@langchain/openai";
import { createLangChainChatModel } from "../src/bridge/utils";
import { createModelGateway, ModelGatewayError } from "../src/index";
import { resolveRequestDefaults } from "../src/request-options";
import { TargetHealthRegistry } from "../src/target-health";
import type {
  ModelGatewayConfig,
  ProviderKind,
  RequestOptions,
} from "../src/types";
import { createJsonResponse, createSseResponse } from "./helpers";

const messages = [{ role: "user" as const, content: "hello" }];
const payload = { model: "test", messages };

function config(
  fetch: typeof globalThis.fetch,
  kind: ProviderKind = "openai-compatible",
): ModelGatewayConfig {
  return {
    fetch,
    timeoutMs: 5_000,
    maxRetries: 3,
    targetHealth: new TargetHealthRegistry(),
    providers: {
      first: {
        kind,
        baseUrl: "https://first.example/v1",
        apiKey: "test-key",
        timeoutMs: 120_000,
        maxRetries: 0,
      },
    },
    modelRoutes: {
      test: {
        strategy: "priority",
        targets: [{ provider: "first", model: "test-model", priority: 1 }],
      },
    },
  };
}

function success(stream = false) {
  const choice = {
    index: 0,
    message: { role: "assistant", content: "hello" },
    finish_reason: "stop",
  };
  if (stream)
    return createSseResponse([
      `data: ${JSON.stringify({ id: "request-options", model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "request-options", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  return createJsonResponse({
    id: "request-options",
    model: "test-model",
    choices: [choice],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

test("request > target > global defaults preserve provider 120s and zero retries", () => {
  const global = { timeoutMs: 30_000, maxRetries: 2 };
  const target = { timeoutMs: 120_000, maxRetries: 0 };
  assert.deepEqual(resolveRequestDefaults(global, target), target);
  assert.deepEqual(
    resolveRequestDefaults(global, target, { timeoutMs: 42, maxRetries: 1 }),
    { timeoutMs: 42, maxRetries: 1 },
  );
  assert.deepEqual(resolveRequestDefaults(global, {}), global);
});

const chatKinds: ProviderKind[] = [
  "openai-compatible",
  "openrouter",
  "cloudflare-aig",
  "deepinfra",
  "deepseek",
  "siliconflow-cn",
  "azure-openai",
  "anthropic",
  "gemini",
];
for (const kind of chatKinds) {
  test(`${kind} real SDK: provider zero retries and wrapped POLICY both stop after one HTTP request`, async (t) => {
    const previous = process.env.AZURE_OPENAI_API_VERSION;
    process.env.AZURE_OPENAI_API_VERSION = "2024-10-21";
    t.after(() => {
      if (previous === undefined) delete process.env.AZURE_OPENAI_API_VERSION;
      else process.env.AZURE_OPENAI_API_VERSION = previous;
    });
    let count = 0;
    const gateway = createModelGateway(
      config(async () => {
        count++;
        return createJsonResponse(
          { error: { message: "temporarily unavailable" } },
          { status: 503 },
        );
      }, kind),
    );
    await assert.rejects(gateway.chat.complete(payload));
    assert.equal(count, 1);

    let deniedCount = 0;
    const refused = createModelGateway(
      config(async () => {
        deniedCount++;
        throw new ModelGatewayError({
          code: "POLICY",
          message: "test host refusal",
          retryable: false,
        });
      }, kind),
    );
    await assert.rejects(
      refused.chat.complete(payload, { maxRetries: 3 }),
      (error: unknown) =>
        ModelGatewayError.isInstance(error) && error.code === "POLICY",
    );
    assert.equal(deniedCount, 1);
  });
}

for (const kind of [
  "openai-compatible",
  "deepinfra",
  "siliconflow-cn",
  "azure-openai",
  "gemini",
] as ProviderKind[]) {
  test(`${kind} real embedding SDK honors retries and cancellation without per-call SDK options`, async (t) => {
    const previous = process.env.AZURE_OPENAI_API_VERSION;
    process.env.AZURE_OPENAI_API_VERSION = "2024-10-21";
    t.after(() => {
      if (previous === undefined) delete process.env.AZURE_OPENAI_API_VERSION;
      else process.env.AZURE_OPENAI_API_VERSION = previous;
    });
    let count = 0;
    const gateway = createModelGateway(
      config(async () => {
        count++;
        return createJsonResponse(
          { error: { message: "temporarily unavailable" } },
          { status: 503 },
        );
      }, kind),
    );
    await assert.rejects(
      gateway.embeddings.embedBatch({ model: "test", texts: ["a"] }),
    );
    assert.equal(count, 1);

    let deniedCount = 0;
    const refused = createModelGateway(
      config(async () => {
        deniedCount++;
        throw new ModelGatewayError({
          code: "POLICY",
          message: "test host refusal",
          retryable: false,
        });
      }, kind),
    );
    await assert.rejects(
      refused.embeddings.embed({ model: "test", text: "a" }, { maxRetries: 3 }),
      (error: unknown) =>
        ModelGatewayError.isInstance(error) && error.code === "POLICY",
    );
    assert.equal(deniedCount, 1);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      gateway.embeddings.embed(
        { model: "test", text: "a" },
        { signal: controller.signal },
      ),
    );
    assert.equal(count, 1, "pre-aborted request never reaches fetch");
  });
}

test("real chat SDK request override enables exactly one retry; global defaults also reach the SDK", async () => {
  for (const source of ["request", "global"] as const) {
    let count = 0;
    const settings = config(async () =>
      ++count === 1
        ? createJsonResponse({ error: { message: "retry" } }, { status: 503 })
        : success(),
    );
    if (source === "global") {
      delete settings.providers!.first!.maxRetries;
      settings.maxRetries = 1;
    }
    await createModelGateway(settings).chat.complete(
      payload,
      source === "request" ? { maxRetries: 1 } : undefined,
    );
    assert.equal(count, 2);
  }
});

test("real embedding SDK request retry override is effective", async () => {
  let count = 0;
  const settings = config(async () =>
    ++count === 1
      ? createJsonResponse({ error: { message: "retry" } }, { status: 503 })
      : createJsonResponse({ data: [{ index: 0, embedding: [1, 2] }] }),
  );
  const result = await createModelGateway(settings).embeddings.embed(
    { model: "test", text: "a", encodingFormat: "float" },
    { maxRetries: 1 },
  );
  assert.deepEqual(result.embedding, [1, 2]);
  assert.equal(count, 2);
});

test("raw rerank preserves zero retries, honors request retry count, and never retries bad requests", async () => {
  for (const [status, maxRetries, expected] of [
    [503, 0, 1],
    [503, 1, 2],
    [400, 3, 1],
  ] as const) {
    let count = 0;
    const settings = config(async () => {
      count++;
      return createJsonResponse(
        { error: { message: "upstream failure" } },
        { status },
      );
    });
    await assert.rejects(
      createModelGateway(settings).rerank.rank(
        { model: "test", query: "a", documents: ["b"] },
        { maxRetries },
      ),
    );
    assert.equal(count, expected);
  }
});

test("injected reranker respects attempt timeout without adding a second retry owner", async () => {
  let calls = 0;
  let finished = false;
  let signal: AbortSignal | undefined;
  const settings = config(async () => {
    throw new Error("injected reranker must not use gateway HTTP");
  });
  settings.langchainFactories = {
    createReranker: ({ options }) => {
      signal = options?.signal;
      return {
        rerank: async () => {
          calls++;
          await delay(80);
          finished = true;
          return [{ index: 0, relevanceScore: 1 }];
        },
      };
    },
  };
  await assert.rejects(
    createModelGateway(settings).rerank.rank(
      { model: "test", query: "a", documents: ["b"] },
      { timeoutMs: 10, maxRetries: 3 },
    ),
    (error: unknown) =>
      ModelGatewayError.isInstance(error) && error.code === "TIMEOUT",
  );
  assert.equal(finished, false);
  assert.equal(signal?.aborted, true);
  await delay(100);
  assert.equal(calls, 1);
});

test("timeout is fresh per target and caller abort stops both retry and failover", async () => {
  const calls: string[] = [];
  const settings = config(async (input, init) => {
    const request = new Request(input, init);
    calls.push(new URL(request.url).hostname);
    if (request.url.startsWith("https://first.")) {
      await delay(1_000, undefined, { signal: request.signal });
    }
    return success();
  });
  settings.providers!.first!.timeoutMs = 25;
  settings.providers!.second = {
    kind: "openai-compatible",
    baseUrl: "https://second.example/v1",
    apiKey: "second-key",
    timeoutMs: 1_000,
    maxRetries: 0,
  };
  settings.modelRoutes!.test!.targets.push({
    provider: "second",
    model: "test-model",
    priority: 2,
  });
  const result = await createModelGateway(settings).chat.complete(payload);
  assert.equal(result.provider, "second");
  assert.deepEqual(calls, ["first.example", "second.example"]);

  calls.length = 0;
  settings.targetHealth = new TargetHealthRegistry();
  settings.providers!.first!.timeoutMs = 5_000;
  const controller = new AbortController();
  const running = createModelGateway(settings).chat.complete(payload, {
    maxRetries: 3,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running);
  await delay(30);
  assert.deepEqual(calls, ["first.example"]);
});

test("abort during SDK retry backoff does not send a delayed request or fail over", async () => {
  let count = 0;
  const controller = new AbortController();
  const settings = config(async () => {
    count++;
    setTimeout(() => controller.abort(), 20);
    return createJsonResponse({ error: { message: "retry" } }, { status: 503 });
  });
  const started = Date.now();
  await assert.rejects(
    createModelGateway(settings).chat.complete(payload, {
      maxRetries: 3,
      signal: controller.signal,
    }),
  );
  assert.ok(Date.now() - started < 500, "abort interrupts the retry wait");
  await delay(2_100);
  assert.equal(count, 1, "no queued retry performs IO after abort");
});

test("both stream entry points interrupt first-chunk retry backoff on caller abort", async () => {
  const counts: (() => number)[] = [];
  for (const entry of ["gateway", "langchain"] as const) {
    let count = 0;
    const controller = new AbortController();
    const settings = config(async () => {
      count++;
      setTimeout(() => controller.abort(), 20);
      return createJsonResponse(
        { error: { message: "retry" } },
        { status: 503 },
      );
    });
    const options = { signal: controller.signal, maxRetries: 3 };
    const started = Date.now();
    if (entry === "gateway") {
      const events = [];
      for await (const event of createModelGateway(settings).chat.stream(
        payload,
        options,
      ))
        events.push(event);
      assert.equal(events.at(-1)?.type, "error");
    } else {
      const model = await createLangChainChatModel({
        modelAlias: "test",
        config: settings,
      });
      await assert.rejects(async () => {
        for await (const _ of await model.stream("hello", options)) {
          /* no committed output */
        }
      });
    }
    assert.ok(Date.now() - started < 500, entry);
    counts.push(() => count);
  }
  await delay(2_100);
  assert.deepEqual(
    counts.map((count) => count()),
    [1, 1],
  );
});

test("LangChain invoke and stream honor per-call options, with a fresh timeout on later invocations", async (t) => {
  // Streaming invoke always estimates tokens after reading SSE. Its tokenizer
  // downloads unrelated data on first use; fix only this public counting seam
  // locally. This test verifies transport/options/callbacks, not token accuracy.
  t.mock.method(ChatOpenAICompletions.prototype, "getNumTokens", async () => 1);
  // This test observes a signal after its request has already completed. Node
  // keeps timeout/composite dependencies weakly, so retain the observed chain
  // until the assertions finish; use the original composition and real timers.
  const observedSignalChain: AbortSignal[] = [];
  const composeSignals = AbortSignal.any.bind(AbortSignal);
  t.mock.method(AbortSignal, "any", (sources: AbortSignal[]) => {
    const composed = composeSignals(sources);
    observedSignalChain.push(...sources, composed);
    return composed;
  });
  t.after(() => {
    observedSignalChain.length = 0;
  });
  const signals: AbortSignal[] = [];
  const settings = config(async (input, init) => {
    const request = new Request(input, init);
    signals.push(request.signal);
    const body = (await request.json()) as { stream?: boolean };
    return success(body.stream);
  });
  settings.providers!.first!.timeoutMs = 100;
  const model = await createLangChainChatModel({
    modelAlias: "test",
    config: settings,
  });
  let tokens = 0;
  const callbacks = [
    {
      handleLLMNewToken() {
        tokens++;
      },
    },
  ];
  await model.invoke("hello", { callbacks });
  await delay(130);
  await model.invoke("hello", { timeoutMs: 1_000, callbacks } as never);
  for await (const _ of await model.stream("hello", {
    timeoutMs: 1_000,
    maxRetries: 0,
  } as never)) {
    /* consume real SDK stream */
  }
  assert.equal(signals.length, 3);
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
  assert.notEqual(signals[0], signals[1]);
  assert.ok(tokens >= 2, "each rebuilt invoke still delivers token callbacks");
});

test("LangChain withConfig keeps provider budgets, per-call overrides, callbacks and bound tools", async (t) => {
  t.mock.method(ChatOpenAICompletions.prototype, "getNumTokens", async () => 1);
  let count = 0;
  let sentTools = false;
  let fail = true;
  const settings = config(async (input, init) => {
    count++;
    const body = (await new Request(input, init).json()) as {
      stream?: boolean;
      tools?: unknown[];
    };
    sentTools ||= !!body.tools?.length;
    return fail
      ? createJsonResponse({ error: { message: "retry" } }, { status: 503 })
      : success(body.stream);
  });
  let starts = 0;
  let tokens = 0;
  const model = await createLangChainChatModel({
    modelAlias: "test",
    config: settings,
  });
  const withConfig = model.withConfig({
    callbacks: [
      {
        handleChatModelStart() {
          starts++;
        },
      },
    ],
    maxRetries: 0,
  } as never);
  await assert.rejects(withConfig.invoke("hello"));
  assert.equal(count, 1, "withConfig cannot reintroduce SDK default retries");
  fail = false;
  await withConfig.invoke("hello", {
    callbacks: [
      {
        handleLLMNewToken() {
          tokens++;
        },
      },
    ],
  });
  assert.ok(starts >= 2, "bound callbacks survive call-option merge");
  assert.ok(tokens > 0, "per-call callbacks survive alongside bound callbacks");
  const bound = (
    model as unknown as { bindTools(tools: unknown[]): typeof model }
  ).bindTools([
    {
      type: "function",
      function: {
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: {} },
      },
    },
  ]);
  await bound.withConfig({ maxRetries: 0 } as never).invoke("hello");
  assert.equal(sentTools, true);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(withConfig.invoke("hello", { signal: aborted.signal }));
  assert.equal(count, 3, "withConfig cancellation never reaches HTTP");
});

test("withConfig and bindTools work in both orders and retain repeated SDK config merging", async (t) => {
  t.mock.method(ChatOpenAICompletions.prototype, "getNumTokens", async () => 1);
  const tools = [
    {
      type: "function",
      function: {
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  type Composable = Awaited<ReturnType<typeof createLangChainChatModel>> & {
    bindTools(tools: unknown[]): Composable;
    withConfig(config: Record<string, unknown>): Composable;
  };
  for (const configFirst of [true, false]) {
    let calls = 0;
    let callbackTags: string[] | undefined;
    const settings = config(async (input, init) => {
      calls++;
      const body = (await new Request(input, init).json()) as {
        stream?: boolean;
        tools?: { function: { name: string } }[];
      };
      assert.equal(body.tools?.[0]?.function.name, "lookup");
      assert.equal(
        body.stream,
        true,
        "invoke retains the existing streaming wire behavior",
      );
      return success(true);
    });
    const model = (await createLangChainChatModel({
      modelAlias: "test",
      config: settings,
    })) as Composable;
    const options = {
      timeoutMs: 500,
      maxRetries: 0,
      callbacks: [
        {
          handleChatModelStart(
            _model: unknown,
            _messages: unknown,
            _runId: unknown,
            _parent: unknown,
            _extra: unknown,
            tags: string[],
          ) {
            callbackTags = tags;
          },
        },
      ],
      tags: ["old"],
    };
    const configured = (
      configFirst
        ? model.withConfig(options).bindTools(tools)
        : model.bindTools(tools).withConfig(options)
    ) as Composable;
    const twice = configured.withConfig({ tags: ["new"] }) as Composable;
    await twice.invoke("hello");
    assert.equal(calls, 1);
    assert.ok(callbackTags?.includes("new"));
    assert.equal(
      callbackTags?.includes("old"),
      false,
      "SDK repeated withConfig replaces the same key",
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(twice.invoke("hello", { signal: controller.signal }));
    assert.equal(calls, 1);
  }
});

test("public SDK batch schedules facade invocations with separate per-item budgets and returnExceptions", async (t) => {
  t.mock.method(ChatOpenAICompletions.prototype, "getNumTokens", async () => 1);
  for (const configured of [false, true]) {
    const signals: AbortSignal[] = [];
    const settings = config(async (input, init) => {
      const request = new Request(input, init);
      signals.push(request.signal);
      if (signals.length === 1)
        await delay(500, undefined, { signal: request.signal });
      return success(true);
    });
    const model = await createLangChainChatModel({
      modelAlias: "test",
      config: settings,
    });
    const runnable = configured ? model.withConfig({ tags: ["batch"] }) : model;
    const result = await runnable.batch(
      ["slow", "fast"],
      [
        { timeoutMs: 25, maxRetries: 0 },
        { timeoutMs: 1_000, maxRetries: 0 },
      ] as never,
      { maxConcurrency: 1, returnExceptions: true },
    );
    assert.ok(result[0] instanceof Error);
    assert.equal((result[1] as { content: unknown }).content, "hello");
    assert.equal(signals.length, 2);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals[1]?.aborted, false);
    assert.notEqual(signals[0], signals[1]);
  }
});

test("withConfig keeps structured output parsing and its request timeout/cancellation", async (t) => {
  t.mock.method(ChatOpenAICompletions.prototype, "getNumTokens", async () => 1);
  let calls = 0;
  let hang = false;
  const signals: AbortSignal[] = [];
  const settings = config(async (input, init) => {
    calls++;
    const request = new Request(input, init);
    signals.push(request.signal);
    const body = (await request.json()) as {
      tools: { function: { name: string } }[];
    };
    assert.equal(body.tools[0]?.function.name, "extract");
    if (hang) await delay(500, undefined, { signal: request.signal });
    return createSseResponse([
      `data: ${JSON.stringify({ id: "structured", model: "test-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "extract", arguments: '{"answer":42}' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "structured", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  const model = await createLangChainChatModel({
    modelAlias: "test",
    config: settings,
  });
  const configured = model.withConfig({
    maxRetries: 0,
    timeoutMs: 1_000,
  } as never) as unknown as {
    withStructuredOutput(
      schema: Record<string, unknown>,
      options: Record<string, unknown>,
    ): {
      invoke(
        input: unknown,
        options?: Record<string, unknown>,
      ): Promise<unknown>;
    };
  };
  const structured = configured.withStructuredOutput(
    {
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
    },
    { method: "functionCalling", name: "extract" },
  );
  assert.deepEqual(await structured.invoke("answer"), { answer: 42 });
  hang = true;
  await assert.rejects(structured.invoke("answer", { timeoutMs: 25 }));
  assert.equal(signals[1]?.aborted, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    structured.invoke("answer", { signal: controller.signal }),
  );
  assert.equal(calls, 2, "structured output cancellation cannot reach HTTP");
});

test("raw rerank, ASR, TTS and image transports honor timeout and zero retries", async () => {
  for (const operation of ["rerank", "asr", "tts", "images"] as const) {
    let count = 0;
    const signals: AbortSignal[] = [];
    const settings = config(async (input, init) => {
      count++;
      const request = new Request(input, init);
      signals.push(request.signal);
      await delay(1_000, undefined, { signal: request.signal });
      return createJsonResponse({});
    });
    settings.providers!.first!.supports = ["rerank", "asr", "tts", "image"];
    const gateway = createModelGateway(settings);
    const options: RequestOptions = { timeoutMs: 20, maxRetries: 0 };
    const run =
      operation === "rerank"
        ? () =>
            gateway.rerank.rank(
              { model: "test", query: "a", documents: ["b"] },
              options,
            )
        : operation === "asr"
          ? () =>
              gateway.asr.transcribe(
                {
                  model: "test",
                  audio: new Uint8Array([1, 2]),
                  fileName: "a.wav",
                  mimeType: "audio/wav",
                },
                options,
              )
          : operation === "tts"
            ? () =>
                gateway.tts.speech(
                  { model: "test", input: "hello", voice: "alloy" },
                  options,
                )
            : () =>
                gateway.images.generate(
                  { model: "test", prompt: "a tree" },
                  options,
                );
    await assert.rejects(run());
    assert.equal(count, 1, operation);
    assert.equal(signals[0]?.aborted, true, operation);
  }
});

test(
  "actual localhost HTTP request is aborted by provider timeout and by embedding caller cancellation",
  { timeout: 5_000 },
  async (t) => {
    let requests = 0;
    let closed = 0;
    let receivedEmbedding!: () => void;
    let closedBothRequests!: () => void;
    const embeddingReceived = new Promise<void>((resolve) => {
      receivedEmbedding = resolve;
    });
    const requestsClosed = new Promise<void>((resolve) => {
      closedBothRequests = resolve;
    });
    const server = createServer((req) => {
      requests++;
      if (req.url === "/v1/embeddings") receivedEmbedding();
      req.on("close", () => {
        closed++;
        if (closed === 2) closedBothRequests();
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const settings = config(globalThis.fetch);
    settings.providers!.first!.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    settings.providers!.first!.timeoutMs = 100;
    await assert.rejects(
      createModelGateway(settings).chat.complete(payload),
      (error: unknown) =>
        ModelGatewayError.isInstance(error) && error.code === "TIMEOUT",
    );
    assert.equal(requests, 1, "provider timeout aborts an actual HTTP request");
    const controller = new AbortController();
    const reason = new DOMException(
      "embedding cancelled by caller",
      "AbortError",
    );
    const embedding = createModelGateway(settings).embeddings.embed(
      { model: "test", text: "a" },
      { timeoutMs: 1_000, signal: controller.signal },
    );
    const rejectedEmbedding = assert.rejects(
      embedding,
      (error: unknown) =>
        ModelGatewayError.isInstance(error) && error.cause === reason,
    );
    // Cancel only after the server has received the embedding request. A fixed
    // delay can expire before dispatch on a busy test host and test no HTTP abort.
    await embeddingReceived;
    controller.abort(reason);
    await rejectedEmbedding;
    await requestsClosed;
    assert.equal(requests, 2);
    assert.equal(closed, 2);
  },
);
