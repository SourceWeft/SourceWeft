import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { createLangChainChatModel } from "../src/bridge/utils";
import { ModelGatewayError } from "../src/errors";
import type {
  LangChainChatModelLike,
  ModelGatewayConfig,
  ObserveGenerationStart,
  ProviderKind,
} from "../src/types";
import { createJsonResponse, createSseResponse } from "./helpers";

type Kind = Extract<
  ProviderKind,
  "openai-compatible" | "deepseek" | "anthropic" | "gemini"
>;
const kinds: Kind[] = ["openai-compatible", "deepseek", "anthropic", "gemini"];
const names: Record<Kind, string> = {
  "openai-compatible": "output-cap-test-model",
  deepseek: "deepseek-chat",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-2.5-flash",
};
const messages = [new HumanMessage("Summarize saved progress without tools.")];

type RequestCapture = {
  url: string;
  body: Record<string, any>;
  headers: Headers;
};
// SDK invoke(streaming=true) estimates token usage after consuming SSE. The
// SDK's separate tokenizer loader uses ambient fetch, not config.fetch. Supply
// only its exact public encoding URLs from that installed SDK's own dependency;
// do not download anything, stub the tokenizer algorithm, or permit model HTTP.
const require = createRequire(import.meta.url);
const coreRequire = createRequire(
  require.resolve("@langchain/core/utils/tiktoken"),
);
const tokenizerFixtures = new Map([
  [
    "https://tiktoken.pages.dev/js/gpt2.json",
    coreRequire("js-tiktoken/ranks/gpt2"),
  ],
  [
    "https://tiktoken.pages.dev/js/cl100k_base.json",
    coreRequire("js-tiktoken/ranks/cl100k_base"),
  ],
  [
    "https://tiktoken.pages.dev/js/o200k_base.json",
    coreRequire("js-tiktoken/ranks/o200k_base"),
  ],
]);
function isolate(t: TestContext) {
  const unexpected: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      const tokenizer = tokenizerFixtures.get(url);
      if (tokenizer) return createJsonResponse(tokenizer);
      unexpected.push(url);
      throw new Error("The SDK bypassed its injected transport");
    },
  );
  t.after(() =>
    assert.deepEqual(unexpected, [], "all model HTTP must use config.fetch"),
  );
}
function sdkResponse(kind: Kind, body: Record<string, any>, url: string) {
  const model = names[kind];
  if (kind === "anthropic") {
    if (!body.stream)
      return createJsonResponse({
        id: "msg-cap",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "saved progress" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg-cap",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
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
        delta: { type: "text_delta", text: "saved progress" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    return createSseResponse(
      events.map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      ),
    );
  }
  if (kind === "gemini") {
    const result = {
      candidates: [
        {
          index: 0,
          content: { role: "model", parts: [{ text: "saved progress" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      },
      modelVersion: model,
    };
    return url.includes("streamGenerateContent")
      ? createSseResponse([`data: ${JSON.stringify(result)}\n\n`])
      : createJsonResponse(result);
  }
  if (!body.stream)
    return createJsonResponse({
      id: "chat-cap",
      object: "chat.completion",
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "saved progress" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  return createSseResponse([
    `data: ${JSON.stringify({ id: "chat-cap", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "saved progress" } }] })}\n\n`,
    `data: ${JSON.stringify({ id: "chat-cap", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}
async function fixture(kind: Kind) {
  const requests: RequestCapture[] = [];
  const starts: ObserveGenerationStart[] = [];
  const config: ModelGatewayConfig = {
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Record<string, any>;
      requests.push({ url: request.url, body, headers: request.headers });
      return sdkResponse(kind, body, request.url);
    },
    providers: {
      selected: {
        kind,
        baseUrl:
          kind === "anthropic"
            ? "https://models.invalid"
            : "https://models.invalid/v1",
        apiKey: "explicit-output-cap-test-key",
      },
    },
    modelRoutes: {
      "cap-test": {
        strategy: "priority",
        targets: [{ provider: "selected", model: names[kind], priority: 1 }],
      },
    },
    observeSink: {
      onGenerationStart: (generation) => {
        starts.push(generation);
      },
    },
  };
  const raw = await createLangChainChatModel({
    modelAlias: "cap-test",
    config,
    execution: { fallbackPolicy: "none" },
  });
  return {
    raw,
    model: raw as unknown as LangChainChatModelLike,
    requests,
    starts,
  };
}
function actualCap(kind: Kind, body: Record<string, any>) {
  return kind === "gemini"
    ? body.generationConfig?.maxOutputTokens
    : (body.max_tokens ?? body.max_completion_tokens);
}
function assertIdentityAndNoTools(kind: Kind, capture: RequestCapture) {
  assert.equal(new URL(capture.url).origin, "https://models.invalid");
  if (kind === "gemini") {
    assert.ok(capture.url.includes(`/models/${names[kind]}:`));
  } else {
    assert.equal(capture.body.model, names[kind]);
  }
  assert.ok(
    !capture.body.tools || capture.body.tools.length === 0,
    "the tools-disabled binding cannot register functions",
  );
}
async function run(model: LangChainChatModelLike, stream: boolean) {
  if (!stream) {
    await model.invoke(messages);
    return;
  }
  for await (const _chunk of await model.stream(messages)) {
    /* drain the installed SDK stream */
  }
}

for (const kind of kinds) {
  for (const stream of [false, true]) {
    test(`${kind} ${stream ? "stream" : "invoke"} sends a real constructor output cap and keeps the unbound model independent`, async (t) => {
      isolate(t);
      const f = await fixture(kind);
      const summary = f.model.bindTools!([], {
        maxTokens: 2048,
        tool_choice: "none",
      });
      await run(summary, stream);
      // A second non-default value prevents Anthropic's own 2048 default from
      // accidentally satisfying this regression while the binding is ignored.
      await run(
        f.model.bindTools!([], { maxTokens: 512, tool_choice: "none" }),
        stream,
      );
      await run(f.model, stream);
      assert.equal(f.requests.length, 3);
      assert.equal(actualCap(kind, f.requests[0]!.body), 2048);
      assert.equal(actualCap(kind, f.requests[1]!.body), 512);
      assert.notEqual(
        actualCap(kind, f.requests[2]!.body),
        512,
        "a later business invocation must not inherit the summary cap",
      );
      for (const request of f.requests) assertIdentityAndNoTools(kind, request);
      assert.equal(f.starts.length, 3);
      assert.equal(f.starts[0]?.modelParameters?.maxTokens, 2048);
      assert.equal(f.starts[1]?.modelParameters?.maxTokens, 512);
      assert.equal(f.starts[2]?.modelParameters?.maxTokens, undefined);
      assert.ok(
        f.starts.every(
          (start) =>
            start.provider === "selected" &&
            start.providerModel === names[kind],
        ),
      );
    });
  }

  test(`${kind} repeated bindings can only tighten the physical output cap`, async (t) => {
    isolate(t);
    const f = await fixture(kind);
    const first = f.model.bindTools!([], { maxTokens: 2048 });
    const widened = first.bindTools!([], { maxTokens: 8192 });
    const narrowed = widened.bindTools!([], { maxTokens: 256 });
    const rebound = narrowed.bindTools!([], { maxTokens: 4096 }).bindTools!([]);
    await run(widened, false);
    await run(rebound, false);
    assert.deepEqual(
      f.requests.map((request) => actualCap(kind, request.body)),
      [2048, 256],
    );
    assert.deepEqual(
      f.starts.map((start) => start.modelParameters?.maxTokens),
      [2048, 256],
    );
    for (const request of f.requests) assertIdentityAndNoTools(kind, request);
  });
}

test("invalid per-binding output caps fail before any HTTP request", async (t) => {
  isolate(t);
  const f = await fixture("openai-compatible");
  for (const maxTokens of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "2048",
    null,
    true,
  ]) {
    assert.throws(
      () => f.model.bindTools!([], { maxTokens }),
      (error: unknown) =>
        error instanceof ModelGatewayError && error.code === "BAD_REQUEST",
    );
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.starts.length, 0);
});

test("SDK withConfig composition retains the same bounded route without changing the original", async (t) => {
  isolate(t);
  const f = await fixture("openai-compatible");
  const configured = f.raw.withConfig({
    tags: ["summary-test"],
  }) as unknown as LangChainChatModelLike;
  await run(
    configured.bindTools!([], { maxTokens: 2048, tool_choice: "none" }),
    true,
  );
  await run(f.model, false);
  assert.equal(actualCap("openai-compatible", f.requests[0]!.body), 2048);
  assert.equal(actualCap("openai-compatible", f.requests[1]!.body), undefined);
  assert.deepEqual(
    f.starts.map((start) => start.modelParameters?.maxTokens),
    [2048, undefined],
  );
  for (const request of f.requests)
    assertIdentityAndNoTools("openai-compatible", request);
});
