import assert from "node:assert/strict";
import test from "node:test";
import { executeStructuredOutput } from "../src/bridge/structured-output";
import type {
  LangChainChatModelLike,
  ResolvedRequestTarget,
} from "../src/types";

const TARGET = {
  provider: "deepseek",
  providerKind: "deepseek",
  providerModel: "deepseek-v4-pro",
  routeDecision: { alias: "chat-default" },
} as unknown as ResolvedRequestTarget;

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
} as Record<string, unknown>;

/**
 * Fake model recording which structured path the executor drove: the
 * `availableTool` strip (bindTools) or native `withStructuredOutput`, and with
 * what kwargs/config.
 */
function createFakeModel(input: {
  capture: {
    usedBindTools?: boolean;
    usedWithStructuredOutput?: boolean;
    bindKwargs?: Record<string, unknown>;
    structuredConfig?: Record<string, unknown>;
  };
  toolName?: string;
  toolCallArgs?: Record<string, unknown>;
  parsed?: Record<string, unknown>;
}): LangChainChatModelLike {
  const rawMessage = {
    id: "msg_1",
    content: "",
    tool_calls: input.toolCallArgs
      ? [
          {
            id: "call_1",
            name: input.toolName ?? "storyboard",
            args: input.toolCallArgs,
          },
        ]
      : [],
    response_metadata: { finish_reason: "tool_calls" },
  };
  const model: LangChainChatModelLike = {
    getName: () => "fake",
    bindTools: (_tools, kwargs) => {
      input.capture.usedBindTools = true;
      input.capture.bindKwargs = kwargs;
      return model;
    },
    withStructuredOutput: (_schema, config) => {
      input.capture.usedWithStructuredOutput = true;
      input.capture.structuredConfig = config as Record<string, unknown>;
      return {
        invoke: async () => ({
          raw: rawMessage,
          parsed: input.parsed ?? { via: "withStructuredOutput" },
        }),
      };
    },
    invoke: async () => rawMessage,
    stream: async () => (async function* () {})(),
  };
  return model;
}

test("executeStructuredOutput: disabled forced tool_choice → available-tool strip", async () => {
  const capture: Record<string, unknown> = {};
  const model = createFakeModel({
    capture,
    toolName: "storyboard",
    toolCallArgs: { title: "Coffee" },
  });

  const { parsed, rawMessage } = await executeStructuredOutput({
    model,
    schema: SCHEMA,
    name: "storyboard",
    messages: [{ role: "user", content: "hi" }],
    target: TARGET,
    supportsForcedToolChoice: false,
    allowJsonRepair: false,
  });

  assert.equal(capture.usedBindTools, true);
  assert.equal(capture.usedWithStructuredOutput, undefined);
  // Python-faithful: no forced tool_choice, single call.
  assert.equal(
    (capture.bindKwargs as Record<string, unknown> | undefined)?.tool_choice,
    undefined,
  );
  assert.equal(
    (capture.bindKwargs as Record<string, unknown> | undefined)
      ?.parallel_tool_calls,
    false,
  );
  assert.deepEqual(parsed, { title: "Coffee" });
  assert.ok(rawMessage);
});

test("executeStructuredOutput: supported forced tool_choice → native withStructuredOutput", async () => {
  const capture: Record<string, unknown> = {};
  const model = createFakeModel({ capture, parsed: { title: "Latte" } });

  const { parsed } = await executeStructuredOutput({
    model,
    schema: SCHEMA,
    name: "storyboard",
    messages: [{ role: "user", content: "hi" }],
    target: TARGET,
    supportsForcedToolChoice: true,
    allowJsonRepair: false,
  });

  assert.equal(capture.usedWithStructuredOutput, true);
  assert.equal(capture.usedBindTools, undefined);
  // includeRaw is always requested so callers get the raw response for billing.
  assert.equal(
    (capture.structuredConfig as Record<string, unknown>)?.includeRaw,
    true,
  );
  // No pinned/fallback method → LangChain selects per model (method absent).
  assert.equal(
    (capture.structuredConfig as Record<string, unknown>)?.method,
    undefined,
  );
  assert.deepEqual(parsed, { title: "Latte" });
});

test("executeStructuredOutput: fallbackMethod fills the native method when none pinned", async () => {
  const capture: Record<string, unknown> = {};
  const model = createFakeModel({ capture, parsed: { title: "x" } });

  await executeStructuredOutput({
    model,
    schema: SCHEMA,
    name: "storyboard",
    messages: [{ role: "user", content: "hi" }],
    target: TARGET,
    supportsForcedToolChoice: true,
    fallbackMethod: "function_calling",
    allowJsonRepair: false,
  });

  assert.equal(
    (capture.structuredConfig as Record<string, unknown>)?.method,
    "functionCalling",
  );
});

test("executeStructuredOutput: a pinned method forces the native path even with forced tool_choice disabled", async () => {
  const capture: Record<string, unknown> = {};
  const model = createFakeModel({ capture, parsed: { title: "x" } });

  await executeStructuredOutput({
    model,
    schema: SCHEMA,
    name: "storyboard",
    messages: [{ role: "user", content: "hi" }],
    target: TARGET,
    supportsForcedToolChoice: false,
    method: "json_schema",
    allowJsonRepair: false,
  });

  // method is authoritative: native structured path, not the strip.
  assert.equal(capture.usedWithStructuredOutput, true);
  assert.equal(capture.usedBindTools, undefined);
  assert.equal(
    (capture.structuredConfig as Record<string, unknown>)?.method,
    "jsonSchema",
  );
});

test("executeStructuredOutput: no tool call on the strip path surfaces as invalid structured output", async () => {
  const capture: Record<string, unknown> = {};
  const model = createFakeModel({ capture }); // no toolCallArgs → empty tool_calls

  await assert.rejects(
    executeStructuredOutput({
      model,
      schema: SCHEMA,
      name: "storyboard",
      messages: [{ role: "user", content: "hi" }],
      target: TARGET,
      supportsForcedToolChoice: false,
      allowJsonRepair: false,
    }),
    /structured output/i,
  );
  assert.equal(capture.usedBindTools, true);
});
