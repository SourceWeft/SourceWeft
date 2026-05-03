import assert from "node:assert/strict";
import test from "node:test";
import { createLangChainChatModel, createModelGateway } from "../src/index";
import type { ChatStreamEvent, LangChainChatModelLike, ModelGatewayConfig } from "../src/types";

function createFakeChatModel(input: {
  invokeResult: Record<string, unknown>;
  streamChunks?: Record<string, unknown>[];
  omitBindTools?: boolean;
  capture?: {
    boundTools?: unknown[];
    messages?: unknown;
  };
}) {
  const model = {
    getName() {
      return "fake-chat-model";
    },
    _streamResponseChunks() {
      return (async function* () {})();
    },
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

  if (input.omitBindTools) {
    delete (model as Partial<typeof model>).bindTools;
  }

  return model;
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

test("chat.complete emits generation observation events", async () => {
  const events: Array<{ type: string; event: Record<string, unknown> }> = [];
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
    observeSink: {
      onGenerationStart(event) {
        events.push({ type: "start", event: event as unknown as Record<string, unknown> });
      },
      onGenerationEnd(event) {
        events.push({ type: "end", event: event as unknown as Record<string, unknown> });
      },
    },
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          invokeResult: {
            id: "msg_1",
            content: "Hello world",
            usage_metadata: {
              input_tokens: 12,
              output_tokens: 8,
              total_tokens: 20,
            },
            response_metadata: {
              finish_reason: "stop",
              model: "gpt-4o-mini",
            },
          },
        }),
    },
  });

  await gateway.chat.complete(
    {
      model: "chat-default",
      messages: [{ role: "user", content: "Hi" }],
      metadata: { teamId: "team-1", workspaceId: "workspace-1" },
    },
    { traceId: "trace-1", metadata: { operation: "chat.answer" } },
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "start");
  assert.equal(events[0]?.event.traceId, "trace-1");
  assert.equal(events[0]?.event.operation, "chat.complete");
  assert.equal(events[0]?.event.modelAlias, "chat-default");
  assert.equal(events[0]?.event.provider, "openai");
  assert.equal(events[0]?.event.providerModel, "gpt-4o-mini");
  assert.deepEqual(events[0]?.event.attributes, {
    teamId: "team-1",
    workspaceId: "workspace-1",
    operation: "chat.answer",
  });
  assert.equal(events[1]?.type, "end");
  assert.equal(events[1]?.event.traceId, "trace-1");
  assert.equal(events[1]?.event.spanId, events[0]?.event.spanId);
  assert.deepEqual(events[1]?.event.usage, {
    inputTokens: 12,
    outputTokens: 8,
    totalTokens: 20,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  });
});

test("observed LangChain chat model preserves model name", async () => {
  const config: ModelGatewayConfig = {
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
    observeSink: {},
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          invokeResult: {},
        }),
    },
  };

  const model = await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
  }) as LangChainChatModelLike;

  assert.equal(model.getName?.(), "fake-chat-model");
  assert.equal("_streamResponseChunks" in model, true);
  assert.equal(model.bindTools?.([]).getName?.(), "fake-chat-model");
});

test("observed LangChain chat model always exposes bindTools", async () => {
  const config: ModelGatewayConfig = {
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
    observeSink: {},
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          invokeResult: {},
          omitBindTools: true,
        }),
    },
  };

  const model = await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
  }) as LangChainChatModelLike;

  assert.equal(typeof model.bindTools, "function");
  assert.equal(typeof model.bindTools?.([]).bindTools, "function");
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
