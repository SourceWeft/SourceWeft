import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStrictJsonSchemaRejection,
  isStrictJsonSchemaCompatible,
  strictJsonSchemaEligibility,
} from "../src/bridge/strict-json-schema";
import {
  STRICT_JSON_SCHEMA_SUPPORT,
  STRICT_JSON_SCHEMA_UNSUPPORTED_TTL_MS,
  StrictJsonSchemaSupportCache,
} from "../src/strict-json-schema-support";
import { ModelGatewayError, createHttpGatewayError } from "../src/errors";
import {
  isUnparsedStructuredAnswer,
  unparsedFinishReason,
} from "../src/structured-output-errors";

const leaf = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", maxLength: 200 },
    cautions: { type: "string", minLength: 0 },
  },
  required: ["summary", "cautions"],
};

// Shaped like the MCP overview schema: a shared localized sub-schema, arrays
// of objects, enums and length limits.
const COMPATIBLE = {
  type: "object",
  additionalProperties: false,
  properties: {
    en: leaf,
    "zh-CN": leaf,
    classification: {
      type: "object",
      additionalProperties: false,
      properties: {
        categories: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              slug: { type: "string", enum: ["a", "b"] },
              evidence: { type: "string", minLength: 1, maxLength: 300 },
            },
            required: ["slug", "evidence"],
          },
        },
        primary: { anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }] },
        note: { type: ["string", "null"] },
      },
      required: ["categories", "primary", "note"],
    },
  },
  required: ["en", "zh-CN", "classification"],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("isStrictJsonSchemaCompatible: a fully closed nested schema is compatible", () => {
  assert.equal(isStrictJsonSchemaCompatible(COMPATIBLE), true);
});

test("isStrictJsonSchemaCompatible: an object without additionalProperties: false is not", () => {
  const missing = clone(COMPATIBLE);
  delete (missing.properties.classification as Record<string, unknown>)
    .additionalProperties;
  assert.equal(isStrictJsonSchemaCompatible(missing), false);

  const open = clone(COMPATIBLE) as Record<string, unknown>;
  open.additionalProperties = true;
  assert.equal(isStrictJsonSchemaCompatible(open), false);
});

test("isStrictJsonSchemaCompatible: every property must be required, and nothing else", () => {
  const optional = clone(COMPATIBLE);
  optional.properties.en.required = ["summary"];
  assert.equal(isStrictJsonSchemaCompatible(optional), false);

  const extra = clone(COMPATIBLE);
  extra.required = [...extra.required, "ghost"];
  assert.equal(isStrictJsonSchemaCompatible(extra), false);

  const absent = clone(COMPATIBLE) as Record<string, unknown>;
  delete absent.required;
  assert.equal(isStrictJsonSchemaCompatible(absent), false);
});

test("isStrictJsonSchemaCompatible: arrays of objects are checked through items", () => {
  const openItems = clone(COMPATIBLE);
  delete (
    openItems.properties.classification.properties.categories.items as Record<
      string,
      unknown
    >
  ).additionalProperties;
  assert.equal(isStrictJsonSchemaCompatible(openItems), false);

  const noItems = clone(COMPATIBLE);
  delete (
    noItems.properties.classification.properties.categories as Record<
      string,
      unknown
    >
  ).items;
  assert.equal(isStrictJsonSchemaCompatible(noItems), false);

  const tuple = clone(COMPATIBLE);
  (
    tuple.properties.classification.properties.categories as Record<
      string,
      unknown
    >
  ).items = [{ type: "string" }];
  assert.equal(isStrictJsonSchemaCompatible(tuple), false);
});

test("isStrictJsonSchemaCompatible: anyOf with null is compatible, its branches are checked", () => {
  assert.equal(
    isStrictJsonSchemaCompatible({
      type: "object",
      additionalProperties: false,
      properties: {
        maybe: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: { x: { type: "integer" } },
              required: ["x"],
            },
            { type: "null" },
          ],
        },
      },
      required: ["maybe"],
    }),
    true,
  );
  assert.equal(
    isStrictJsonSchemaCompatible({
      type: "object",
      additionalProperties: false,
      properties: {
        maybe: {
          anyOf: [
            { type: "object", properties: { x: { type: "integer" } } },
            { type: "null" },
          ],
        },
      },
      required: ["maybe"],
    }),
    false,
  );
});

test("isStrictJsonSchemaCompatible: keywords strict mode rejects make a schema incompatible", () => {
  for (const [keyword, value] of [
    ["oneOf", [{ type: "string" }, { type: "null" }]],
    ["allOf", [{ type: "string" }]],
    ["not", { type: "null" }],
    ["if", { type: "string" }],
    ["then", { type: "string" }],
    ["else", { type: "string" }],
    ["patternProperties", { "^x": { type: "string" } }],
    ["dependentRequired", { a: ["b"] }],
    ["dependentSchemas", { a: { type: "object" } }],
    ["unevaluatedProperties", false],
    ["$ref", "#/$defs/x"],
    ["$defs", { x: { type: "string" } }],
  ] as const) {
    const schema = clone(COMPATIBLE) as Record<string, unknown>;
    (schema.properties as Record<string, Record<string, unknown>>).en = {
      ...leaf,
      [keyword]: value,
    };
    assert.equal(isStrictJsonSchemaCompatible(schema), false, keyword);
  }
});

test("isStrictJsonSchemaCompatible: non-object roots, untyped nodes and zod-like objects are not compatible", () => {
  assert.equal(isStrictJsonSchemaCompatible({ type: "string" }), false);
  assert.equal(isStrictJsonSchemaCompatible(null), false);
  assert.equal(
    isStrictJsonSchemaCompatible({
      type: "object",
      additionalProperties: false,
      properties: { anything: {} },
      required: ["anything"],
    }),
    false,
  );
  // A zod object exposes `type: "object"` but no JSON-schema `properties`.
  assert.equal(
    isStrictJsonSchemaCompatible({ type: "object", shape: { a: {} } }),
    false,
  );
  const cyclic: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["self"],
  };
  cyclic.properties = { self: cyclic };
  assert.equal(isStrictJsonSchemaCompatible(cyclic), false);
});

test("strictJsonSchemaEligibility: provider flag, schema, cache, pinned method and opt-out", () => {
  const supports = ["chat", "json_schema", STRICT_JSON_SCHEMA_SUPPORT];
  assert.deepEqual(
    strictJsonSchemaEligibility({
      supports,
      schema: COMPATIBLE,
      knownUnsupported: false,
    }),
    { eligible: true },
  );
  assert.deepEqual(
    strictJsonSchemaEligibility({
      method: "function_calling",
      supports,
      schema: COMPATIBLE,
      knownUnsupported: false,
    }),
    { eligible: false, reason: "method_pinned" },
  );
  assert.deepEqual(
    strictJsonSchemaEligibility({
      strict: false,
      supports,
      schema: COMPATIBLE,
      knownUnsupported: false,
    }),
    { eligible: false, reason: "strict_disabled" },
  );
  assert.deepEqual(
    strictJsonSchemaEligibility({
      supports: ["chat", "json_schema"],
      schema: COMPATIBLE,
      knownUnsupported: false,
    }),
    { eligible: false, reason: "provider_undeclared" },
  );
  assert.deepEqual(
    strictJsonSchemaEligibility({
      supports,
      schema: { type: "object", properties: { a: { type: "string" } } },
      knownUnsupported: false,
    }),
    { eligible: false, reason: "schema_incompatible" },
  );
  assert.deepEqual(
    strictJsonSchemaEligibility({
      supports,
      schema: COMPATIBLE,
      knownUnsupported: true,
    }),
    { eligible: false, reason: "known_unsupported" },
  );
});

test("StrictJsonSchemaSupportCache remembers (provider, model) for one hour", () => {
  let now = 1_000;
  const cache = new StrictJsonSchemaSupportCache({ now: () => now });
  const target = { provider: "openrouter", providerModel: "vendor/model" };
  assert.equal(STRICT_JSON_SCHEMA_UNSUPPORTED_TTL_MS, 60 * 60 * 1000);
  assert.equal(cache.isUnsupported(target), false);
  cache.markUnsupported(target);
  assert.equal(cache.isUnsupported(target), true);
  // Keyed by provider and model.
  assert.equal(
    cache.isUnsupported({ provider: "other", providerModel: "vendor/model" }),
    false,
  );
  assert.equal(
    cache.isUnsupported({ provider: "openrouter", providerModel: "vendor/x" }),
    false,
  );
  now += STRICT_JSON_SCHEMA_UNSUPPORTED_TTL_MS - 1;
  assert.equal(cache.isUnsupported(target), true);
  now += 1;
  assert.equal(cache.isUnsupported(target), false);
});

test("StrictJsonSchemaSupportCache is size-bounded, evicting the oldest entry", () => {
  const cache = new StrictJsonSchemaSupportCache({ maxEntries: 2 });
  const a = { provider: "p", providerModel: "a" };
  const b = { provider: "p", providerModel: "b" };
  const c = { provider: "p", providerModel: "c" };
  cache.markUnsupported(a);
  cache.markUnsupported(b);
  cache.markUnsupported(c);
  assert.equal(cache.size, 2);
  assert.equal(cache.isUnsupported(a), false);
  assert.equal(cache.isUnsupported(b), true);
  assert.equal(cache.isUnsupported(c), true);
});

/** The error the OpenAI SDK raises for a non-2xx response (APIError shape). */
function sdkError(status: number, body: { error: Record<string, unknown> }) {
  const error = new Error(
    `${status} ${String(body.error.message)}`,
  ) as Error & {
    status: number;
    error: Record<string, unknown>;
  };
  error.status = status;
  error.error = body.error;
  return error;
}

const OPENROUTER_NO_ENDPOINTS = {
  error: {
    message:
      "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
    code: 404,
    metadata: {
      routing_funnel: [{ step: "Initial Endpoints", endpoint_count: 1 }],
      failed_routing_step: "Filter by Parameters",
    },
  },
};

test("classifyStrictJsonSchemaRejection recognizes the three rejection shapes", () => {
  assert.equal(
    classifyStrictJsonSchemaRejection(sdkError(404, OPENROUTER_NO_ENDPOINTS)),
    "no_endpoint_for_parameters",
  );
  // The same body normalized by the gateway (e.g. after an SDK wrapper).
  assert.equal(
    classifyStrictJsonSchemaRejection(
      createHttpGatewayError({
        statusCode: 404,
        body: OPENROUTER_NO_ENDPOINTS,
      }),
    ),
    "no_endpoint_for_parameters",
  );
  assert.equal(
    classifyStrictJsonSchemaRejection(
      sdkError(400, {
        error: {
          message: "This response_format type is unavailable now",
          type: "invalid_request_error",
        },
      }),
    ),
    "response_format_unsupported",
  );
  assert.equal(
    classifyStrictJsonSchemaRejection(
      sdkError(400, {
        error: {
          message: "json_schema response format is not supported by this model",
        },
      }),
    ),
    "response_format_unsupported",
  );
  assert.equal(
    classifyStrictJsonSchemaRejection(
      sdkError(400, {
        error: {
          message:
            "Invalid schema for response_format 'mcp_overview': In context=(), 'required' is required to be supplied and to be an array including every key in properties.",
        },
      }),
    ),
    "invalid_schema",
  );
  // OpenRouter relays an upstream rejection with the Provider's text in metadata.raw.
  assert.equal(
    classifyStrictJsonSchemaRejection(
      sdkError(400, {
        error: {
          message: "Provider returned error",
          code: 400,
          metadata: {
            raw: '{"error":{"message":"This response_format type is unavailable now"}}',
            provider_name: "DeepSeek",
          },
        },
      }),
    ),
    "response_format_unsupported",
  );
});

test("classifyStrictJsonSchemaRejection ignores every other error", () => {
  for (const error of [
    sdkError(400, { error: { message: "messages must not be empty" } }),
    sdkError(400, { error: { message: "Invalid value for temperature" } }),
    sdkError(404, { error: { message: "Model not found" } }),
    sdkError(500, { error: { message: "response_format is not supported" } }),
    sdkError(429, {
      error: {
        message: "No endpoints found that can handle the requested parameters",
      },
    }),
    new ModelGatewayError({ code: "TIMEOUT", message: "timed out" }),
    new SyntaxError("Unexpected token"),
    Object.assign(new Error("aborted"), { name: "AbortError" }),
    "not an error",
  ]) {
    assert.equal(classifyStrictJsonSchemaRejection(error), undefined);
  }
});

test("isUnparsedStructuredAnswer matches only the SDK's structured-answer parse failures", () => {
  const answerParse = new SyntaxError("Unexpected token 'x'");
  answerParse.stack = [
    "SyntaxError: Unexpected token 'x'",
    "    at JSON.parse (<anonymous>)",
    "    at parseResponseFormat (/app/node_modules/openai/lib/parser.js:131:21)",
    "    at parseChatCompletion (/app/node_modules/openai/lib/parser.js:112:20)",
  ].join("\n");
  assert.equal(isUnparsedStructuredAnswer(answerParse), true);

  class LengthFinishReasonError extends Error {}
  const truncated = new LengthFinishReasonError(
    "Could not parse response content as the length limit was reached",
  );
  assert.equal(isUnparsedStructuredAnswer(truncated), true);
  assert.equal(unparsedFinishReason(truncated), "length");
  class ContentFilterFinishReasonError extends Error {}
  assert.equal(
    unparsedFinishReason(
      new ContentFilterFinishReasonError(
        "Could not parse response content as the request was rejected by the content filter",
      ),
    ),
    "content_filter",
  );

  // A garbled response body keeps the transport retry.
  const garbledBody = new SyntaxError("Unexpected token '<'");
  garbledBody.stack = [
    "SyntaxError: Unexpected token '<'",
    "    at JSON.parse (<anonymous>)",
    "    at defaultParseResponse (/app/node_modules/openai/internal/parse.js:40:20)",
  ].join("\n");
  assert.equal(isUnparsedStructuredAnswer(garbledBody), false);
  assert.equal(isUnparsedStructuredAnswer(new Error("socket hang up")), false);
  assert.equal(isUnparsedStructuredAnswer(undefined), false);
});
