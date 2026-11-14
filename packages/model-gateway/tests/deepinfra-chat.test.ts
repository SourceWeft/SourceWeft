import assert from "node:assert/strict";
import test from "node:test";
import { DeepInfraChatAdapter } from "../src/adapters/deepinfra-chat";
import type { ChatCompleteInput } from "../src/types";
import { makeResolvedTarget } from "./helpers";

const target = makeResolvedTarget({
  provider: "deepinfra",
  providerKind: "deepinfra",
  providerModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  baseUrl: "https://api.deepinfra.com/v1",
  supports: ["chat", "tool_calling", "json_schema"],
});

const input: ChatCompleteInput = {
  model: "chat-default",
  messages: [{ role: "user", content: "hello" }],
};

const declared = {
  supportedParameters: ["reasoning_effort"],
  supportedEfforts: ["minimal", "low", "medium", "high"],
} satisfies ChatCompleteInput["thinking"];

function modelKwargs(model: unknown) {
  return (model as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};
}

function createWithThinking(thinking: ChatCompleteInput["thinking"]) {
  return modelKwargs(
    new DeepInfraChatAdapter().createModel(target, { ...input, thinking }),
  );
}

test("no thinking config sends no reasoning parameter", () => {
  assert.deepEqual(createWithThinking(undefined), {});
});

test("a requested effort is sent as reasoning_effort", () => {
  assert.deepEqual(
    createWithThinking({ ...declared, mode: "effort", effort: "high" }),
    { reasoning_effort: "high" },
  );
  assert.deepEqual(
    createWithThinking({ ...declared, enabled: true, effort: "low" }),
    { reasoning_effort: "low" },
  );
});

test("thinking off is stated explicitly instead of relying on the host default", () => {
  assert.deepEqual(createWithThinking({ ...declared, mode: "off" }), {
    reasoning_effort: "none",
  });
  assert.deepEqual(createWithThinking({ ...declared, enabled: false }), {
    reasoning_effort: "none",
  });
});

test("auto leaves the decision to the host", () => {
  assert.deepEqual(createWithThinking({ ...declared, mode: "auto" }), {});
});

test("a profile that does not declare reasoning_effort gets no reasoning parameter", () => {
  assert.deepEqual(createWithThinking({ mode: "effort", effort: "high" }), {});
  assert.deepEqual(createWithThinking({ mode: "off" }), {});
  assert.deepEqual(
    createWithThinking({
      mode: "off",
      supportedParameters: ["reasoning", "include_reasoning"],
    }),
    {},
  );
});

test("an effort the profile does not list is not sent", () => {
  assert.deepEqual(
    createWithThinking({ ...declared, mode: "effort", effort: "xhigh" }),
    {},
  );
});
