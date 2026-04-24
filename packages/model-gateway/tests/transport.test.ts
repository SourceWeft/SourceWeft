import assert from "node:assert/strict";
import test from "node:test";
import { ModelGatewayError, createModelGateway } from "../src/index";
import { resolveModelGatewayConfig } from "../src/config";
import { requestJson } from "../src/transport/http";
import { parseSSE } from "../src/transport/sse";
import type { ObserveSpan } from "../src/types";
import { createJsonResponse } from "./helpers";

test("requestJson retries retryable errors and emits a success span", async () => {
  const spans: ObserveSpan[] = [];
  let attempts = 0;
  const originalRandom = Math.random;
  Math.random = () => 0;

  try {
    const config = resolveModelGatewayConfig({
      baseUrl: "https://gateway.example.com",
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) {
          return createJsonResponse(
            {
              error: {
                message: "Slow down",
              },
            },
            {
              status: 429,
            },
          );
        }

        return createJsonResponse({ ok: true });
      },
      observeSink: {
        onSpan(span) {
          spans.push(span);
        },
      },
    });

    const result = await requestJson<Record<string, unknown>>(config, {
      path: "/health",
      options: {
        traceId: "trace_retry",
        maxRetries: 1,
      },
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 2);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]?.status, "ok");
    assert.equal(spans[0]?.traceId, "trace_retry");
    assert.equal(spans[0]?.name, "http:/health");

    const attributes = spans[0]?.attributes as Record<string, unknown> | undefined;
    assert.equal(attributes?.attempt, 1);
    assert.equal(attributes?.url, "https://gateway.example.com/health");
    assert.equal(attributes?.method, "POST");
    assert.equal(typeof attributes?.latencyMs, "number");
  } finally {
    Math.random = originalRandom;
  }
});

test("requestJson converts aborts into timeout errors and emits an error span", async () => {
  const spans: ObserveSpan[] = [];

  const config = resolveModelGatewayConfig({
    baseUrl: "https://gateway.example.com",
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const timeoutError = Object.assign(new Error("Timed out"), {
          name: "AbortError",
        });

        if (!signal || signal.aborted) {
          reject(timeoutError);
          return;
        }

        signal.addEventListener("abort", () => reject(timeoutError), {
          once: true,
        });
    }),
    observeSink: {
      onSpan(span) {
        spans.push(span);
      },
    },
  });

  await assert.rejects(
    () =>
      requestJson(config, {
        path: "/timeout",
        options: {
          timeoutMs: 1,
          maxRetries: 0,
          traceId: "trace_timeout",
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "TIMEOUT");
      return true;
    },
  );

  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.status, "error");
  assert.equal(spans[0]?.traceId, "trace_timeout");
  assert.equal(spans[0]?.errorCode, "TIMEOUT");
});

test("chat.stream emits a single error event for LangChain provider failures", async () => {
  const gateway = createModelGateway({
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
      createChatModel: () => ({
        async invoke() {
          return {};
        },
        async stream() {
          throw new ModelGatewayError({
            code: "RATE_LIMIT",
            message: "Too many requests",
            retryable: true,
            statusCode: 429,
            provider: "openai",
            requestId: "req_stream",
          });
        },
      }),
    },
  });

  const events = [] as unknown[];
  for await (const event of gateway.chat.stream({
    model: "chat-default",
    messages: [{ role: "user", content: "hello" }],
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      type: "error",
      error: {
        code: "RATE_LIMIT",
        message: "Too many requests",
        retryable: true,
        statusCode: 429,
        provider: "openai",
        requestId: "req_stream",
      },
    },
  ]);
});

test("parseSSE rejects responses without a body", async () => {
  const iterator = parseSSE(new Response(null, { status: 200 }));

  await assert.rejects(
    () => iterator.next(),
    (error: unknown) => {
      assert.ok(error instanceof ModelGatewayError);
      assert.equal(error.code, "UPSTREAM");
      assert.match(error.message, /body is missing/);
      return true;
    },
  );
});
