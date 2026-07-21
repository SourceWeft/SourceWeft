import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekChatAdapter } from "../src/adapters/deepseek-chat";
import { ModelGatewayError } from "../src/errors";
import type { ChatCompleteInput, ResolvedRequestTarget } from "../src/types";

const target: ResolvedRequestTarget = {
  provider: "deepseek",
  providerKind: "deepseek",
  providerModel: "deepseek-v4-pro",
  baseUrl: "https://api.deepseek.com",
  apiKey: "test-key",
  defaultHeaders: {},
  supports: ["chat", "tool_calling", "json_object"],
  routeDecision: {
    alias: "chat-default",
    mode: "GLOBAL",
    strategy: "priority",
    provider: "deepseek",
    providerKind: "deepseek",
  },
  requestMetadata: {},
};

const input: ChatCompleteInput = {
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "hello" }],
};

function modelKwargs(model: unknown) {
  return (model as { modelKwargs?: Record<string, unknown> }).modelKwargs ?? {};
}

function createWithThinking(thinking: ChatCompleteInput["thinking"]) {
  return modelKwargs(
    new DeepSeekChatAdapter().createModel(target, { ...input, thinking }),
  );
}

test("a missing API key fails as a gateway error, not ChatDeepSeek's bare throw", () => {
  assert.throws(
    () =>
      new DeepSeekChatAdapter().createModel(
        { ...target, apiKey: undefined },
        input,
      ),
    (error: unknown) =>
      error instanceof ModelGatewayError && error.code === "BAD_REQUEST",
  );
});

test("no thinking config sends no thinking kwargs", () => {
  assert.deepEqual(createWithThinking(undefined), {});
});

test("thinking off is stated explicitly because DeepSeek defaults it on", () => {
  assert.deepEqual(createWithThinking({ enabled: false }), {
    thinking: { type: "disabled" },
  });
});

test("effort is projected onto DeepSeek's two-value scale", () => {
  assert.deepEqual(
    createWithThinking({
      enabled: true,
      effort: "high",
      supportedEfforts: ["high", "xhigh"],
    }),
    { thinking: { type: "enabled" }, reasoning_effort: "high" },
  );

  assert.deepEqual(
    createWithThinking({
      enabled: true,
      effort: "xhigh",
      supportedEfforts: ["high", "xhigh"],
    }),
    { thinking: { type: "enabled" }, reasoning_effort: "max" },
  );
});

test("efforts below high enable thinking without buying more of it", () => {
  assert.deepEqual(
    createWithThinking({
      enabled: true,
      effort: "low",
      supportedEfforts: ["low", "high", "xhigh"],
    }),
    { thinking: { type: "enabled" } },
  );
});

test("extraBody survives alongside the thinking kwargs", () => {
  const kwargs = modelKwargs(
    new DeepSeekChatAdapter().createModel(
      target,
      { ...input, extraBody: { custom: 1 }, thinking: { enabled: false } },
    ),
  );

  assert.deepEqual(kwargs, {
    custom: 1,
    thinking: { type: "disabled" },
  });
});
