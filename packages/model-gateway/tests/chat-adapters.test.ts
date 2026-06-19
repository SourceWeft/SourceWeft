import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicChatAdapter } from "../src/adapters/anthropic-chat";
import { AzureChatAdapter } from "../src/adapters/azure-chat";
import { DeepInfraChatAdapter } from "../src/adapters/deepinfra-chat";
import { OpenAICompatibleChatAdapter } from "../src/adapters/openai-compatible-chat";
import { OpenRouterChatAdapter } from "../src/adapters/openrouter-chat";
import type {
  ChatCompleteInput,
  RequestOptions,
  ResolvedRequestTarget,
} from "../src/types";

const target: ResolvedRequestTarget = {
  provider: "openai",
  kind: "openai",
  providerModel: "test-model",
  baseUrl: "https://gateway.example.com",
  apiKey: "test-key",
};

const input: ChatCompleteInput = {
  messages: [{ role: "user", content: "hello" }],
};

function modelRetryCount(model: unknown) {
  const caller = (model as { caller?: { maxRetries?: unknown } }).caller;
  return caller?.maxRetries;
}

function createWithOptions(
  createModel: (options?: RequestOptions) => unknown,
) {
  return {
    withoutOptions: createModel(),
    withoutRetries: createModel({ maxRetries: 0 }),
    withRetries: createModel({ maxRetries: 1 }),
  };
}

test("chat adapters preserve request maxRetries for LangChain models", () => {
  const adapters = [
    new OpenAICompatibleChatAdapter(),
    new OpenRouterChatAdapter(),
    new DeepInfraChatAdapter(),
    new AzureChatAdapter(),
    new AnthropicChatAdapter(),
  ];

  for (const adapter of adapters) {
    const models = createWithOptions((options) =>
      adapter.createModel(target, input, options),
    );

    assert.equal(
      modelRetryCount(models.withoutOptions),
      2,
      `${adapter.kind} should keep the legacy default retry count`,
    );
    assert.equal(
      modelRetryCount(models.withoutRetries),
      0,
      `${adapter.kind} should allow callers to disable SDK retries`,
    );
    assert.equal(
      modelRetryCount(models.withRetries),
      1,
      `${adapter.kind} should honor per-request retry count`,
    );
  }
});
