import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  createLangChainChatModel,
  createModelGateway,
  ModelGatewayError,
} from "../src/index";
import type {
  ChatStreamEvent,
  LangChainChatModelLike,
  ModelGatewayConfig,
  RequestOptions,
} from "../src/types";

function createFakeChatModel(input: {
  invokeResult: Record<string, unknown>;
  structuredResult?: Record<string, unknown>;
  streamChunks?: Record<string, unknown>[];
  omitBindTools?: boolean;
  omitStructuredOutput?: boolean;
  capture?: {
    bindKwargs?: Record<string, unknown>;
    boundTools?: unknown[];
    invokeOptions?: Record<string, unknown>;
    messages?: unknown;
    structuredConfig?: Record<string, unknown>;
    structuredSchema?: Record<string, unknown>;
  };
}) {
  const model = {
    getName() {
      return "fake-chat-model";
    },
    _streamResponseChunks() {
      return (async function* () {})();
    },
    bindTools(tools: unknown[], kwargs?: Record<string, unknown>) {
      if (input.capture) {
        input.capture.bindKwargs = kwargs;
        input.capture.boundTools = tools;
      }
      return this;
    },
    withStructuredOutput(
      schema: Record<string, unknown>,
      config: Record<string, unknown>,
    ) {
      if (input.capture) {
        input.capture.structuredSchema = schema;
        input.capture.structuredConfig = config;
      }
      return {
        invoke: async (
          messages: unknown,
          options?: Record<string, unknown>,
        ) => {
          if (input.capture) {
            input.capture.messages = messages;
            input.capture.invokeOptions = options;
          }
          return input.structuredResult ?? input.invokeResult;
        },
      };
    },
    async invoke(messages: unknown, options?: Record<string, unknown>) {
      if (input.capture) {
        input.capture.messages = messages;
        input.capture.invokeOptions = options;
      }
      return input.invokeResult;
    },
    async stream(messages: unknown, options?: Record<string, unknown>) {
      if (input.capture) {
        input.capture.messages = messages;
        input.capture.invokeOptions = options;
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
  if (input.omitStructuredOutput) {
    delete (model as Partial<typeof model>).withStructuredOutput;
  }

  return model;
}

test("chat.complete normalizes LangChain message output into gateway result", async () => {
  const capture: {
    bindKwargs?: Record<string, unknown>;
    boundTools?: unknown[];
    messages?: unknown;
  } = {};

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
  assert.equal("providerModel" in result.routeDecision, false);
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
  assert.deepEqual(capture.bindKwargs, { tool_choice: "auto" });
});

test("chat.complete delegates structured output to LangChain and preserves raw metadata", async () => {
  const capture: {
    invokeOptions?: Record<string, unknown>;
    structuredConfig?: Record<string, unknown>;
    structuredSchema?: Record<string, unknown>;
  } = {};
  let resolvedOptions: RequestOptions | undefined;
  const gateway = createModelGateway({
    baseUrl: "https://gateway.example.com",
    timeoutMs: 2_500,
    maxRetries: 1,
    allowedModelAliases: ["chat-default"],
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
        supports: ["chat", "json_schema"],
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "openai", model: "gpt-4o-mini", priority: 1 }],
      },
    },
    langchainFactories: {
      createChatModel: ({ options }) => {
        resolvedOptions = options;
        return createFakeChatModel({
          capture,
          invokeResult: { content: "unused" },
          structuredResult: {
            raw: {
              id: "msg_structured",
              content: '{"slides":[{"title":"One"}]}',
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 7,
                total_tokens: 17,
              },
              response_metadata: {
                finish_reason: "stop",
                model: "gpt-4o-mini",
              },
            },
            parsed: { slides: [{ title: "One" }] },
          },
        });
      },
    },
  });

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "Plan one slide" }],
    structuredOutput: {
      method: "json_schema",
      name: "storyboard",
      description: "A slide storyboard",
      strict: true,
      schema: {
        type: "object",
        properties: { slides: { type: "array" } },
        required: ["slides"],
        additionalProperties: false,
      },
    },
  });

  assert.deepEqual(capture.structuredConfig, {
    includeRaw: true,
    method: "jsonSchema",
    name: "storyboard",
    strict: true,
  });
  assert.equal(capture.structuredSchema?.description, "A slide storyboard");
  assert.ok(capture.invokeOptions?.signal instanceof AbortSignal);
  assert.equal(resolvedOptions?.timeoutMs, 2_500);
  assert.equal(resolvedOptions?.maxRetries, 1);
  assert.deepEqual(result.structuredOutput, {
    slides: [{ title: "One" }],
  });
  assert.equal(result.raw.content, '{"slides":[{"title":"One"}]}');
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage?.totalTokens, 17);
});

test("chat.complete omits method/strict when structured method is not pinned", async () => {
  const capture: {
    structuredConfig?: Record<string, unknown>;
  } = {};
  const gateway = createModelGateway({
    baseUrl: "https://gateway.example.com",
    allowedModelAliases: ["chat-default"],
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
        supports: ["chat"],
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
          invokeResult: { content: "unused" },
          structuredResult: {
            raw: { id: "msg_structured", content: '{"slides":[]}' },
            parsed: { slides: [] },
          },
        }),
    },
  });

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "Plan" }],
    structuredOutput: {
      name: "storyboard",
      schema: { type: "object", properties: { slides: { type: "array" } } },
    },
  });

  assert.deepEqual(capture.structuredConfig, {
    includeRaw: true,
    name: "storyboard",
  });
  assert.deepEqual(result.structuredOutput, { slides: [] });
});

test("chat.complete surfaces bounded diagnostics when structured parsing fails", async () => {
  const gateway = createModelGateway({
    baseUrl: "https://gateway.example.com",
    allowedModelAliases: ["chat-default"],
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
        supports: ["chat", "json_schema"],
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
          invokeResult: { content: "unused" },
          structuredResult: {
            raw: { content: "not valid json\nwith controls\u0000" },
            parsed: null,
          },
        }),
    },
  });

  await assert.rejects(
    () =>
      gateway.chat.complete({
        model: "chat-default",
        messages: [{ role: "user", content: "Plan" }],
        structuredOutput: {
          method: "json_schema",
          name: "storyboard",
          schema: { type: "object" },
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "STRUCTURED_OUTPUT");
      const diagnostics = error.metadata?.structuredOutputDiagnostics as Record<
        string,
        unknown
      >;
      assert.equal(diagnostics.contentLength, 29);
      assert.match(String(diagnostics.contentSha256), /^[a-f0-9]{64}$/u);
      assert.equal(diagnostics.contentPreview, "not valid json with controls");
      return true;
    },
  );
});

test("chat.complete sanitizes invalid JSON errors from the real OpenAI-compatible adapter", async () => {
  const leakedContent = "LEAKME-provider-content-not-json";
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl_invalid_json",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: leakedContent,
              refusal: null,
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: 7,
        },
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gateway = createModelGateway({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test-key",
      timeoutMs: 2_000,
      maxRetries: 0,
      allowedModelAliases: ["chat-default"],
      providers: {
        local: {
          kind: "openai-compatible",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-key",
          supports: ["chat", "json_schema"],
        },
      },
      modelRoutes: {
        "chat-default": {
          strategy: "priority",
          targets: [{ provider: "local", model: "test-model", priority: 1 }],
        },
      },
    });

    await assert.rejects(
      () =>
        gateway.chat.complete({
          model: "chat-default",
          messages: [{ role: "user", content: "Return a storyboard" }],
          structuredOutput: {
            method: "json_schema",
            name: "storyboard",
            strict: true,
            schema: {
              type: "object",
              properties: { slides: { type: "array" } },
              required: ["slides"],
              additionalProperties: false,
            },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ModelGatewayError);
        assert.equal(error.code, "STRUCTURED_OUTPUT");
        assert.equal(error.retryable, true);
        assert.equal(
          error.message,
          "Provider returned invalid structured output",
        );
        assert.doesNotMatch(error.message, /LEAKME/u);
        assert.doesNotMatch(error.stack ?? "", /LEAKME/u);
        assert.deepEqual(error.metadata?.structuredOutputDiagnostics, {
          contentAvailable: false,
        });
        return true;
      },
    );

    assert.deepEqual(requestBody?.response_format, {
      type: "json_schema",
      json_schema: {
        name: "storyboard",
        schema: {
          type: "object",
          properties: { slides: { type: "array" } },
          required: ["slides"],
          additionalProperties: false,
        },
        strict: true,
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("chat.stream rejects structured output without falling back", async () => {
  const gateway = createModelGateway({
    baseUrl: "https://gateway.example.com",
    allowedModelAliases: ["chat-default"],
    providers: {
      openai: {
        kind: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-key",
        supports: ["chat", "json_schema"],
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
        createFakeChatModel({ invokeResult: { content: "unused" } }),
    },
  });

  const events = [];
  for await (const event of gateway.chat.stream({
    model: "chat-default",
    messages: [{ role: "user", content: "Plan" }],
    structuredOutput: {
      method: "json_schema",
      name: "storyboard",
      schema: { type: "object" },
    },
  })) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type === "error") {
    assert.equal(events[0].error.code, "BAD_REQUEST");
    assert.equal(events[0].error.retryable, false);
  }
});

test("createLangChainChatModel forwards execution toolChoice to bindTools", async () => {
  const capture: {
    bindKwargs?: Record<string, unknown>;
    boundTools?: unknown[];
  } = {};
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
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          capture,
          invokeResult: { content: "ok" },
        }),
    },
  };

  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
    execution: {
      toolChoice: {
        type: "function",
        function: { name: "lookup" },
      },
    },
  })) as LangChainChatModelLike;

  model.bindTools?.([{ name: "lookup" }]);

  assert.deepEqual(capture.bindKwargs, {
    tool_choice: {
      type: "function",
      function: { name: "lookup" },
    },
  });
});

test("createLangChainChatModel forwards tool binding options without toolChoice", async () => {
  const capture: {
    bindKwargs?: Record<string, unknown>;
    boundTools?: unknown[];
  } = {};
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
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          capture,
          invokeResult: { content: "ok" },
        }),
    },
  };

  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
    execution: {
      toolBindingOptions: {
        parallelToolCalls: false,
        strict: true,
      },
    },
  })) as LangChainChatModelLike;

  model.bindTools?.([{ name: "lookup" }]);

  assert.deepEqual(capture.bindKwargs, {
    parallel_tool_calls: false,
    strict: true,
  });
});

test("createLangChainChatModel lets explicit bindTools kwargs override defaults", async () => {
  const capture: {
    bindKwargs?: Record<string, unknown>;
    boundTools?: unknown[];
  } = {};
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
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          capture,
          invokeResult: { content: "ok" },
        }),
    },
  };

  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
    execution: {
      toolBindingOptions: {
        parallelToolCalls: false,
        strict: true,
        toolChoice: "auto",
      },
    },
  })) as LangChainChatModelLike;

  model.bindTools?.([{ name: "lookup" }], {
    parallel_tool_calls: true,
    tool_choice: "required",
  });

  assert.deepEqual(capture.bindKwargs, {
    parallel_tool_calls: true,
    strict: true,
    tool_choice: "required",
  });
});

test("createLangChainChatModel leaves bindTools kwargs unset without tool binding options", async () => {
  const capture: {
    bindKwargs?: Record<string, unknown>;
    boundTools?: unknown[];
  } = {};
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
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          capture,
          invokeResult: { content: "ok" },
        }),
    },
  };

  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
  })) as LangChainChatModelLike;

  model.bindTools?.([{ name: "lookup" }]);

  assert.deepEqual(capture.boundTools, [{ name: "lookup" }]);
  assert.equal(capture.bindKwargs, undefined);
});

test("chat.complete keeps top-level cache tokens out of input token totals", async () => {
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
          invokeResult: {
            id: "msg_1",
            content: "Hello world",
            usage_metadata: {
              input_tokens: 100,
              output_tokens: 20,
              total_tokens: 120,
              cache_read_input_tokens: 40,
              cache_creation_input_tokens: 10,
            },
          },
        }),
    },
  });

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "Hi" }],
  });

  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
  });
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
        events.push({
          type: "start",
          event: event as unknown as Record<string, unknown>,
        });
      },
      onGenerationEnd(event) {
        events.push({
          type: "end",
          event: event as unknown as Record<string, unknown>,
        });
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
      metadata: {
        teamId: "team-1",
        workspaceId: "workspace-1",
        apiKey: "raw-key",
        byokProvider: "openai",
        modelAlias: "chat-default",
        profileAlias: "private-profile",
        routeDecision: { provider: "openai" },
      },
    },
    {
      traceId: "trace-1",
      metadata: {
        operation: "chat.answer",
        providerHint: "openai",
        providerModel: "gpt-4o-mini",
      },
    },
  );

  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "start");
  assert.equal(events[0]?.event.traceId, "trace-1");
  assert.equal(events[0]?.event.operation, "chat.complete");
  assert.equal(events[0]?.event.provider, "openai");
  assert.equal(events[0]?.event.modelAlias, "chat-default");
  assert.equal(events[0]?.event.providerModel, "gpt-4o-mini");
  assert.deepEqual(events[0]?.event.routeDecision, {
    alias: "chat-default",
    mode: "GLOBAL",
    strategy: "priority",
    provider: "openai",
    providerKind: "openai",
  });
  // Observation attributes are a strict whitelist over request metadata.
  // profileAlias is forwarded because a host observe sink needs it (with
  // gatewayConfigId) to attribute a generation's cost; credentials and BYOK
  // routing details deliberately remain excluded.
  assert.deepEqual(events[0]?.event.attributes, {
    teamId: "team-1",
    workspaceId: "workspace-1",
    modelAlias: "chat-default",
    operation: "chat.answer",
    providerModel: "gpt-4o-mini",
    profileAlias: "private-profile",
    generationPhase: "initial_response",
    messageCount: 1,
    lastMessageRole: "user",
  });
  const forwardedAttributes = events[0]?.event.attributes ?? {};
  assert.equal("apiKey" in forwardedAttributes, false);
  assert.equal("byokProvider" in forwardedAttributes, false);
  const input = events[0]?.event.input as Record<string, unknown>;
  assert.equal("metadata" in input, false);
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

  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
  })) as LangChainChatModelLike;

  assert.equal(model.getName?.(), "fake-chat-model");
  assert.equal("_streamResponseChunks" in model, true);
  assert.equal(model.bindTools?.([]).getName?.(), "fake-chat-model");
});

test("observed LangChain chat model reads trace context from execution metadata", async () => {
  const events: Array<{ type: string; event: Record<string, unknown> }> = [];
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
    observeSink: {
      onGenerationStart(event) {
        events.push({
          type: "start",
          event: event as unknown as Record<string, unknown>,
        });
      },
      onGenerationEnd(event) {
        events.push({
          type: "end",
          event: event as unknown as Record<string, unknown>,
        });
      },
    },
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          invokeResult: {
            content: "Hello world",
            usage_metadata: {
              input_tokens: 3,
              output_tokens: 4,
              total_tokens: 7,
            },
          },
        }),
    },
  };

  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
    execution: {
      metadata: {
        traceId: "trace-from-metadata",
        parentSpanId: "agent_run",
        teamId: "team-1",
        workspaceId: "workspace-1",
        messageId: "message-1",
        observationName: "agent_generation",
      },
    },
  })) as LangChainChatModelLike;

  await model.invoke([{ role: "user", content: "Hi" }]);

  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "start");
  assert.equal(events[0]?.event.traceId, "trace-from-metadata");
  assert.equal(events[0]?.event.parentSpanId, "agent_run");
  assert.equal(events[0]?.event.name, "agent_generation");
  assert.deepEqual(events[0]?.event.attributes, {
    teamId: "team-1",
    workspaceId: "workspace-1",
    messageId: "message-1",
    observationName: "agent_generation",
    generationPhase: "initial_response",
    messageCount: 1,
    lastMessageRole: "user",
  });
  assert.equal(events[1]?.type, "end");
  assert.equal(events[1]?.event.traceId, "trace-from-metadata");
  assert.equal(events[1]?.event.spanId, events[0]?.event.spanId);
});

test("observed LangChain chat model summarizes tool call loop inputs", async () => {
  const events: Array<{
    type: "start" | "end";
    event: Record<string, unknown>;
  }> = [];
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
    observeSink: {
      onGenerationStart(event) {
        events.push({
          type: "start",
          event: event as unknown as Record<string, unknown>,
        });
      },
      onGenerationEnd(event) {
        events.push({
          type: "end",
          event: event as unknown as Record<string, unknown>,
        });
      },
    },
    langchainFactories: {
      createChatModel: () =>
        createFakeChatModel({
          invokeResult: { content: "The selected source is invoice.md" },
        }),
    },
  };

  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
    execution: {
      metadata: {
        traceId: "trace-tool-loop",
        parentSpanId: "agent_run",
        observationName: "agent_generation",
      },
    },
  })) as LangChainChatModelLike;

  const boundModel = model.bindTools?.([{ name: "publish_artifact" }], {
    tool_choice: {
      type: "function",
      function: { name: "publish_artifact" },
    },
  });

  await boundModel?.invoke([
    { type: "system", content: "System prompt" },
    { type: "human", content: "list selected files" },
    {
      type: "ai",
      content: "",
      tool_calls: [{ id: "call_1", name: "ls", args: { path: "/kb" } }],
    },
    {
      type: "tool",
      content: "/kb/invoice.md",
      tool_call_id: "call_1",
    },
  ]);

  const start = events[0]?.event;
  assert.equal(start?.traceId, "trace-tool-loop");
  assert.deepEqual(start?.attributes, {
    observationName: "agent_generation",
    generationPhase: "tool_result_response",
    messageCount: 4,
    lastMessageRole: "tool",
    toolMessageCount: 1,
    assistantToolCallCount: 1,
  });
  assert.deepEqual(start?.input, {
    messageCount: 4,
    messages: [
      {
        role: "system",
        content: { length: 13, preview: "System prompt", truncated: false },
        toolCallCount: 0,
      },
      {
        role: "user",
        content: {
          length: 19,
          preview: "list selected files",
          truncated: false,
        },
        toolCallCount: 0,
      },
      {
        role: "assistant",
        content: { length: 0, preview: "", truncated: false },
        toolCallCount: 1,
        toolCalls: [{ id: "call_1", name: "ls" }],
      },
      {
        role: "tool",
        content: { length: 14, preview: "/kb/invoice.md", truncated: false },
        toolCallId: "call_1",
        toolCallCount: 0,
      },
    ],
    toolCount: 1,
    tools: ["publish_artifact"],
    toolChoice: {
      type: "function",
      function: { name: "publish_artifact" },
    },
    stream: true,
  });
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

  const model = (await createLangChainChatModel({
    modelAlias: "chat-default",
    config,
  })) as LangChainChatModelLike;

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
          {
            provider: "anthropic",
            model: "claude-3-5-sonnet-latest",
            priority: 1,
          },
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
              contentBlocks: [{ type: "reasoning", text: "first" }],
            },
            {
              contentBlocks: [{ type: "reasoning", text: "second" }],
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
        contentBlocks: [{ type: "reasoning", text: "first" }],
      },
    },
    {
      type: "chunk",
      chunk: {
        contentBlocks: [{ type: "reasoning", text: "second" }],
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
        reasoning: "firstsecond",
        providerFields: {
          finishReason: "end_turn",
        },
        routeDecision: {
          alias: "chat-default",
          mode: "GLOBAL",
          strategy: "priority",
          provider: "anthropic",
          providerKind: "anthropic",
        },
        traceId: undefined,
      },
    },
  ]);
});
