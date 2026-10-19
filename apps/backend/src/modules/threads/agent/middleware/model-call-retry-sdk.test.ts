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
  MODEL_REASONING_BUDGET_EXCEEDED_CODE,
  MODEL_STREAM_DURATION_EXCEEDED_CODE,
  toContentError,
} from "../../../content/model-gateway-error";
import { createSourceWeftAgentMiddlewareStack } from "./index";
import {
  MODEL_CALL_FAILED_EVENT,
  MODEL_CALL_RETRY_EVENT,
} from "./model-call-observability";
import { selectAgentRunProgress } from "./step-budget";

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
