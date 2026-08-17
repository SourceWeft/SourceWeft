import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../src/index";

/**
 * Minimal fake chat model that records how structured output was requested:
 * whether the bridge went through `bindTools` (the strip path) or
 * `withStructuredOutput` (the default path), and with what kwargs.
 */
function createFakeChatModel(input: {
  capture: {
    usedBindTools?: boolean;
    usedWithStructuredOutput?: boolean;
    bindKwargs?: Record<string, unknown>;
  };
  toolCallArgs?: Record<string, unknown>;
}) {
  const invokeResult = {
    id: "msg_1",
    content: "",
    tool_calls: input.toolCallArgs
      ? [{ id: "call_1", name: "storyboard", args: input.toolCallArgs }]
      : [],
    response_metadata: { finish_reason: "tool_calls" },
  };
  const model = {
    getName: () => "fake",
    _streamResponseChunks: () => (async function* () {})(),
    bindTools(_tools: unknown[], kwargs?: Record<string, unknown>) {
      input.capture.usedBindTools = true;
      input.capture.bindKwargs = kwargs;
      return this;
    },
    withStructuredOutput() {
      input.capture.usedWithStructuredOutput = true;
      return {
        invoke: async () => ({
          raw: invokeResult,
          parsed: { via: "withStructuredOutput" },
        }),
      };
    },
    async invoke() {
      return invokeResult;
    },
    async stream() {
      return (async function* () {})();
    },
  };
  return model;
}

function gatewayFor(
  model: string,
  capture: Parameters<typeof createFakeChatModel>[0]["capture"],
  toolCallArgs?: Record<string, unknown>,
  supportsForcedToolChoice?: boolean,
) {
  return createModelGateway({
    baseUrl: "https://gateway.example.com",
    allowedModelAliases: ["chat-default"],
    providers: {
      deepseek: { kind: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "k" },
    },
    // A model that can't take a forced tool_choice declares it via
    // disabled_params (`{ tool_choice: null }`); otherwise no rule (default).
    ...(supportsForcedToolChoice === false
      ? {
          modelCapabilities: [
            {
              modelMatch: model,
              capabilities: { disabledParams: { tool_choice: null } },
            },
          ],
        }
      : {}),
    modelRoutes: {
      "chat-default": {
        strategy: "priority",
        targets: [{ provider: "deepseek", model, priority: 1 }],
      },
    },
    langchainFactories: {
      createChatModel: () => createFakeChatModel({ capture, toolCallArgs }),
    },
  });
}

const schema = {
  type: "object",
  properties: { title: { type: "string" } },
} as Record<string, unknown>;

test("a forced-tool_choice-incompatible model binds the schema as an available tool", async () => {
  const capture: { usedBindTools?: boolean; usedWithStructuredOutput?: boolean; bindKwargs?: Record<string, unknown> } = {};
  // Config declares the model rejects a forced tool_choice.
  const gateway = gatewayFor("deepseek-v4-pro", capture, { title: "Coffee" }, false);

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "storyboard" }],
    structuredOutput: { name: "storyboard", schema },
  });

  assert.equal(capture.usedBindTools, true);
  assert.equal(capture.usedWithStructuredOutput, undefined);
  // Python-faithful: no forced tool_choice (API defaults to auto), single call.
  assert.equal(capture.bindKwargs?.tool_choice, undefined);
  assert.equal(capture.bindKwargs?.parallel_tool_calls, false);
  assert.deepEqual(result.structuredOutput, { title: "Coffee" });
});

test("a forced-tool_choice model keeps the default withStructuredOutput path", async () => {
  const capture: { usedBindTools?: boolean; usedWithStructuredOutput?: boolean } = {};
  const gateway = gatewayFor("deepseek-chat", capture);

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "storyboard" }],
    structuredOutput: { name: "storyboard", schema },
  });

  assert.equal(capture.usedWithStructuredOutput, true);
  assert.equal(capture.usedBindTools, undefined);
  assert.deepEqual(result.structuredOutput, { via: "withStructuredOutput" });
});

test("no tool call on the strip path surfaces as invalid structured output", async () => {
  const capture: { usedBindTools?: boolean } = {};
  const gateway = gatewayFor("deepseek-v4-pro", capture, undefined, false); // no toolCallArgs → empty tool_calls

  await assert.rejects(
    gateway.chat.complete({
      model: "chat-default",
      messages: [{ role: "user", content: "storyboard" }],
      structuredOutput: { name: "storyboard", schema },
    }),
    /structured output/i,
  );
  assert.equal(capture.usedBindTools, true);
});

test("a forced tool_choice on a regular tool call is dropped (disabled_params, request-wide)", async () => {
  const capture: { usedBindTools?: boolean; bindKwargs?: Record<string, unknown> } = {};
  const gateway = gatewayFor("deepseek-v4-pro", capture, undefined, false);

  await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "get_weather" }],
    toolChoice: { type: "function", function: { name: "get_weather" } },
  });

  assert.equal(capture.usedBindTools, true);
  // Python-faithful: `disabled_params: { tool_choice: null }` drops the param
  // entirely rather than rewriting it — the API then defaults to `auto`.
  assert.equal("tool_choice" in (capture.bindKwargs ?? {}), false);
});

test("no tool_choice disable rule keeps the default forced path", async () => {
  const capture: { usedWithStructuredOutput?: boolean; usedBindTools?: boolean } = {};
  // With no `disabled_params` rule declared for the model, forcing is on and
  // structured output keeps the default withStructuredOutput (forced) path.
  const gateway = gatewayFor("deepseek-v4-pro", capture, { title: "x" }, true);

  const result = await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "storyboard" }],
    structuredOutput: { name: "storyboard", schema },
  });

  assert.equal(capture.usedWithStructuredOutput, true);
  assert.equal(capture.usedBindTools, undefined);
  assert.deepEqual(result.structuredOutput, { via: "withStructuredOutput" });
});

test("config override reaches the target: false strips even a table-unlisted model", async () => {
  const capture: { usedBindTools?: boolean; bindKwargs?: Record<string, unknown> } = {};
  const gateway = gatewayFor("gpt-5", capture, { title: "x" }, false);

  await gateway.chat.complete({
    model: "chat-default",
    messages: [{ role: "user", content: "storyboard" }],
    structuredOutput: { name: "storyboard", schema },
  });

  assert.equal(capture.usedBindTools, true);
  assert.equal(capture.bindKwargs?.parallel_tool_calls, false);
});
