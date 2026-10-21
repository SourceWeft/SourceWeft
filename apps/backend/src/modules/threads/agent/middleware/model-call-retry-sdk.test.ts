import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { afterEach, beforeEach, test, vi } from "vitest";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import { config } from "../../../../shared/config";
import { logger } from "../../../../shared/logger";
import { ModelGatewayError } from "../../../../shared/model-gateway/errors";
import {
  isModelUpstreamContentErrorCode,
  MODEL_OUTPUT_TRUNCATED_CODE,
  MODEL_REASONING_BUDGET_EXCEEDED_CODE,
  MODEL_STREAM_DURATION_EXCEEDED_CODE,
  toContentError,
} from "../../../content/model-gateway-error";
import { createSourceWeftAgentMiddlewareStack } from "./index";
import {
  isToolCallTruncatedByOutputLimit,
  MODEL_CALL_FAILED_EVENT,
  MODEL_CALL_RETRY_EVENT,
} from "./model-call-observability";
import { selectAgentRunProgress } from "./step-budget";
import { unwrapCustomEvent } from "../turn/v3-protocol";

// Same storage boundary as step-budget-full-stack.test.ts: the production
// middleware stack (retry included) stays real; only the checkpointer is
// in-memory. Retries sleep for LangChain's real backoff (~1 s, then ~2 s).
vi.mock("../../../../shared/chat-checkpointer", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getChatCheckpointer: async () => saver };
});

type Agent = {
  invoke(input: unknown, options?: unknown): Promise<Record<string, unknown>>;
};

const timeout = () =>
  new ModelGatewayError({
    code: "TIMEOUT",
    message: "LLM request timed out",
    provider: "deepseek",
  });

const reasoningBudgetExceeded = () =>
  new ModelGatewayError({
    code: "REASONING_BUDGET_EXCEEDED",
    message: "Reasoning exceeded the per-call budget",
    retryable: true,
    provider: "deepseek",
  });

const streamDurationExceeded = () =>
  new ModelGatewayError({
    code: "STREAM_DURATION_EXCEEDED",
    message: "Stream ran longer than 1800000 ms",
    retryable: true,
    provider: "deepseek",
  });

/** The gateway facade's verdict on a `length` finish mid tool call (#338). */
const outputTruncated = () =>
  new ModelGatewayError({
    code: "OUTPUT_TRUNCATED",
    message: "finish_reason=length while emitting tool call probe",
    retryable: true,
    provider: "deepseek",
  });

/**
 * What a `length`-cut tool call looks like once LangChain has aggregated the
 * chunks and the gateway facade has NOT intercepted it: a valid-looking
 * `tool_calls` entry (partial-JSON repair) whose `query` is the truncated
 * fragment, under `finish_reason: "length"`. `finishReasonKey` picks the
 * OpenAI-compatible or the v3 spelling of the finish reason.
 */
const truncatedToolCallMessage = (
  finishReasonKey: "finish_reason" | "finishReason" = "finish_reason",
) =>
  new AIMessage({
    content: "",
    tool_calls: [{ id: "probe-cut", name: "probe", args: { query: "al" } }],
    response_metadata: {
      [finishReasonKey]: "length",
      model_provider: "deepseek",
    },
  });

const badRequest = () =>
  new ModelGatewayError({
    code: "BAD_REQUEST",
    message: "invalid request",
    provider: "deepseek",
  });

const CONTEXT = {
  userMessageId: "retry-u",
  threadId: "thread-retry",
  runId: "run-retry",
};

async function buildAgent(model: ScriptedChatModel, tools: unknown[] = []) {
  const backend = new StateBackend();
  const middleware = await createSourceWeftAgentMiddlewareStack({
    backend,
    model,
    modelAlias: "chat-default",
    filesystemMounts: [],
    toolObservabilityContext: CONTEXT,
  });
  return createDeepAgent({
    model,
    tools: tools as never,
    backend,
    middleware,
    checkpointer: new MemorySaver(),
  }) as unknown as Agent;
}

const spyWarn = () =>
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
let warn: ReturnType<typeof spyWarn>;
const previous = {
  maxSteps: config.chat.agent.maxSteps,
  closingSteps: config.chat.agent.closingSteps,
};

beforeEach(() => {
  warn = spyWarn();
  config.chat.agent.maxSteps = 4;
  config.chat.agent.closingSteps = 2;
});
afterEach(() => {
  warn.mockRestore();
  Object.assign(config.chat.agent, previous);
});

function logged(event: string) {
  return warn.mock.calls
    .filter((call) => call[0] === event)
    .map((call) => call[1] as Record<string, unknown>);
}

test("a timed-out attempt is retried inside the same step: run completes, steps advance by one, one retry log", async () => {
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      if (++calls === 1) throw timeout();
      return new AIMessage("Recovered on the second attempt.");
    }),
  );
  const result = await agent.invoke(
    { messages: [new HumanMessage("Answer.")] },
    { configurable: { thread_id: "retry-once" } },
  );

  assert.equal(calls, 2);
  const progress = selectAgentRunProgress(result, {
    userMessageId: CONTEXT.userMessageId,
  });
  assert.equal(progress?.steps, 1);
  assert.equal(progress?.normalSteps, 1);
  const final = (result.messages as AIMessage[]).at(-1);
  assert.equal(final?.content, "Recovered on the second attempt.");

  const retries = logged(MODEL_CALL_RETRY_EVENT);
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.attempt, 1);
  assert.equal(retries[0]?.maxAttempts, 3);
  assert.equal(retries[0]?.errorCode, "MODEL_TIMEOUT");
  assert.equal(retries[0]?.gatewayCode, "TIMEOUT");
  assert.equal(retries[0]?.threadId, CONTEXT.threadId);
  assert.equal(retries[0]?.runId, CONTEXT.runId);
  assert.equal(typeof retries[0]?.elapsedMs, "number");
  assert.equal(logged(MODEL_CALL_FAILED_EVENT).length, 0);
}, 20_000);

test("every attempt announces itself on the custom stream, and a granted retry is announced before the next attempt", async () => {
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      if (++calls === 1) throw timeout();
      return new AIMessage("Recovered on the second attempt.");
    }),
  );
  const stream = (await (
    agent as unknown as {
      streamEvents(input: unknown, options: unknown): Promise<unknown>;
    }
  ).streamEvents(
    { messages: [new HumanMessage("Answer.")] },
    { version: "v3", configurable: { thread_id: "retry-custom-stream" } },
  )) as AsyncIterable<{ method: string; params?: { data?: unknown } }>;
  const custom: unknown[] = [];
  for await (const event of stream) {
    if (event.method !== "custom") continue;
    const payload = unwrapCustomEvent(event.params?.data);
    if (String((payload as { type?: string }).type).startsWith("model-call-")) {
      custom.push(payload);
    }
  }

  assert.equal(calls, 2);
  assert.deepEqual(custom, [
    { type: "model-call-begin", attempt: 1 },
    { type: "model-call-retry", attempt: 2, errorCode: "MODEL_TIMEOUT" },
    { type: "model-call-begin", attempt: 2 },
  ]);
}, 20_000);

test("a non-retryable failure announces its attempt but no retry", async () => {
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      throw badRequest();
    }),
  );
  const stream = (await (
    agent as unknown as {
      streamEvents(input: unknown, options: unknown): Promise<unknown>;
    }
  ).streamEvents(
    { messages: [new HumanMessage("Answer.")] },
    { version: "v3", configurable: { thread_id: "retry-custom-stream-fail" } },
  )) as AsyncIterable<{ method: string; params?: { data?: unknown } }> & {
    output: Promise<unknown>;
  };
  const custom: unknown[] = [];
  let caught: unknown;
  try {
    for await (const event of stream) {
      if (event.method !== "custom") continue;
      const payload = unwrapCustomEvent(event.params?.data);
      if (
        String((payload as { type?: string }).type).startsWith("model-call-")
      ) {
        custom.push(payload);
      }
    }
    await stream.output;
  } catch (error) {
    caught = error;
  }

  assert.equal(toContentError(caught).code, "MODEL_REQUEST_INVALID");
  assert.deepEqual(custom, [{ type: "model-call-begin", attempt: 1 }]);
  assert.equal(logged(MODEL_CALL_RETRY_EVENT).length, 0);
});

test("retries never charge the step budget: one failure per decision across a tool round-trip still counts two steps", async () => {
  let calls = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "verified";
    },
    { name: "probe", description: "verify", schema: z.object({}) },
  );
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      // Attempts 1 and 3 time out; 2 decides a tool call; 4 answers.
      if (calls === 1 || calls === 3) throw timeout();
      return calls === 2
        ? new AIMessage({
            content: "",
            tool_calls: [{ id: "probe-1", name: "probe", args: {} }],
          })
        : new AIMessage("Done after verifying.");
    }),
    [probe],
  );
  const result = await agent.invoke(
    { messages: [new HumanMessage("Verify then answer.")] },
    { configurable: { thread_id: "retry-two-decisions" } },
  );

  assert.equal(calls, 4);
  assert.equal(effects, 1);
  assert.equal(
    selectAgentRunProgress(result, { userMessageId: CONTEXT.userMessageId })
      ?.steps,
    2,
  );
  assert.deepEqual(
    logged(MODEL_CALL_RETRY_EVENT).map((entry) => entry.attempt),
    [1, 1],
  );
}, 20_000);

test("three consecutive timeouts fail the run with MODEL_TIMEOUT after two retries", async () => {
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      throw timeout();
    }),
  );
  let caught: unknown;
  try {
    await agent.invoke(
      { messages: [new HumanMessage("Answer.")] },
      { configurable: { thread_id: "retry-exhausted" } },
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, "expected the run to fail");
  assert.equal(toContentError(caught).code, "MODEL_TIMEOUT");
  assert.equal(calls, 3);
  assert.deepEqual(
    logged(MODEL_CALL_RETRY_EVENT).map((entry) => entry.attempt),
    [1, 2],
  );
  const failed = logged(MODEL_CALL_FAILED_EVENT);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.attempt, 3);
  assert.equal(failed[0]?.reason, "exhausted");
  assert.equal(failed[0]?.errorCode, "MODEL_TIMEOUT");
}, 20_000);

test("a reasoning-budget overrun is retried once, never twice", async () => {
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      throw reasoningBudgetExceeded();
    }),
  );
  let caught: unknown;
  try {
    await agent.invoke(
      { messages: [new HumanMessage("Answer.")] },
      { configurable: { thread_id: "retry-reasoning-budget" } },
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, "expected the run to fail");
  assert.equal(
    toContentError(caught).code,
    MODEL_REASONING_BUDGET_EXCEEDED_CODE,
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    logged(MODEL_CALL_RETRY_EVENT).map((entry) => [
      entry.attempt,
      entry.errorCode,
    ]),
    [[1, MODEL_REASONING_BUDGET_EXCEEDED_CODE]],
  );
  const failed = logged(MODEL_CALL_FAILED_EVENT);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.attempt, 2);
  assert.equal(failed[0]?.reason, "code_budget");
}, 20_000);

test("a stream-duration overrun is retried once, never twice", async () => {
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      throw streamDurationExceeded();
    }),
  );
  let caught: unknown;
  try {
    await agent.invoke(
      { messages: [new HumanMessage("Answer.")] },
      { configurable: { thread_id: "retry-stream-duration" } },
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, "expected the run to fail");
  assert.equal(
    toContentError(caught).code,
    MODEL_STREAM_DURATION_EXCEEDED_CODE,
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    logged(MODEL_CALL_RETRY_EVENT).map((entry) => [
      entry.attempt,
      entry.errorCode,
      entry.gatewayCode,
    ]),
    [[1, MODEL_STREAM_DURATION_EXCEEDED_CODE, "STREAM_DURATION_EXCEEDED"]],
  );
  const failed = logged(MODEL_CALL_FAILED_EVENT);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.attempt, 2);
  assert.equal(failed[0]?.reason, "code_budget");
}, 20_000);

test("a reasoning-budget overrun followed by a timeout still gets the timeout's own retry", async () => {
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      if (calls === 1) throw reasoningBudgetExceeded();
      if (calls === 2) throw timeout();
      return new AIMessage("Third attempt answered.");
    }),
  );
  const result = await agent.invoke(
    { messages: [new HumanMessage("Answer.")] },
    { configurable: { thread_id: "retry-mixed-codes" } },
  );
  assert.equal(calls, 3);
  assert.equal(
    (result.messages as AIMessage[]).at(-1)?.content,
    "Third attempt answered.",
  );
  assert.deepEqual(
    logged(MODEL_CALL_RETRY_EVENT).map((entry) => entry.errorCode),
    [MODEL_REASONING_BUDGET_EXCEEDED_CODE, "MODEL_TIMEOUT"],
  );
}, 20_000);

test("a non-retryable gateway error is surfaced immediately without a retry", async () => {
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      throw badRequest();
    }),
  );
  let caught: unknown;
  try {
    await agent.invoke(
      { messages: [new HumanMessage("Answer.")] },
      { configurable: { thread_id: "retry-non-retryable" } },
    );
  } catch (error) {
    caught = error;
  }
  assert.equal(toContentError(caught).code, "MODEL_REQUEST_INVALID");
  assert.equal(calls, 1);
  assert.equal(logged(MODEL_CALL_RETRY_EVENT).length, 0);
  const failed = logged(MODEL_CALL_FAILED_EVENT);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.reason, "not_retryable");
  assert.equal(failed[0]?.attempt, 1);
});

/** A tool that records every invocation's args so a truncated call is visible. */
function recordingProbe() {
  const invocations: unknown[] = [];
  const probe = tool(
    async (input: { query: string }) => {
      invocations.push(input);
      return `verified ${input.query}`;
    },
    {
      name: "probe",
      description: "verify",
      schema: z.object({ query: z.string() }),
    },
  );
  return { probe, invocations };
}

async function invokeCatching(agent: Agent, thread: string) {
  try {
    return {
      result: await agent.invoke(
        { messages: [new HumanMessage("Verify alpha then answer.")] },
        { configurable: { thread_id: thread } },
      ),
      caught: undefined,
    };
  } catch (error) {
    return { result: undefined, caught: error };
  }
}

test("a gateway OUTPUT_TRUNCATED attempt is retried once inside the step and the truncated call never executes", async () => {
  const { probe, invocations } = recordingProbe();
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      if (calls === 1) throw outputTruncated();
      return calls === 2
        ? new AIMessage({
            content: "",
            tool_calls: [
              { id: "probe-full", name: "probe", args: { query: "alpha" } },
            ],
          })
        : new AIMessage("Done after verifying alpha.");
    }),
    [probe],
  );
  const result = await agent.invoke(
    { messages: [new HumanMessage("Verify alpha then answer.")] },
    { configurable: { thread_id: "retry-truncated-gateway" } },
  );

  assert.equal(calls, 3);
  assert.deepEqual(invocations, [{ query: "alpha" }]);
  assert.equal(
    (result.messages as AIMessage[]).at(-1)?.content,
    "Done after verifying alpha.",
  );
  assert.equal(
    selectAgentRunProgress(result, { userMessageId: CONTEXT.userMessageId })
      ?.steps,
    2,
  );
  const retries = logged(MODEL_CALL_RETRY_EVENT);
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.attempt, 1);
  assert.equal(retries[0]?.errorCode, MODEL_OUTPUT_TRUNCATED_CODE);
  assert.equal(retries[0]?.gatewayCode, "OUTPUT_TRUNCATED");
  assert.equal(logged(MODEL_CALL_FAILED_EVENT).length, 0);
}, 20_000);

for (const finishReasonKey of ["finish_reason", "finishReason"] as const) {
  test(`backstop: a \`${finishReasonKey}: length\` response carrying tool calls is retried instead of executed`, async () => {
    const { probe, invocations } = recordingProbe();
    let calls = 0;
    const agent = await buildAgent(
      new ScriptedChatModel(() => {
        calls++;
        if (calls === 1) return truncatedToolCallMessage(finishReasonKey);
        return calls === 2
          ? new AIMessage({
              content: "",
              tool_calls: [
                { id: "probe-full", name: "probe", args: { query: "alpha" } },
              ],
            })
          : new AIMessage("Done after verifying alpha.");
      }),
      [probe],
    );
    const result = await agent.invoke(
      { messages: [new HumanMessage("Verify alpha then answer.")] },
      {
        configurable: {
          thread_id: `retry-truncated-backstop-${finishReasonKey}`,
        },
      },
    );

    assert.equal(calls, 3);
    // The truncated `{ query: "al" }` never reached the tool.
    assert.deepEqual(invocations, [{ query: "alpha" }]);
    assert.equal(
      (result.messages as AIMessage[]).at(-1)?.content,
      "Done after verifying alpha.",
    );
    const messages = result.messages as AIMessage[];
    assert.ok(
      !messages.some((message) =>
        (message.tool_calls ?? []).some((call) => call.id === "probe-cut"),
      ),
      "the truncated decision must not be persisted",
    );
    assert.equal(
      selectAgentRunProgress(result, { userMessageId: CONTEXT.userMessageId })
        ?.steps,
      2,
    );
    const retries = logged(MODEL_CALL_RETRY_EVENT);
    assert.equal(retries.length, 1);
    assert.equal(retries[0]?.attempt, 1);
    assert.equal(retries[0]?.errorCode, MODEL_OUTPUT_TRUNCATED_CODE);
    assert.equal(retries[0]?.gatewayCode, "OUTPUT_TRUNCATED");
    assert.equal(retries[0]?.errorName, "ContentError");
    assert.equal(logged(MODEL_CALL_FAILED_EVENT).length, 0);
  }, 20_000);
}

test("two truncated attempts fail the run with MODEL_OUTPUT_TRUNCATED after one retry, with no tool executed", async () => {
  const { probe, invocations } = recordingProbe();
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      return truncatedToolCallMessage();
    }),
    [probe],
  );
  const { caught } = await invokeCatching(agent, "retry-truncated-twice");

  assert.ok(caught, "expected the run to fail");
  const error = toContentError(caught);
  assert.equal(error.code, MODEL_OUTPUT_TRUNCATED_CODE);
  assert.equal(error.code, "MODEL_OUTPUT_TRUNCATED");
  assert.equal(calls, 2);
  assert.deepEqual(invocations, []);
  assert.deepEqual(
    logged(MODEL_CALL_RETRY_EVENT).map((entry) => [
      entry.attempt,
      entry.errorCode,
      entry.gatewayCode,
    ]),
    [[1, MODEL_OUTPUT_TRUNCATED_CODE, "OUTPUT_TRUNCATED"]],
  );
  const failed = logged(MODEL_CALL_FAILED_EVENT);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.attempt, 2);
  assert.equal(failed[0]?.reason, "code_budget");
  // The durable service keeps the sandbox lease for this code (#324).
  assert.equal(isModelUpstreamContentErrorCode(error.code), true);
}, 20_000);

test("a gateway OUTPUT_TRUNCATED followed by a backstop-caught truncation shares the one-retry budget", async () => {
  const { probe, invocations } = recordingProbe();
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      if (calls === 1) throw outputTruncated();
      return truncatedToolCallMessage();
    }),
    [probe],
  );
  const { caught } = await invokeCatching(agent, "retry-truncated-mixed");

  assert.equal(toContentError(caught).code, MODEL_OUTPUT_TRUNCATED_CODE);
  assert.equal(calls, 2);
  assert.deepEqual(invocations, []);
  assert.equal(logged(MODEL_CALL_FAILED_EVENT)[0]?.reason, "code_budget");
}, 20_000);

test("a length-cut plain-text answer without tool calls completes normally", async () => {
  const { probe, invocations } = recordingProbe();
  let calls = 0;
  const agent = await buildAgent(
    new ScriptedChatModel(() => {
      calls++;
      return new AIMessage({
        content: "The answer, cut short by the output limit",
        response_metadata: { finish_reason: "length" },
      });
    }),
    [probe],
  );
  const result = await agent.invoke(
    { messages: [new HumanMessage("Answer.")] },
    { configurable: { thread_id: "length-plain-text" } },
  );

  assert.equal(calls, 1);
  assert.deepEqual(invocations, []);
  assert.equal(
    (result.messages as AIMessage[]).at(-1)?.content,
    "The answer, cut short by the output limit",
  );
  assert.equal(logged(MODEL_CALL_RETRY_EVENT).length, 0);
  assert.equal(logged(MODEL_CALL_FAILED_EVENT).length, 0);
});

test("the truncation predicate reads both finish-reason spellings and every tool-call field", () => {
  const length = (fields: Record<string, unknown>) => ({
    response_metadata: { finish_reason: "length" },
    ...fields,
  });
  assert.equal(isToolCallTruncatedByOutputLimit(null), false);
  assert.equal(isToolCallTruncatedByOutputLimit(length({})), false);
  assert.equal(
    isToolCallTruncatedByOutputLimit(length({ tool_calls: [], content: "x" })),
    false,
  );
  assert.equal(
    isToolCallTruncatedByOutputLimit(length({ tool_calls: [{ name: "w" }] })),
    true,
  );
  assert.equal(
    isToolCallTruncatedByOutputLimit(
      length({ tool_calls: [], tool_call_chunks: [{ args: '{"a' }] }),
    ),
    true,
  );
  assert.equal(
    isToolCallTruncatedByOutputLimit(
      length({ invalid_tool_calls: [{ name: "w", args: '{"a' }] }),
    ),
    true,
  );
  assert.equal(
    isToolCallTruncatedByOutputLimit({
      response_metadata: { finishReason: "length" },
      tool_calls: [{ name: "w" }],
    }),
    true,
  );
  // Core's v1 assembly leaves an unparseable call as a content block only.
  assert.equal(
    isToolCallTruncatedByOutputLimit(
      length({
        tool_calls: [],
        invalid_tool_calls: [],
        content: [
          { type: "text", text: "" },
          { type: "invalid_tool_call", name: "w", args: '{"a', error: "x" },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    isToolCallTruncatedByOutputLimit(
      length({ tool_calls: [], content: [{ type: "text", text: "cut sho" }] }),
    ),
    false,
  );
  for (const finish of ["stop", "tool_calls", undefined]) {
    assert.equal(
      isToolCallTruncatedByOutputLimit({
        response_metadata: { finish_reason: finish },
        tool_calls: [{ name: "w" }],
      }),
      false,
    );
  }
});
