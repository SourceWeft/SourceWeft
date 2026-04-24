import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";
import type { ChatStreamEvent } from "../src/types";

function createFakeChatModel(input: {
  invokeResult: Record<string, unknown>;
  streamChunks?: Record<string, unknown>[];
  capture?: {
    boundTools?: unknown[];
    messages?: unknown;
  };
}) {
  return {
    bindTools(tools: unknown[]) {
      if (input.capture) {
        input.capture.boundTools = tools;
      }
      return this;
    },
    async invoke(messages: unknown) {
      if (input.capture) {
        input.capture.messages = messages;
      }
      return input.invokeResult;
    },
    async stream(messages: unknown) {
      if (input.capture) {
        input.capture.messages = messages;
      }
      const chunks = input.streamChunks ?? [];
      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    },
  };
}

test("chat.complete normalizes LangChain message output into gateway result", async () => {
  const capture: { boundTools?: unknown[]; messages?: unknown } = {};

  const gateway = createModelGateway({
    baseUrl: "https://gateway.example.com",
    allowedModelAliases: ["chat-default"],
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
      },
    },
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          capture,
          invokeResult: {
            id: "msg_1",
            content: "Hello world",
            tool_calls: [
              {
                id: "call_1",
                name: "lookup",
                args: { topic: "docs" },
              },
            ],
            usage_metadata: {
              input_tokens: 12,
              output_tokens: 8,
              total_tokens: 20,
            },
            response_metadata: {
              finish_reason: "stop",
              provider: "openai",
            },
          },
        }),
    },
  });

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ name: "lookup" }],
    toolChoice: "auto",
  });

  assert.equal(result.id, "msg_1");
  assert.equal(result.provider, "openai");
  assert.equal(result.providerModel, "gpt-4o-mini");
  assert.equal(result.routeDecision?.providerKind, "openai");
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  });
  assert.equal(result.raw.content, "Hello world");
  assert.deepEqual(result.raw.tool_calls, [
    {
      id: "call_1",
      name: "lookup",
      args: { topic: "docs" },
    },
  ]);
  assert.equal(Array.isArray(capture.boundTools), true);
});

test("chat.stream passes through LangChain chunks and emits metadata", async () => {
  const gateway = createModelGateway({
    baseUrl: "https://gateway.example.com",
    allowedModelAliases: ["chat-default"],
    providers: {
      anthropic: {
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "anthropic-key",
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [
          { provider: "anthropic", model: "claude-3-5-sonnet-latest", priority: 1 },
        ],
      },
    },
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          invokeResult: {},
          streamChunks: [
            { content: "Hello" },
            {
              tool_calls: [{ name: "lookup", args: { topic: "docs" } }],
              usage_metadata: {
                input_tokens: 2,
                output_tokens: 3,
                total_tokens: 5,
              },
            },
            {
              response_metadata: {
                finishReason: "end_turn",
              },
            },
          ],
        }),
    },
  });

  const events: ChatStreamEvent[] = [];
  for await (const event of gateway.chat.stream({
    model: "chat-default",
    messages: [{ role: "user", content: "Hi" }],
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: "chunk", chunk: { content: "Hello" } },
    {
      type: "chunk",
      chunk: {
        tool_calls: [{ name: "lookup", args: { topic: "docs" } }],
        usage_metadata: {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
        },
      },
    },
    {
      type: "chunk",
      chunk: {
        response_metadata: {
          finishReason: "end_turn",
        },
      },
    },
    {
      type: "metadata",
      metadata: {
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        finishReason: "end_turn",
        reasoning: undefined,
        providerFields: {
          finishReason: "end_turn",
        },
        routeDecision: {
          alias: "chat-default",
          mode: "GLOBAL",
          strategy: "priority",
          provider: "anthropic",
          providerKind: "anthropic",
          providerModel: "claude-3-5-sonnet-latest",
        },
        traceId: undefined,
      },
    },
  ]);
});
