import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway, ModelGatewayError } from "../src/index";
import { executeStructuredOutput } from "../src/bridge/structured-output";
import {
  STRICT_JSON_SCHEMA_SUPPORT,
  STRICT_JSON_SCHEMA_UNSUPPORTED_TTL_MS,
  StrictJsonSchemaSupportCache,
} from "../src/strict-json-schema-support";
import type {
  GatewayLogger,
  LangChainChatModelLike,
  ModelCapabilityRule,
  ObserveGenerationEnd,
  ObserveSink,
} from "../src/types";
import { makeResolvedTarget } from "./helpers";

const STRICT_SUPPORTS = [
  "chat",
  "tool_calling",
  "json_schema",
  STRICT_JSON_SCHEMA_SUPPORT,
];

const STRICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { title: { type: "string", maxLength: 80 } },
  required: ["title"],
} as Record<string, unknown>;

const LOOSE_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
} as Record<string, unknown>;

const OPENROUTER_TARGET = makeResolvedTarget({
  provider: "openrouter",
  providerKind: "openrouter",
  providerModel: "deepseek/deepseek-v4.1-flash",
  supports: STRICT_SUPPORTS,
});

const DEEPSEEK_DIRECT_TARGET = makeResolvedTarget({
  provider: "deepseek",
  providerKind: "deepseek",
  providerModel: "deepseek-v4-flash",
  supports: ["chat", "tool_calling", "json_schema"],
});

type Capture = {
  structuredConfigs: Record<string, unknown>[];
  bindKwargs: Record<string, unknown>[];
};

/**
 * A fake model that records every structured path the executor drives and can
 * refuse the `json_schema` method with a given error (the strict attempt).
 */
function createFakeModel(input: {
  capture: Capture;
  jsonSchemaError?: unknown;
  otherError?: unknown;
}): LangChainChatModelLike {
  const rawMessage = (toolArgs?: Record<string, unknown>) => ({
    id: "msg_1",
    content: toolArgs ? "" : '{"title":"Native"}',
    tool_calls: toolArgs
      ? [{ id: "call_1", name: "storyboard", args: toolArgs }]
      : [],
    response_metadata: { finish_reason: toolArgs ? "tool_calls" : "stop" },
  });
  const model: LangChainChatModelLike = {
    getName: () => "fake",
    bindTools: (_tools, kwargs) => {
      input.capture.bindKwargs.push(kwargs ?? {});
      return {
        ...model,
        invoke: async () => {
          if (input.otherError) throw input.otherError;
          return rawMessage({ title: "Tool" });
        },
      };
    },
    withStructuredOutput: (_schema, config) => {
      input.capture.structuredConfigs.push(config as Record<string, unknown>);
      return {
        invoke: async () => {
          if (config.method === "jsonSchema" && input.jsonSchemaError) {
            throw input.jsonSchemaError;
          }
          if (input.otherError) throw input.otherError;
          return { raw: rawMessage(), parsed: { title: "Native" } };
        },
      };
    },
    invoke: async () => rawMessage(),
    stream: async () => (async function* () {})(),
  };
  return model;
}

function newCapture(): Capture {
  return { structuredConfigs: [], bindKwargs: [] };
}

function captureLogger() {
  const warnings: Array<{ message: string; data?: Record<string, unknown> }> =
    [];
  const debugs: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const logger: GatewayLogger = {
    warn: (message, data) => warnings.push({ message, data }),
    debug: (message, data) => debugs.push({ message, data }),
  };
  return { logger, warnings, debugs };
}

/** The error the OpenAI SDK raises for a non-2xx response (APIError shape). */
function sdkError(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
) {
  const error = new Error(`${status} ${message}`) as Error & {
    status: number;
    error: Record<string, unknown>;
  };
  error.status = status;
  error.error = { message, ...extra };
  return error;
}

const NO_ENDPOINTS_MESSAGE =
  "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection";

// ---------------------------------------------------------------------------
// Planning matrix
// ---------------------------------------------------------------------------

test("strict-capable provider + compatible schema → json_schema strict, ahead of the available-tool path", async () => {
  const capture = newCapture();
  const result = await executeStructuredOutput({
    model: createFakeModel({ capture }),
    schema: STRICT_SCHEMA,
    name: "storyboard",
    messages: [],
    target: OPENROUTER_TARGET,
    // DeepSeek disables a forced tool_choice; strict still takes precedence.
    supportsForcedToolChoice: false,
    fallbackMethod: "function_calling",
    allowJsonRepair: true,
    strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
  });
  assert.equal(capture.bindKwargs.length, 0);
  assert.deepEqual(capture.structuredConfigs, [
    {
      includeRaw: true,
      name: "storyboard",
      method: "jsonSchema",
      strict: true,
    },
  ]);
  assert.deepEqual(result.parsed, { title: "Native" });
  assert.deepEqual(result.diagnostics, { mechanism: "json_schema_strict" });
});

test("an incompatible schema keeps today's path", async () => {
  const capture = newCapture();
  const result = await executeStructuredOutput({
    model: createFakeModel({ capture }),
    schema: LOOSE_SCHEMA,
    name: "storyboard",
    messages: [],
    target: OPENROUTER_TARGET,
    supportsForcedToolChoice: false,
    allowJsonRepair: true,
    strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
  });
  assert.equal(capture.structuredConfigs.length, 0);
  assert.equal(capture.bindKwargs.length, 1);
  assert.deepEqual(result.diagnostics, { mechanism: "available_tool" });
});

test("a pinned method stays authoritative on a strict-capable provider", async () => {
  const capture = newCapture();
  const result = await executeStructuredOutput({
    model: createFakeModel({ capture }),
    schema: STRICT_SCHEMA,
    name: "storyboard",
    messages: [],
    target: OPENROUTER_TARGET,
    supportsForcedToolChoice: true,
    method: "function_calling",
    allowJsonRepair: false,
    strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
  });
  assert.deepEqual(capture.structuredConfigs, [
    { includeRaw: true, name: "storyboard", method: "functionCalling" },
  ]);
  assert.deepEqual(result.diagnostics, {
    mechanism: "native:function_calling",
  });
});

test("a provider without the flag (DeepSeek direct) keeps the available-tool path", async () => {
  const capture = newCapture();
  const result = await executeStructuredOutput({
    model: createFakeModel({ capture }),
    schema: STRICT_SCHEMA,
    name: "storyboard",
    messages: [],
    target: DEEPSEEK_DIRECT_TARGET,
    supportsForcedToolChoice: false,
    fallbackMethod: "function_calling",
    allowJsonRepair: true,
    strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
  });
  assert.equal(capture.structuredConfigs.length, 0);
  assert.equal(capture.bindKwargs.length, 1);
  assert.deepEqual(result.diagnostics, { mechanism: "available_tool" });
});

test("a provider without the flag and forced tool_choice keeps the capability method", async () => {
  const capture = newCapture();
  const result = await executeStructuredOutput({
    model: createFakeModel({ capture }),
    schema: STRICT_SCHEMA,
    name: "storyboard",
    messages: [],
    target: makeResolvedTarget({ supports: ["chat", "json_schema"] }),
    supportsForcedToolChoice: true,
    fallbackMethod: "function_calling",
    allowJsonRepair: false,
    strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
  });
  assert.deepEqual(capture.structuredConfigs, [
    { includeRaw: true, name: "storyboard", method: "functionCalling" },
  ]);
  assert.deepEqual(result.diagnostics, {
    mechanism: "native:function_calling",
  });
});

test("a (provider, model) cached as unsupported keeps today's path", async () => {
  const capture = newCapture();
  const cache = new StrictJsonSchemaSupportCache();
  cache.markUnsupported(OPENROUTER_TARGET);
  const result = await executeStructuredOutput({
    model: createFakeModel({ capture }),
    schema: STRICT_SCHEMA,
    name: "storyboard",
    messages: [],
    target: OPENROUTER_TARGET,
    supportsForcedToolChoice: false,
    allowJsonRepair: true,
    strictJsonSchemaSupport: cache,
  });
  assert.equal(capture.structuredConfigs.length, 0);
  assert.equal(capture.bindKwargs.length, 1);
  assert.deepEqual(result.diagnostics, { mechanism: "available_tool" });
});

test("an explicit strict: false opts out of automatic strict output", async () => {
  const capture = newCapture();
  const result = await executeStructuredOutput({
    model: createFakeModel({ capture }),
    schema: STRICT_SCHEMA,
    name: "storyboard",
    messages: [],
    target: OPENROUTER_TARGET,
    supportsForcedToolChoice: true,
    strict: false,
    allowJsonRepair: false,
    strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
  });
  assert.deepEqual(capture.structuredConfigs, [
    { includeRaw: true, name: "storyboard" },
  ]);
  assert.deepEqual(result.diagnostics, { mechanism: "native:auto" });
});

// ---------------------------------------------------------------------------
// Automatic fallback
// ---------------------------------------------------------------------------

const FALLBACK_SHAPES = [
  {
    reason: "no_endpoint_for_parameters",
    error: () =>
      sdkError(404, NO_ENDPOINTS_MESSAGE, {
        code: 404,
        metadata: {
          routing_funnel: [{ step: "Initial Endpoints", endpoint_count: 1 }],
          failed_routing_step: "Filter by Parameters",
        },
      }),
  },
  {
    reason: "response_format_unsupported",
    error: () => sdkError(400, "This response_format type is unavailable now"),
  },
  {
    reason: "invalid_schema",
    error: () =>
      sdkError(
        400,
        "Invalid schema for response_format 'storyboard': 'minLength' is not permitted.",
      ),
  },
] as const;

for (const shape of FALLBACK_SHAPES) {
  test(`fallback (${shape.reason}): one retry through the non-strict path, remembered as unsupported`, async () => {
    const capture = newCapture();
    const cache = new StrictJsonSchemaSupportCache();
    const { logger, warnings } = captureLogger();
    const result = await executeStructuredOutput({
      model: createFakeModel({ capture, jsonSchemaError: shape.error() }),
      schema: STRICT_SCHEMA,
      name: "storyboard",
      messages: [],
      target: OPENROUTER_TARGET,
      supportsForcedToolChoice: false,
      allowJsonRepair: true,
      strictJsonSchemaSupport: cache,
      logger,
    });
    // Exactly one strict attempt, then exactly one available-tool attempt.
    assert.equal(capture.structuredConfigs.length, 1);
    assert.equal(capture.structuredConfigs[0]!.method, "jsonSchema");
    assert.equal(capture.bindKwargs.length, 1);
    assert.deepEqual(result.parsed, { title: "Tool" });
    assert.deepEqual(result.diagnostics, {
      mechanism: "available_tool",
      fallbackReason: shape.reason,
    });
    assert.equal(cache.isUnsupported(OPENROUTER_TARGET), true);
    const fallbackLogs = warnings.filter(
      (entry) => entry.message === "model-gateway.structured-output-fallback",
    );
    assert.deepEqual(fallbackLogs, [
      {
        message: "model-gateway.structured-output-fallback",
        data: {
          provider: "openrouter",
          providerModel: "deepseek/deepseek-v4.1-flash",
          reason: shape.reason,
          fallbackMechanism: "available_tool",
        },
      },
    ]);
  });
}

test("fallback retries with the capability method when forced tool_choice is allowed", async () => {
  const capture = newCapture();
  const result = await executeStructuredOutput({
    model: createFakeModel({
      capture,
      jsonSchemaError: sdkError(404, NO_ENDPOINTS_MESSAGE),
    }),
    schema: STRICT_SCHEMA,
    name: "storyboard",
    messages: [],
    target: OPENROUTER_TARGET,
    supportsForcedToolChoice: true,
    fallbackMethod: "function_calling",
    allowJsonRepair: false,
    strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
  });
  assert.deepEqual(
    capture.structuredConfigs.map((config) => config.method),
    ["jsonSchema", "functionCalling"],
  );
  assert.deepEqual(result.diagnostics, {
    mechanism: "native:function_calling",
    fallbackReason: "no_endpoint_for_parameters",
  });
});

test("after a fallback the next call skips strict, and expiry re-enables it", async () => {
  let now = 0;
  const cache = new StrictJsonSchemaSupportCache({ now: () => now });
  const run = async (capture: Capture, jsonSchemaError?: unknown) =>
    executeStructuredOutput({
      model: createFakeModel({ capture, jsonSchemaError }),
      schema: STRICT_SCHEMA,
      name: "storyboard",
      messages: [],
      target: OPENROUTER_TARGET,
      supportsForcedToolChoice: false,
      allowJsonRepair: true,
      strictJsonSchemaSupport: cache,
    });

  await run(newCapture(), sdkError(404, NO_ENDPOINTS_MESSAGE));
  assert.equal(cache.isUnsupported(OPENROUTER_TARGET), true);

  const cached = newCapture();
  const second = await run(cached);
  assert.equal(cached.structuredConfigs.length, 0);
  assert.deepEqual(second.diagnostics, { mechanism: "available_tool" });

  now += STRICT_JSON_SCHEMA_UNSUPPORTED_TTL_MS;
  const expired = newCapture();
  const third = await run(expired);
  assert.equal(expired.structuredConfigs[0]!.method, "jsonSchema");
  assert.deepEqual(third.diagnostics, { mechanism: "json_schema_strict" });
});

test("unrelated errors from the strict attempt propagate unchanged, without fallback", async () => {
  for (const error of [
    sdkError(400, "messages must not be empty"),
    sdkError(500, "Internal server error"),
    sdkError(404, "Model not found"),
    Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    }),
  ]) {
    const capture = newCapture();
    const cache = new StrictJsonSchemaSupportCache();
    await assert.rejects(
      executeStructuredOutput({
        model: createFakeModel({ capture, jsonSchemaError: error }),
        schema: STRICT_SCHEMA,
        name: "storyboard",
        messages: [],
        target: OPENROUTER_TARGET,
        supportsForcedToolChoice: false,
        allowJsonRepair: true,
        strictJsonSchemaSupport: cache,
      }),
      (thrown: unknown) => thrown === error,
    );
    assert.equal(capture.structuredConfigs.length, 1);
    assert.equal(capture.bindKwargs.length, 0);
    assert.equal(cache.isUnsupported(OPENROUTER_TARGET), false);
  }
});

test("a failing fallback attempt propagates its own error and never loops", async () => {
  const capture = newCapture();
  const fallbackError = sdkError(500, "upstream down");
  await assert.rejects(
    executeStructuredOutput({
      model: createFakeModel({
        capture,
        jsonSchemaError: sdkError(404, NO_ENDPOINTS_MESSAGE),
        otherError: fallbackError,
      }),
      schema: STRICT_SCHEMA,
      name: "storyboard",
      messages: [],
      target: OPENROUTER_TARGET,
      supportsForcedToolChoice: false,
      allowJsonRepair: true,
      strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
    }),
    (thrown: unknown) => thrown === fallbackError,
  );
  assert.equal(capture.structuredConfigs.length, 1);
  assert.equal(capture.bindKwargs.length, 1);
});

// ---------------------------------------------------------------------------
// End to end through the real OpenRouter adapter
// ---------------------------------------------------------------------------

const DEEPSEEK_RULES: ModelCapabilityRule[] = [
  {
    modelMatch: "deepseek",
    capabilities: { disabledParams: { tool_choice: null } },
  },
  {
    modelMatch: "deepseek",
    capabilities: { toolCallArgumentJsonRepair: true },
  },
  {
    modelMatch: "deepseek",
    capabilities: { structuredOutputMethod: "function_calling" },
  },
];

function completion(message: Record<string, unknown>, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      id: "gen-1",
      object: "chat.completion",
      created: 1,
      model: "deepseek/deepseek-v4.1-flash",
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openRouterGateway(input: {
  respond: (body: Record<string, unknown>) => Response;
  bodies: Record<string, unknown>[];
  cache: StrictJsonSchemaSupportCache;
  logger?: GatewayLogger;
  supports?: string[];
  maxRetries?: number;
  observeSink?: ObserveSink;
}) {
  return createModelGateway({
    ...(input.observeSink ? { observeSink: input.observeSink } : {}),
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.test/api/v1",
        apiKey: "test-key",
        supports: input.supports ?? STRICT_SUPPORTS,
        maxRetries: input.maxRetries ?? 0,
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [
          {
            provider: "openrouter",
            model: "deepseek/deepseek-v4.1-flash",
            priority: 1,
            providerRouting: { only: ["novita", "siliconflow"], sort: "price" },
          },
        ],
      },
    },
    modelCapabilities: DEEPSEEK_RULES,
    strictJsonSchemaSupport: input.cache,
    ...(input.logger ? { logger: input.logger } : {}),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      input.bodies.push(body);
      return input.respond(body);
    },
  });
}

const OVERVIEW_REQUEST = {
  model: "chat-default",
  messages: [{ role: "user" as const, content: "describe" }],
  structuredOutput: { name: "storyboard", schema: STRICT_SCHEMA },
};

test("OpenRouter: the strict request carries json_schema strict and require_parameters merged with routing", async () => {
  const bodies: Record<string, unknown>[] = [];
  const ends: ObserveGenerationEnd[] = [];
  const gateway = openRouterGateway({
    bodies,
    cache: new StrictJsonSchemaSupportCache(),
    observeSink: { onGenerationEnd: (end) => void ends.push(end) },
    respond: () =>
      completion({ role: "assistant", content: '{"title":"Strict"}' }),
  });
  const result = await gateway.chat.complete(OVERVIEW_REQUEST);
  assert.deepEqual(result.structuredOutput, { title: "Strict" });
  assert.deepEqual(result.structuredOutputDiagnostics, {
    mechanism: "json_schema_strict",
  });
  // The generation records the mechanism next to its other output facts.
  assert.deepEqual(ends[0]?.output?.structuredOutput, {
    mechanism: "json_schema_strict",
  });
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.response_format, {
    type: "json_schema",
    json_schema: { name: "storyboard", schema: STRICT_SCHEMA, strict: true },
  });
  assert.deepEqual(bodies[0]!.provider, {
    only: ["novita", "siliconflow"],
    sort: "price",
    require_parameters: true,
  });
  assert.equal(bodies[0]!.tools, undefined);
  assert.equal(bodies[0]!.tool_choice, undefined);
});

const WIRE_FALLBACKS = [
  {
    reason: "no_endpoint_for_parameters",
    response: () =>
      errorResponse(404, {
        error: {
          message: NO_ENDPOINTS_MESSAGE,
          code: 404,
          metadata: {
            routing_funnel: [{ step: "Initial Endpoints", endpoint_count: 1 }],
            failed_routing_step: "Filter by Parameters",
          },
        },
      }),
  },
  {
    reason: "response_format_unsupported",
    response: () =>
      errorResponse(400, {
        error: {
          message: "This response_format type is unavailable now",
          type: "invalid_request_error",
          code: "invalid_request_error",
        },
      }),
  },
  {
    reason: "invalid_schema",
    response: () =>
      errorResponse(400, {
        error: {
          message:
            "Invalid schema for response_format 'storyboard': In context=('properties', 'title'), 'maxLength' is not permitted.",
          type: "invalid_request_error",
          param: "response_format",
        },
      }),
  },
] as const;

for (const shape of WIRE_FALLBACKS) {
  test(`OpenRouter wire fallback (${shape.reason}): one strict request, then the available-tool request`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const cache = new StrictJsonSchemaSupportCache();
    const { logger, warnings } = captureLogger();
    const gateway = openRouterGateway({
      bodies,
      cache,
      logger,
      respond: (body) =>
        body.response_format
          ? shape.response()
          : completion(
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "storyboard",
                      arguments: '{"title":"Tool"}',
                    },
                  },
                ],
              },
              "tool_calls",
            ),
    });
    const result = await gateway.chat.complete(OVERVIEW_REQUEST);
    assert.deepEqual(result.structuredOutput, { title: "Tool" });
    assert.deepEqual(result.structuredOutputDiagnostics, {
      mechanism: "available_tool",
      fallbackReason: shape.reason,
    });
    assert.equal(bodies.length, 2);
    assert.equal(
      (bodies[0]!.response_format as { type?: string }).type,
      "json_schema",
    );
    // The retry is today's DeepSeek path: an available tool, no forced
    // tool_choice, no response_format, and no require_parameters.
    assert.equal(bodies[1]!.response_format, undefined);
    assert.ok(Array.isArray(bodies[1]!.tools));
    assert.equal(bodies[1]!.tool_choice, undefined);
    assert.deepEqual(bodies[1]!.provider, {
      only: ["novita", "siliconflow"],
      sort: "price",
    });
    assert.equal(
      cache.isUnsupported({
        provider: "openrouter",
        providerModel: "deepseek/deepseek-v4.1-flash",
      }),
      true,
    );
    assert.equal(
      warnings.filter(
        (entry) =>
          entry.message === "model-gateway.structured-output-fallback" &&
          entry.data?.reason === shape.reason,
      ).length,
      1,
    );

    // The next call goes straight to the non-strict path.
    const again = await gateway.chat.complete(OVERVIEW_REQUEST);
    assert.deepEqual(again.structuredOutputDiagnostics, {
      mechanism: "available_tool",
    });
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2]!.response_format, undefined);
  });
}

test("OpenRouter: unrelated 400 and 500 responses are not retried through the fallback", async () => {
  for (const response of [
    () =>
      errorResponse(400, { error: { message: "messages must not be empty" } }),
    () => errorResponse(500, { error: { message: "Internal Server Error" } }),
  ]) {
    const bodies: Record<string, unknown>[] = [];
    const cache = new StrictJsonSchemaSupportCache();
    const gateway = openRouterGateway({ bodies, cache, respond: response });
    await assert.rejects(
      gateway.chat.complete(OVERVIEW_REQUEST),
      (error: unknown) => error instanceof ModelGatewayError,
    );
    assert.equal(bodies.length, 1);
    assert.equal(
      cache.isUnsupported({
        provider: "openrouter",
        providerModel: "deepseek/deepseek-v4.1-flash",
      }),
      false,
    );
  }
});

test("OpenRouter without json_schema_strict keeps the available-tool path and no require_parameters", async () => {
  const bodies: Record<string, unknown>[] = [];
  const gateway = openRouterGateway({
    bodies,
    cache: new StrictJsonSchemaSupportCache(),
    supports: ["chat", "tool_calling", "json_schema"],
    respond: () =>
      completion(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "storyboard", arguments: '{"title":"Tool"}' },
            },
          ],
        },
        "tool_calls",
      ),
  });
  const result = await gateway.chat.complete(OVERVIEW_REQUEST);
  assert.deepEqual(result.structuredOutput, { title: "Tool" });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.response_format, undefined);
  assert.deepEqual(bodies[0]!.provider, {
    only: ["novita", "siliconflow"],
    sort: "price",
  });
});

test("strict content that is not valid JSON is a retryable STRUCTURED_OUTPUT failure, not a fallback", async () => {
  // DeepSeek's unescaped inner quotes. Under strict json_schema the Provider
  // constrains decoding, so this should not happen; if it does, the SDK rejects
  // the content before any gateway parser runs, and the caller's retry applies.
  const bodies: Record<string, unknown>[] = [];
  const cache = new StrictJsonSchemaSupportCache();
  const gateway = openRouterGateway({
    bodies,
    cache,
    respond: () =>
      completion({ role: "assistant", content: '{"title":"没有"表面""}' }),
  });
  await assert.rejects(
    gateway.chat.complete(OVERVIEW_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "STRUCTURED_OUTPUT");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.metadata?.structuredOutputDiagnostics, {
        contentAvailable: false,
        mechanism: "json_schema_strict",
      });
      return true;
    },
  );
  assert.equal(bodies.length, 1);
  assert.equal(
    cache.isUnsupported({
      provider: "openrouter",
      providerModel: "deepseek/deepseek-v4.1-flash",
    }),
    false,
  );
});

test("strict content cut off at the token limit is a STRUCTURED_OUTPUT failure with its finish reason", async () => {
  const bodies: Record<string, unknown>[] = [];
  const gateway = openRouterGateway({
    bodies,
    cache: new StrictJsonSchemaSupportCache(),
    respond: () =>
      completion({ role: "assistant", content: '{"title":"cut' }, "length"),
  });
  await assert.rejects(
    gateway.chat.complete(OVERVIEW_REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "STRUCTURED_OUTPUT");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.metadata?.structuredOutputDiagnostics, {
        contentAvailable: false,
        finishReason: "length",
        mechanism: "json_schema_strict",
      });
      return true;
    },
  );
  assert.equal(bodies.length, 1);
});

test("an answer the SDK cannot parse is not re-sent by the transport retry loop", async () => {
  // The SDK parses a json_schema answer inside the retried call, so without a
  // guard every unparseable or truncated answer would be requested again
  // (and billed) maxRetries more times before the caller sees it.
  for (const answer of [
    () => completion({ role: "assistant", content: '{"title":"没有"表面""}' }),
    () => completion({ role: "assistant", content: '{"title":"cut' }, "length"),
  ]) {
    const bodies: Record<string, unknown>[] = [];
    const gateway = openRouterGateway({
      bodies,
      cache: new StrictJsonSchemaSupportCache(),
      maxRetries: 2,
      respond: answer,
    });
    await assert.rejects(
      gateway.chat.complete(OVERVIEW_REQUEST),
      (error: unknown) =>
        error instanceof ModelGatewayError &&
        error.code === "STRUCTURED_OUTPUT",
    );
    assert.equal(bodies.length, 1);
  }
});

test("BYOK reusing a strict-capable Provider definition uses strict output with its own key", async () => {
  const requests: Array<{
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  const gateway = createModelGateway({
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.test/api/v1",
        apiKey: "system-key-must-not-be-sent",
        supports: STRICT_SUPPORTS,
        enabled: false,
        byokEnabled: true,
        maxRetries: 0,
      },
    },
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [
          {
            provider: "openrouter",
            model: "deepseek/deepseek-v4.1-flash",
            priority: 1,
          },
        ],
      },
    },
    modelCapabilities: DEEPSEEK_RULES,
    strictJsonSchemaSupport: new StrictJsonSchemaSupportCache(),
    fetch: async (url, init) => {
      const request = new Request(url, init);
      requests.push({
        authorization: request.headers.get("authorization"),
        body: JSON.parse(await request.text()) as Record<string, unknown>,
      });
      return completion({ role: "assistant", content: '{"title":"BYOK"}' });
    },
  });
  const result = await gateway.chat.complete({
    ...OVERVIEW_REQUEST,
    model: "deepseek/deepseek-v4.1-flash",
    executionMode: "BYOK",
    byok: { provider: "openrouter", apiKey: "user-byok-key" },
  });
  assert.deepEqual(result.structuredOutput, { title: "BYOK" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.authorization, "Bearer user-byok-key");
  assert.equal(
    (
      requests[0]!.body.response_format as {
        json_schema?: { strict?: boolean };
      }
    ).json_schema?.strict,
    true,
  );
  assert.deepEqual(requests[0]!.body.provider, { require_parameters: true });
});
