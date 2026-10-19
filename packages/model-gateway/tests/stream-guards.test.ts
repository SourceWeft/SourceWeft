import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  isFailoverableCode,
  ModelGatewayError,
  normalizeGatewayError,
  surfacedErrorRankForCode,
} from "../src/errors";
import { resolveModelGatewayConfig } from "../src/config";
import {
  createAttemptGuard,
  DEFAULT_STREAM_GUARDS,
  guardFinishReason,
  REASONING_CHARS_LIMIT,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_MAX_DURATION_MS,
  TIMEOUT_ABORT_MESSAGE,
} from "../src/bridge/stream-guards";
import type { LangChainChatModelLike } from "../src/types";
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
  type FakeStreamChunk,
} from "./fake-openai-sse-server";
import {
  recordRun,
  type HarnessOptions,
} from "./stream-characterization-harness";

let server: FakeOpenAIServer;
before(async () => {
  server = await startFakeOpenAIServer({ kind: "hang" });
});
after(async () => {
  await server.close();
});

const ENTRIES = ["invoke", "stream"] as const;

/**
 * Every way the facade is driven: `model.stream`, `model.invoke` streaming
 * through `handleLLMNewToken`, and `model.invoke` streaming through
 * `handleChatModelStreamEvent` — the last is LangGraph v3's handler shape and
 * the agent runtime's real path; the guards must engage on all three.
 */
const VARIANTS = [
  { label: "invoke", entry: "invoke", handlerShape: "llm-new-token" },
  { label: "stream", entry: "stream", handlerShape: "llm-new-token" },
  {
    label: "invoke/v3",
    entry: "invoke",
    handlerShape: "chat-model-stream-events",
  },
] as const;

function run(options: Omit<HarnessOptions, "baseUrl">) {
  return recordRun({ baseUrl: server.url, ...options });
}

/** Chunk-level progress callbacks, whichever internal path delivered them. */
function progressEvents(
  result: Awaited<ReturnType<typeof run>>,
): Record<string, unknown>[] {
  return result.callbacks.filter(
    (event) =>
      event.event === "llm_new_token" ||
      (event.event === "chat_model_stream_event" &&
        (event.payload as { event: string }).event === "content-block-delta"),
  );
}

test("thresholds are exported constants and the resolved config defaults", () => {
  assert.equal(STREAM_IDLE_TIMEOUT_MS, 120_000);
  assert.equal(REASONING_CHARS_LIMIT, 200_000);
  assert.equal(STREAM_MAX_DURATION_MS, 30 * 60_000);
  assert.deepEqual(DEFAULT_STREAM_GUARDS, {
    idleTimeoutMs: 120_000,
    reasoningCharsLimit: 200_000,
    maxDurationMs: 1_800_000,
  });
  const base = { baseUrl: "http://x/v1", apiKey: "k" };
  const resolved = resolveModelGatewayConfig(base);
  assert.deepEqual(resolved.streamGuards, DEFAULT_STREAM_GUARDS);
  assert.deepEqual(
    resolveModelGatewayConfig({ ...base, streamGuards: { idleTimeoutMs: 5 } })
      .streamGuards,
    {
      idleTimeoutMs: 5,
      reasoningCharsLimit: 200_000,
      maxDurationMs: 1_800_000,
    },
  );
  assert.throws(
    () =>
      resolveModelGatewayConfig({
        ...base,
        streamGuards: { reasoningCharsLimit: 0 },
      }),
    (error: unknown) =>
      ModelGatewayError.isInstance(error) && error.code === "BAD_REQUEST",
  );
});

test("new codes: retryable, failover and surfacing rank", () => {
  const idle = new ModelGatewayError({
    code: "STREAM_IDLE_TIMEOUT",
    message: "x",
  });
  const budget = new ModelGatewayError({
    code: "REASONING_BUDGET_EXCEEDED",
    message: "x",
  });
  assert.equal(idle.retryable, true);
  assert.equal(budget.retryable, true);
  assert.equal(isFailoverableCode("STREAM_IDLE_TIMEOUT"), true);
  assert.equal(isFailoverableCode("REASONING_BUDGET_EXCEEDED"), false);
  const duration = new ModelGatewayError({
    code: "STREAM_DURATION_EXCEEDED",
    message: "x",
  });
  assert.equal(duration.retryable, true);
  assert.equal(isFailoverableCode("STREAM_DURATION_EXCEEDED"), false);
  assert.equal(
    surfacedErrorRankForCode("STREAM_DURATION_EXCEEDED"),
    surfacedErrorRankForCode("REASONING_BUDGET_EXCEEDED"),
  );
  assert.equal(
    guardFinishReason("STREAM_DURATION_EXCEEDED"),
    "stream_duration_exceeded",
  );
  assert.equal(
    surfacedErrorRankForCode("STREAM_IDLE_TIMEOUT"),
    surfacedErrorRankForCode("TIMEOUT"),
  );
  assert.ok(
    surfacedErrorRankForCode("REASONING_BUDGET_EXCEEDED") >
      surfacedErrorRankForCode("UPSTREAM"),
  );
  assert.equal(normalizeGatewayError(idle), idle);
  assert.equal(normalizeGatewayError(budget).code, "REASONING_BUDGET_EXCEEDED");
  assert.equal(guardFinishReason("STREAM_IDLE_TIMEOUT"), "stream_idle_timeout");
  assert.equal(
    guardFinishReason("REASONING_BUDGET_EXCEEDED"),
    "reasoning_budget_exceeded",
  );
  assert.equal(guardFinishReason("TIMEOUT"), undefined);
});

for (const { label, entry, handlerShape } of VARIANTS) {
  test(`${label}: a stream that goes silent after the first chunk ends with STREAM_IDLE_TIMEOUT`, async () => {
    server.setScenario({
      kind: "stream",
      chunks: [{ reasoning: "thinking" }],
      ending: "hang",
    });
    const result = await run({
      entry,
      handlerShape,
      timeoutMs: 5_000,
      thinking: true,
      signal: new AbortController().signal,
      config: { streamGuards: { idleTimeoutMs: 300 } },
    });
    assert.equal(result.error?.code, "STREAM_IDLE_TIMEOUT");
    assert.equal(result.error?.name, "ModelGatewayError");
    assert.ok(result.elapsedMs < 2_000, `took ${result.elapsedMs}ms`);
    assert.equal(progressEvents(result).length, 1);
    assert.deepEqual(
      result.observation.errors.map((e) => [e.errorCode, e.finishReason]),
      [["STREAM_IDLE_TIMEOUT", "stream_idle_timeout"]],
    );
    assert.equal(result.observation.ends.length, 0);
  });

  test(`${label}: a live stream longer than the attempt timeout is no longer cut`, async () => {
    const chunks: FakeStreamChunk[] = Array.from({ length: 6 }, (_, i) => ({
      content: String(i),
    }));
    chunks.push({ content: "", finishReason: "stop" });
    server.setScenario({ kind: "stream", chunkDelayMs: 150, chunks });
    const result = await run({
      entry,
      handlerShape,
      // Attempt budget (first token) is well below the ~1 s stream.
      timeoutMs: 400,
      signal: new AbortController().signal,
      config: { streamGuards: { idleTimeoutMs: 1_000 } },
    });
    assert.equal(result.error, undefined);
    assert.ok(result.elapsedMs >= 800, `took ${result.elapsedMs}ms`);
    // The v3 path aggregates content blocks; the others a string.
    const content = result.final?.content;
    assert.equal(
      Array.isArray(content)
        ? (content as Array<{ text?: string }>).map((b) => b.text).join("")
        : content,
      "012345",
    );
    assert.equal(result.observation.errors.length, 0);
    assert.equal(result.observation.ends.length, 1);
  });

  test(`${label}: cumulative reasoning beyond the budget ends with REASONING_BUDGET_EXCEEDED`, async () => {
    server.setScenario({
      kind: "stream",
      chunkDelayMs: 20,
      chunks: Array.from({ length: 10 }, () => ({ reasoning: "0123456789" })),
      ending: "hang",
    });
    const result = await run({
      entry,
      handlerShape,
      timeoutMs: 5_000,
      thinking: true,
      signal: new AbortController().signal,
      config: {
        streamGuards: { idleTimeoutMs: 5_000, reasoningCharsLimit: 35 },
      },
    });
    assert.equal(result.error?.code, "REASONING_BUDGET_EXCEEDED");
    assert.ok(result.elapsedMs < 2_000, `took ${result.elapsedMs}ms`);
    const tokens = progressEvents(result);
    assert.ok(
      tokens.length >= 4 && tokens.length <= 5,
      `${tokens.length} tokens`,
    );
    // The chunk that crossed the budget is not delivered to the consumer.
    if (entry === "stream") assert.equal(result.chunks?.length, 3);
    assert.deepEqual(
      result.observation.errors.map((e) => [e.errorCode, e.finishReason]),
      [["REASONING_BUDGET_EXCEEDED", "reasoning_budget_exceeded"]],
    );
    if (entry === "stream")
      assert.equal(
        result.observation.errors[0]?.output?.reasoning,
        "0123456789".repeat(4),
      );
  });

  test(`${label}: a slow but continuous stream is cut by the duration cap with STREAM_DURATION_EXCEEDED`, async () => {
    // The incident shape: a small reasoning delta every ~100 ms, forever.
    server.setScenario({
      kind: "stream",
      chunkDelayMs: 100,
      chunks: Array.from({ length: 200 }, () => ({ reasoning: "r" })),
      ending: "hang",
    });
    const result = await run({
      entry,
      handlerShape,
      timeoutMs: 5_000,
      thinking: true,
      signal: new AbortController().signal,
      config: {
        streamGuards: {
          idleTimeoutMs: 2_000,
          reasoningCharsLimit: 200_000,
          maxDurationMs: 600,
        },
      },
    });
    assert.equal(result.error?.code, "STREAM_DURATION_EXCEEDED");
    assert.equal(result.error?.name, "ModelGatewayError");
    assert.ok(
      result.elapsedMs >= 600 && result.elapsedMs < 2_000,
      `took ${result.elapsedMs}ms`,
    );
    const tokens = progressEvents(result);
    assert.ok(
      tokens.length >= 4 && tokens.length <= 8,
      `${tokens.length} tokens`,
    );
    assert.deepEqual(
      result.observation.errors.map((e) => [e.errorCode, e.finishReason]),
      [["STREAM_DURATION_EXCEEDED", "stream_duration_exceeded"]],
    );
    assert.equal(result.observation.ends.length, 0);
  });

  test(`${label}: no first token within the attempt timeout is still TIMEOUT`, async () => {
    server.setScenario({
      kind: "stream",
      firstTokenDelayMs: 2_000,
      chunks: [{ content: "late" }, { content: "", finishReason: "stop" }],
    });
    const result = await run({
      entry,
      handlerShape,
      timeoutMs: 300,
      signal: new AbortController().signal,
      config: { streamGuards: { idleTimeoutMs: 10_000 } },
    });
    assert.equal(result.error?.code, "TIMEOUT");
    assert.equal(result.error?.name, "TimeoutError");
    assert.equal(result.error?.message, TIMEOUT_ABORT_MESSAGE);
    assert.ok(result.elapsedMs < 1_500, `took ${result.elapsedMs}ms`);
    assert.deepEqual(
      result.observation.errors.map((e) => e.errorCode),
      ["TIMEOUT"],
    );
    // An abort is not a provider failure: no retry line for it.
    assert.deepEqual(
      result.warnings.filter((w) => w.message === "model-gateway.retry"),
      [],
    );
  });

  test(`${label}: a caller abort during the stream surfaces the caller's reason`, async () => {
    server.setScenario({
      kind: "stream",
      chunks: [{ content: "a" }],
      ending: "hang",
    });
    const controller = new AbortController();
    const reason = new Error("user stopped the run");
    setTimeout(() => controller.abort(reason), 200);
    const result = await run({
      entry,
      handlerShape,
      timeoutMs: 5_000,
      signal: controller.signal,
      config: { streamGuards: { idleTimeoutMs: 5_000 } },
    });
    assert.equal(result.error?.message, "user stopped the run");
    assert.notEqual(result.error?.code, "STREAM_IDLE_TIMEOUT");
    assert.ok(result.elapsedMs < 1_500, `took ${result.elapsedMs}ms`);
    assert.equal(result.observation.ends.length, 0);
  });
}

for (const { label, handlerShape } of VARIANTS.filter(
  (v) => v.entry === "invoke",
)) {
  test(`${label} with a CallbackManager (LangGraph's shape): the guard still sees every chunk`, async () => {
    server.setScenario({
      kind: "stream",
      chunks: [{ content: "a" }],
      ending: "hang",
    });
    const result = await run({
      entry: "invoke",
      handlerShape,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      callbacksAsManager: true,
      config: { streamGuards: { idleTimeoutMs: 300 } },
    });
    assert.equal(result.error?.code, "STREAM_IDLE_TIMEOUT");
    assert.ok(result.elapsedMs < 2_000, `took ${result.elapsedMs}ms`);
    assert.equal(progressEvents(result).length, 1);
    // The v3 shape never calls handleLLMNewToken; the guard must not depend on it.
    if (handlerShape === "chat-model-stream-events")
      assert.equal(
        result.callbacks.filter((e) => e.event === "llm_new_token").length,
        0,
      );
  });
}

test("retry log: every failed provider attempt is reported through the config logger", async () => {
  server.setScenario({
    kind: "status",
    status: 503,
    body: { error: { message: "unavailable" } },
  });
  const result = await run({
    entry: "invoke",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    config: { maxRetries: 1 },
  });
  assert.equal(result.error?.code, "UPSTREAM");
  const retries = result.warnings.filter(
    (w) => w.message === "model-gateway.retry",
  );
  assert.equal(retries.length, 2);
  assert.deepEqual(
    retries.map((w) => {
      const { elapsedMs, ...rest } = w.data ?? {};
      assert.equal(typeof elapsedMs, "number");
      return rest;
    }),
    [1, 2].map((attempt) => ({
      attempt,
      maxRetries: 1,
      willRetry: attempt === 1,
      errorCode: "UPSTREAM",
      provider: "fake",
      providerModel: "fake-model",
    })),
  );
});

test("retry log is silent without a logger", async () => {
  server.setScenario({ kind: "status", status: 503 });
  const result = await run({
    entry: "stream",
    timeoutMs: 5_000,
    config: { logger: undefined },
  });
  assert.equal(result.error?.code, "UPSTREAM");
});

/**
 * Providers that attach `usage_metadata` to chunks before the stream ends
 * (OpenAI-style providers only send usage last, so the HTTP fake cannot show
 * this). The guard carries the last usage seen into the interruption's
 * generation record, on both paths.
 */
class ScriptedChatModel extends BaseChatModel {
  constructor(
    private readonly script: AIMessageChunk[],
    private readonly hangAfter: boolean,
  ) {
    super({});
  }

  _llmType() {
    return "scripted";
  }

  async _generate(): Promise<never> {
    throw new Error("scripted model only streams");
  }

  async *_streamResponseChunks(
    _messages: unknown,
    options: { signal?: AbortSignal },
    runManager?: CallbackManagerForLLMRun,
  ) {
    for (const message of this.script) {
      const chunk = new ChatGenerationChunk({
        message,
        text: typeof message.content === "string" ? message.content : "",
      });
      yield chunk;
      await runManager?.handleLLMNewToken(
        chunk.text,
        { prompt: 0, completion: 0 },
        undefined,
        undefined,
        undefined,
        { chunk },
      );
    }
    if (this.hangAfter) {
      await new Promise<never>((_, reject) => {
        const signal = options.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }
  }
}

for (const entry of ENTRIES) {
  for (const [guard, code, finishReason] of [
    ["idle", "STREAM_IDLE_TIMEOUT", "stream_idle_timeout"],
    ["duration", "STREAM_DURATION_EXCEEDED", "stream_duration_exceeded"],
  ] as const) {
    test(`${entry}: usage seen before a ${guard} interruption is recorded on the generation error`, async () => {
      const result = await run({
        entry,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        config: {
          streamGuards:
            guard === "idle"
              ? { idleTimeoutMs: 200 }
              : { idleTimeoutMs: 5_000, maxDurationMs: 200 },
          langchainFactories: {
            createChatModel: () =>
              new ScriptedChatModel(
                [
                  new AIMessageChunk({
                    content: "partial",
                    usage_metadata: {
                      input_tokens: 5,
                      output_tokens: 2,
                      total_tokens: 7,
                    },
                  }),
                ],
                true,
              ) as unknown as LangChainChatModelLike,
          },
        },
      });
      assert.equal(result.error?.code, code);
      assert.equal(result.observation.errors.length, 1);
      const [error] = result.observation.errors;
      assert.equal(error?.finishReason, finishReason);
      assert.deepEqual(JSON.parse(JSON.stringify(error?.usage)), {
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      });
    });
  }
}

test("attempt guard: first-token timer is disarmed by the first chunk, idle timer re-arms per chunk", async () => {
  const guard = createAttemptGuard({
    firstTokenTimeoutMs: 100,
    thresholds: {
      idleTimeoutMs: 150,
      reasoningCharsLimit: 1_000,
      maxDurationMs: 10_000,
    },
    target: { provider: "p", providerModel: "m" },
  });
  await new Promise((r) => setTimeout(r, 50));
  guard.observeChunk(new AIMessageChunk({ content: "a" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(guard.signal.aborted, false, "first-token timer must be off");
  guard.observeChunk(new AIMessageChunk({ content: "b" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(guard.signal.aborted, false, "idle timer re-armed by chunk");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(guard.signal.aborted, true);
  const reason = guard.signal.reason as ModelGatewayError;
  assert.equal(reason.code, "STREAM_IDLE_TIMEOUT");
  assert.equal(reason.provider, "p");
  assert.equal((reason.metadata?.streamGuard as { chunks: number }).chunks, 2);
  guard.settle();
});

test("attempt guard: the duration cap is armed at the first chunk and not re-armed by chunks", async () => {
  const guard = createAttemptGuard({
    firstTokenTimeoutMs: 1_000,
    thresholds: {
      idleTimeoutMs: 1_000,
      reasoningCharsLimit: 1_000,
      maxDurationMs: 150,
    },
    target: { provider: "p", providerModel: "m" },
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(guard.signal.aborted, false, "not armed before the first chunk");
  guard.observeChunk(new AIMessageChunk({ content: "a" }));
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    guard.observeChunk(new AIMessageChunk({ content: "b" }));
  }
  assert.equal(guard.signal.aborted, true);
  assert.equal(
    (guard.signal.reason as ModelGatewayError).code,
    "STREAM_DURATION_EXCEEDED",
  );
  guard.settle();
});

test("attempt guard: settle stops every timer", async () => {
  const guard = createAttemptGuard({
    firstTokenTimeoutMs: 50,
    thresholds: {
      idleTimeoutMs: 50,
      reasoningCharsLimit: 1_000,
      maxDurationMs: 50,
    },
    target: { provider: "p", providerModel: "m" },
  });
  guard.settle();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(guard.signal.aborted, false);
});
