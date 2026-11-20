import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { createLangChainChatModel } from "../src/bridge/utils";
import { createModelGateway } from "../src/index";
import {
  mergeModelCallObservations,
  normalizeModelCallObservation,
} from "../src/observation/normalize";
import type {
  LangChainChatModelLike,
  ModelGatewayConfig,
  ObserveGenerationEnd,
  ObserveGenerationError,
  UsageInfo,
} from "../src/types";
import {
  createJsonResponse,
  createSseResponse,
  makeResolvedTarget,
} from "./helpers";

// Anthropic counts cached tokens outside `input_tokens` and spreads a streamed
// reply's usage over `message_start` and `message_delta`. The gateway reports
// one figure per call in its own convention: `inputTokens` includes the cache
// read and cache write tokens, which are also reported on their own.

const model = "claude-test";
const messages = [{ role: "user" as const, content: "hello" }];

/** `message_start` usage: 11 uncached, 3 read from cache, 2 written to it. */
const cachedStart = {
  input_tokens: 11,
  output_tokens: 1,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
};
const cachedTotals: UsageInfo = {
  inputTokens: 16,
  outputTokens: 25,
  totalTokens: 41,
  cacheReadTokens: 3,
  cacheWriteTokens: 2,
};

function isolate(t: TestContext) {
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    const previous = process.env[key];
    process.env[key] = "ambient-credential-must-not-be-sent";
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

function config(fetch: typeof globalThis.fetch): ModelGatewayConfig {
  return {
    fetch,
    maxRetries: 0,
    providers: {
      claude: {
        kind: "anthropic",
        baseUrl: "http://models.internal:8080",
        apiKey: "workspace-key",
      },
    },
    modelRoutes: {
      chat: {
        strategy: "priority",
        targets: [{ provider: "claude", model, priority: 1 }],
      },
    },
  };
}

function message(usage: Record<string, unknown>) {
  return createJsonResponse({
    id: "msg",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  });
}

function stream(
  startUsage: Record<string, unknown>,
  deltaUsage: Record<string, unknown>,
) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: startUsage,
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
      usage: deltaUsage,
    },
    { type: "message_stop" },
  ];
  return createSseResponse(
    events.map(
      (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    ),
  );
}

async function streamedUsage(fetch: typeof globalThis.fetch) {
  const gateway = createModelGateway(config(fetch));
  let usage: UsageInfo | undefined;
  for await (const event of gateway.chat.stream(
    { model: "chat", messages, maxTokens: 32 },
    { maxRetries: 0 },
  )) {
    assert.notEqual(event.type, "error");
    if (event.type === "metadata") usage = event.metadata.usage;
  }
  return usage;
}

test("Anthropic non-stream usage counts cached tokens inside inputTokens", async (t) => {
  isolate(t);
  const gateway = createModelGateway(
    config(async () => message({ ...cachedStart, output_tokens: 25 })),
  );
  const result = await gateway.chat.complete(
    { model: "chat", messages, maxTokens: 32 },
    { maxRetries: 0 },
  );
  assert.deepEqual(result.usage, cachedTotals);
});

test("Anthropic non-stream usage without caching reports zero cache tokens", async (t) => {
  isolate(t);
  const gateway = createModelGateway(
    config(async () => message({ input_tokens: 11, output_tokens: 25 })),
  );
  const result = await gateway.chat.complete(
    { model: "chat", messages, maxTokens: 32 },
    { maxRetries: 0 },
  );
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 25,
    totalTokens: 36,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

for (const [name, deltaUsage] of [
  ["only the output count", { output_tokens: 25 }],
  ["the cumulative totals", { ...cachedStart, output_tokens: 25 }],
] as const) {
  test(`Anthropic streamed usage is complete when message_delta carries ${name}`, async (t) => {
    isolate(t);
    assert.deepEqual(
      await streamedUsage(async () => stream(cachedStart, deltaUsage)),
      cachedTotals,
    );
  });
}

test("Anthropic streamed usage without caching keeps the input count", async (t) => {
  isolate(t);
  assert.deepEqual(
    await streamedUsage(async () =>
      stream({ input_tokens: 11, output_tokens: 1 }, { output_tokens: 25 }),
    ),
    {
      inputTokens: 11,
      outputTokens: 25,
      totalTokens: 36,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  );
});

/** The handler flags LangGraph's messages handlers carry (see stream-usage-capture). */
class StreamingHandler extends BaseCallbackHandler {
  name = "anthropic-usage";
  lc_prefer_streaming: boolean;
  lc_prefer_chat_model_stream_events: boolean;
  awaitHandlers: boolean;

  constructor(shape: "v2" | "v3") {
    super();
    this.lc_prefer_streaming = shape === "v2";
    this.lc_prefer_chat_model_stream_events = shape === "v3";
    this.awaitHandlers = shape === "v3";
  }

  handleLLMNewToken() {}

  handleChatModelStreamEvent() {}
}

async function agentUsage(fetch: typeof globalThis.fetch, shape: "v2" | "v3") {
  const ends: ObserveGenerationEnd[] = [];
  const agent = (await createLangChainChatModel({
    modelAlias: "chat",
    config: {
      ...config(fetch),
      observeSink: {
        onGenerationStart: () => {},
        onGenerationEnd: (event) => {
          ends.push(event);
        },
      },
    },
  })) as unknown as LangChainChatModelLike;
  await agent.invoke([{ role: "user", content: "hello" }], {
    callbacks: [new StreamingHandler(shape)],
  } as never);
  assert.equal(ends.length, 1);
  return ends[0]!.usage;
}

for (const shape of ["v2", "v3"] as const) {
  test(`an agent-driven Anthropic call (${shape} handler) reports complete usage`, async (t) => {
    isolate(t);
    assert.deepEqual(
      await agentUsage(
        async () => stream(cachedStart, { output_tokens: 25 }),
        shape,
      ),
      cachedTotals,
    );
  });
}

test("Anthropic usage ignores the provider's partial usage objects", () => {
  const observation = normalizeModelCallObservation({
    modelAlias: "chat",
    context: {
      target: makeResolvedTarget({
        provider: "claude",
        providerKind: "anthropic",
      }),
      modality: "chat",
      // What the last streamed chunk carries: the cache counts alone.
      rawResponse: {
        response_metadata: {
          usage: { cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
        },
      },
      // What `message_delta` carried on the wire.
      capturedUsage: { output_tokens: 25 },
      sdkUsage: {
        input_tokens: 16,
        output_tokens: 25,
        total_tokens: 41,
        input_token_details: { cache_creation: 2, cache_read: 3 },
      },
    },
  });
  assert.deepEqual(observation.usage, cachedTotals);
  assert.equal(observation.provenance.usage, "protocol:langchain.sdk_usage");
  assert.equal(observation.diagnostics, undefined);
});

test("an Anthropic chunk without LangChain usage reports none", () => {
  const observation = normalizeModelCallObservation({
    modelAlias: "chat",
    context: {
      target: makeResolvedTarget({
        provider: "claude",
        providerKind: "anthropic",
      }),
      modality: "chat",
      rawResponse: { response_metadata: { usage: { input_tokens: 11 } } },
      capturedUsage: { output_tokens: 25 },
    },
  });
  assert.equal(observation.usage, undefined);
  assert.equal(observation.provenance.usage, undefined);
});

// A streamed reply that never reaches `message_delta`: the caller stopped
// reading, a stream guard cut it, or the connection dropped. LangChain has
// published no usage by then, so what the provider reported in
// `message_start` is all there is to record for the call.

/** `cachedStart` in the gateway's convention: the input side of the call. */
const startTotals: UsageInfo = {
  inputTokens: 16,
  outputTokens: 1,
  totalTokens: 17,
  cacheReadTokens: 3,
  cacheWriteTokens: 2,
};

/** `message_start` and the first text, then the connection drops. */
function cutStream(startUsage: Record<string, unknown>) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: startUsage,
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
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = events[index++];
        if (next === undefined) {
          controller.error(new Error("socket hang up"));
          return;
        }
        controller.enqueue(encoder.encode(next));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function errorSink() {
  const errors: ObserveGenerationError[] = [];
  const ends: ObserveGenerationEnd[] = [];
  return {
    errors,
    ends,
    observeSink: {
      onGenerationStart: () => {},
      onGenerationEnd: (event: ObserveGenerationEnd) => {
        ends.push(event);
      },
      onGenerationError: (event: ObserveGenerationError) => {
        errors.push(event);
      },
    },
  };
}

test("an Anthropic stream that drops before message_delta records the usage from message_start", async (t) => {
  isolate(t);
  const sink = errorSink();
  const gateway = createModelGateway({
    ...config(async () => cutStream(cachedStart)),
    observeSink: sink.observeSink,
  });
  const seen: string[] = [];
  for await (const event of gateway.chat.stream(
    { model: "chat", messages, maxTokens: 32 },
    { maxRetries: 0 },
  )) {
    seen.push(event.type);
  }
  assert.equal(seen.at(-1), "error");
  assert.equal(sink.ends.length, 0);
  assert.equal(sink.errors.length, 1);
  assert.deepEqual(sink.errors[0]!.usage, startTotals);
  assert.equal(
    sink.errors[0]!.observation?.provenance.usage,
    "protocol:anthropic.message_start",
  );
});

test("an agent-driven Anthropic stream the caller stops reading records the usage from message_start", async (t) => {
  isolate(t);
  const sink = errorSink();
  const agent = (await createLangChainChatModel({
    modelAlias: "chat",
    config: {
      ...config(async () => cutStream(cachedStart)),
      observeSink: sink.observeSink,
    },
  })) as unknown as LangChainChatModelLike;
  const chunks = (await agent.stream([
    { role: "user", content: "hello" },
  ])) as AsyncIterable<unknown>;
  for await (const chunk of chunks) {
    void chunk;
    break;
  }
  assert.equal(sink.ends.length, 0);
  assert.equal(sink.errors.length, 1);
  assert.deepEqual(sink.errors[0]!.usage, startTotals);
});

// The agent's own path: `invoke` with a streaming handler attached, which is
// how LangGraph drives the model.
for (const shape of ["v2", "v3"] as const) {
  test(`an agent-driven Anthropic call (${shape} handler) that drops mid-stream records the usage from message_start`, async (t) => {
    isolate(t);
    const sink = errorSink();
    const agent = (await createLangChainChatModel({
      modelAlias: "chat",
      config: {
        ...config(async () => cutStream(cachedStart)),
        observeSink: sink.observeSink,
      },
    })) as unknown as LangChainChatModelLike;
    await assert.rejects(
      agent.invoke([{ role: "user", content: "hello" }], {
        callbacks: [new StreamingHandler(shape)],
      } as never),
    );
    assert.equal(sink.ends.length, 0);
    assert.equal(sink.errors.length, 1);
    assert.deepEqual(sink.errors[0]!.usage, startTotals);
  });
}

test("Anthropic message_start usage stands in only when LangChain reported none", () => {
  const target = makeResolvedTarget({
    provider: "claude",
    providerKind: "anthropic",
  });
  const fromStart = normalizeModelCallObservation({
    modelAlias: "chat",
    context: {
      target,
      modality: "chat",
      rawResponse: { content: "hel" },
      capturedStartUsage: cachedStart,
    },
  });
  assert.deepEqual(fromStart.usage, startTotals);
  assert.equal(fromStart.provenance.usage, "protocol:anthropic.message_start");

  const complete = normalizeModelCallObservation({
    modelAlias: "chat",
    context: {
      target,
      modality: "chat",
      rawResponse: { content: "hello" },
      capturedStartUsage: cachedStart,
      sdkUsage: {
        input_tokens: 16,
        output_tokens: 25,
        total_tokens: 41,
        input_token_details: { cache_creation: 2, cache_read: 3 },
      },
    },
  });
  assert.deepEqual(complete.usage, cachedTotals);
  assert.equal(complete.provenance.usage, "protocol:langchain.sdk_usage");

  // A later chunk without usage of its own must not put the partial figure
  // back in place of the complete one.
  const merged = mergeModelCallObservations(complete, fromStart);
  assert.deepEqual(merged.usage, cachedTotals);
  assert.equal(merged.provenance.usage, "protocol:langchain.sdk_usage");
  // The other way round, the complete figure replaces the partial one.
  const upgraded = mergeModelCallObservations(fromStart, complete);
  assert.deepEqual(upgraded.usage, cachedTotals);
});

test("a provider other than Anthropic never reads message_start usage", () => {
  const observation = normalizeModelCallObservation({
    modelAlias: "chat",
    context: {
      target: makeResolvedTarget({
        provider: "local",
        providerKind: "openai-compatible",
      }),
      modality: "chat",
      rawResponse: { content: "hel" },
      capturedStartUsage: cachedStart,
    },
  });
  assert.equal(observation.usage, undefined);
});
