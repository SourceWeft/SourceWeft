import assert from "node:assert/strict";
import test from "node:test";
import { createModelGateway } from "../../src/index";
import type { ChatStreamEvent } from "../../src/types";
import {
  OPENROUTER_CHAT_MODEL,
  assertGatewayErrorShape,
  collectStreamText,
  createIntegrationGatewayConfig,
  createMockGatewayError,
  createPriorityRoute,
  createProviderConfig,
  readIntegrationEnv,
  requireProvider,
} from "./setup";

const CHAT_ALIAS = "chat-default";

function hasChatContent(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    return false;
  }

  const content = (raw as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((item) => {
    if (typeof item === "string") {
      return item.trim().length > 0;
    }
    if (!item || typeof item !== "object") {
      return false;
    }
    const part = item as { text?: unknown; content?: unknown };
    return (
      (typeof part.text === "string" && part.text.trim().length > 0) ||
      (typeof part.content === "string" && part.content.trim().length > 0)
    );
  });
}

test(
  "chat.complete via OpenRouter returns LangChain response",
  { skip: !readIntegrationEnv().openrouter },
  async () => {
    const provider = requireProvider(readIntegrationEnv().openrouter, "OPENROUTER_API_KEY");
    const gateway = createModelGateway(
      createIntegrationGatewayConfig({
        aliases: [CHAT_ALIAS],
        providers: {
          openrouter: createProviderConfig({
            kind: "openrouter",
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          }),
        },
        routes: {
          [CHAT_ALIAS]: createPriorityRoute({
            provider: "openrouter",
            model: OPENROUTER_CHAT_MODEL,
          }),
        },
      }),
    );

    const result = await gateway.chat.complete({
      model: CHAT_ALIAS,
      messages: [{ role: "user", content: "Reply with exactly: integration-ok" }],
      maxTokens: 32,
      temperature: 0,
    });

    assert.equal(result.provider, "openrouter");
    assert.equal(result.providerModel, OPENROUTER_CHAT_MODEL);
    assert.equal(result.routeDecision?.alias, CHAT_ALIAS);
    assert.equal(result.routeDecision?.strategy, "priority");
    assert.equal("providerModel" in result.routeDecision, false);
    if (!hasChatContent(result.raw)) {
      // Surface the real provider payload shape so we can fix passthrough handling instead of guessing.
      console.error(
        "OpenRouter chat returned no content",
        JSON.stringify(
          {
            provider: result.provider,
            providerModel: result.providerModel,
            routeDecision: result.routeDecision,
            rawContent: result.raw.content,
            lcKwargs: (result.raw as unknown as { lc_kwargs?: unknown }).lc_kwargs,
            additionalKwargs: result.raw.additional_kwargs,
            responseMetadata: result.providerFields,
            rawKeys: Object.keys(result.raw as unknown as Record<string, unknown>),
          },
          null,
          2,
        ),
      );
    }
    assert.ok(
      hasChatContent(result.raw) ||
        result.finishReason === "length" ||
        (result.usage?.outputTokens ?? 0) > 0,
    );
    assert.ok(typeof result.raw === "object");
  },
);

test(
  "chat.complete preserves traceId and route decision",
  { skip: !readIntegrationEnv().openrouter },
  async () => {
    const provider = requireProvider(readIntegrationEnv().openrouter, "OPENROUTER_API_KEY");
    const gateway = createModelGateway(
      createIntegrationGatewayConfig({
        aliases: [CHAT_ALIAS],
        providers: {
          openrouter: createProviderConfig({
            kind: "openrouter",
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          }),
        },
        routes: {
          [CHAT_ALIAS]: createPriorityRoute({
            provider: "openrouter",
            model: OPENROUTER_CHAT_MODEL,
          }),
        },
      }),
    );

    const result = await gateway.chat.complete(
      {
        model: CHAT_ALIAS,
        messages: [
          { role: "system", content: "You answer briefly." },
          { role: "user", content: "Say hello in one word." },
        ],
        maxTokens: 24,
        temperature: 0,
      },
      { traceId: "trace_chat_integration" },
    );

    assert.equal(result.traceId, "trace_chat_integration");
    assert.equal(result.routeDecision?.alias, CHAT_ALIAS);
    assert.equal(result.routeDecision?.strategy, "priority");
  },
);

test(
  "chat.stream via OpenRouter yields LangChain chunks and metadata event",
  { skip: !readIntegrationEnv().openrouter },
  async () => {
    const provider = requireProvider(readIntegrationEnv().openrouter, "OPENROUTER_API_KEY");
    const gateway = createModelGateway(
      createIntegrationGatewayConfig({
        aliases: [CHAT_ALIAS],
        providers: {
          openrouter: createProviderConfig({
            kind: "openrouter",
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
          }),
        },
        routes: {
          [CHAT_ALIAS]: createPriorityRoute({
            provider: "openrouter",
            model: OPENROUTER_CHAT_MODEL,
          }),
        },
      }),
    );

    const events: ChatStreamEvent[] = [];
    for await (const event of gateway.chat.stream({
      model: CHAT_ALIAS,
      messages: [{ role: "user", content: "Count from 1 to 3 with commas." }],
      maxTokens: 32,
      temperature: 0,
    })) {
      events.push(event);
    }

    assert.ok(events.every((event) => event.type !== "error"));
    assert.ok(events.some((event) => event.type === "metadata"));
    const tokenText = collectStreamText(events);
    const metadataEvent = events.find((event) => event.type === "metadata");
    if (metadataEvent?.type !== "metadata") {
      throw new Error("Expected metadata event");
    }

    assert.equal(metadataEvent.metadata.routeDecision?.alias, CHAT_ALIAS);
    assert.equal("providerModel" in (metadataEvent.metadata.routeDecision as unknown as Record<string, unknown>), false);
    assert.ok(
      tokenText.length > 0 ||
        metadataEvent.metadata.finishReason === "length" ||
        (metadataEvent.metadata.usage?.outputTokens ?? 0) > 0,
    );
  },
);

test("chat.stream emits a normalized error event when LangChain stream fails", async () => {
  const gateway = createModelGateway({
    allowedModelAliases: [CHAT_ALIAS],
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
      },
    },
    modelRoutes: {
      [CHAT_ALIAS]: createPriorityRoute({
        provider: "openrouter",
        model: OPENROUTER_CHAT_MODEL,
      }),
    },
    langchainFactories: {
      createChatModel: () => ({
        async invoke() {
          return {};
        },
        async stream() {
          throw createMockGatewayError({
            code: "RATE_LIMIT",
            message: "Too many requests",
            retryable: true,
            statusCode: 429,
            provider: "openrouter",
            requestId: "req_chat_stream",
          });
        },
      }),
    },
  });

  const events: ChatStreamEvent[] = [];
  for await (const event of gateway.chat.stream({
    model: CHAT_ALIAS,
    messages: [{ role: "user", content: "hello" }],
  })) {
    events.push(event);
  }

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "error");
  if (events[0]?.type !== "error") {
    throw new Error("Expected error event");
  }
  assertGatewayErrorShape(events[0].error, {
    code: "RATE_LIMIT",
    message: "Too many requests",
    retryable: true,
    statusCode: 429,
    provider: "openrouter",
    requestId: "req_chat_stream",
  });
});

test("chat.complete surfaces normalized upstream errors from LangChain invocation", async () => {
  const gateway = createModelGateway({
    allowedModelAliases: [CHAT_ALIAS],
    providers: {
      openrouter: {
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test-key",
      },
    },
    modelRoutes: {
      [CHAT_ALIAS]: createPriorityRoute({
        provider: "openrouter",
        model: OPENROUTER_CHAT_MODEL,
      }),
    },
    langchainFactories: {
      createChatModel: () => ({
        async invoke() {
          throw new Error("upstream chat failed");
        },
        async stream() {
          return (async function* () {})();
        },
      }),
    },
  });

  await assert.rejects(
    () =>
      gateway.chat.complete({
        model: CHAT_ALIAS,
        messages: [{ role: "user", content: "hello" }],
      }),
    (error: unknown) => {
      const normalized = error as { code?: string; message?: string; retryable?: boolean };
      assert.equal(normalized.code, "UPSTREAM");
      assert.equal(normalized.message, "upstream chat failed");
      assert.equal(normalized.retryable, true);
      return true;
    },
  );
});
