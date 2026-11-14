import assert from "node:assert/strict";
import test from "node:test";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { createLangChainChatModel } from "../src/bridge/utils";
import type {
  LangChainChatModelLike,
  ModelGatewayConfig,
  ObserveGenerationEnd,
  ProviderKind,
} from "../src/types";
import {
  startFakeOpenAIServer,
  type FakeScenario,
  type FakeUsage,
} from "./fake-openai-sse-server";

/**
 * The handler flags LangGraph's messages handlers carry. `v3` is the
 * `streamEvents(…, { version: "v3" })` shape the agent runtime drives: core
 * then builds the final message from content-block events instead of from the
 * provider's chunks.
 */
class StreamingHandler extends BaseCallbackHandler {
  name = "stream-usage-capture";
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

/** Usage as DeepInfra reports it: once, on a trailing chunk without choices. */
const trailingUsage = {
  prompt_tokens: 18929,
  completion_tokens: 40,
  total_tokens: 18969,
  estimated_cost: 0.00007815304,
  prompt_tokens_details: { cached_tokens: 18816 },
  completion_tokens_details: { reasoning_tokens: 25 },
} as FakeUsage;

const scenario: FakeScenario = {
  kind: "stream",
  chunks: [
    { reasoning: "thinking" },
    { content: "hel" },
    { content: "lo", finishReason: "stop" },
  ],
  usage: trailingUsage,
};

async function runInvoke(input: {
  provider: string;
  kind: ProviderKind;
  shape: "v2" | "v3";
}) {
  const server = await startFakeOpenAIServer(scenario);
  const ends: ObserveGenerationEnd[] = [];
  try {
    const config: ModelGatewayConfig = {
      providers: {
        [input.provider]: {
          kind: input.kind,
          baseUrl: server.url,
          apiKey: "fake-key",
        },
      },
      modelRoutes: {
        chat: {
          strategy: "priority",
          targets: [
            { provider: input.provider, model: "fake-model", priority: 1 },
          ],
        },
      },
      timeoutMs: 10_000,
      maxRetries: 0,
      observeSink: {
        onGenerationStart: () => {},
        onGenerationEnd: (event) => {
          ends.push(event);
        },
      },
    };
    const model = (await createLangChainChatModel({
      modelAlias: "chat",
      config,
    })) as unknown as LangChainChatModelLike;
    await model.invoke([{ role: "user", content: "hello" }], {
      callbacks: [new StreamingHandler(input.shape)],
    } as never);
  } finally {
    await server.close();
  }
  assert.equal(ends.length, 1);
  return ends[0]!;
}

for (const shape of ["v2", "v3"] as const) {
  test(`an agent-driven DeepInfra call (${shape} handler) keeps the provider's cost and token details`, async () => {
    const end = await runInvoke({
      provider: "deepinfra",
      kind: "deepinfra",
      shape,
    });

    assert.equal(end.usage?.inputTokens, 18929);
    assert.equal(end.usage?.outputTokens, 40);
    assert.equal(end.usage?.cacheReadTokens, 18816);
    assert.equal(end.usage?.reasoningTokens, 25);
    assert.equal(end.observation?.cost?.effectiveUsd, 0.00007815304);
    assert.equal(end.observation?.cost?.source, "provider_estimated");
    assert.equal(
      end.observation?.provenance.inlineCost,
      "provider:deepinfra.usage.estimated_cost",
    );
  });

  test(`an agent-driven OpenAI-compatible call (${shape} handler) keeps cached and reasoning token counts`, async () => {
    const end = await runInvoke({
      provider: "compatible",
      kind: "openai-compatible",
      shape,
    });

    assert.equal(end.usage?.inputTokens, 18929);
    assert.equal(end.usage?.cacheReadTokens, 18816);
    assert.equal(end.usage?.reasoningTokens, 25);
    // No provider adapter claims this figure, so it is not a cost.
    assert.equal(end.observation?.cost, undefined);
  });
}
