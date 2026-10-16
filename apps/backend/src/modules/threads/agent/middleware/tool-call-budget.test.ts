import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver, interrupt } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { ToolCallLimitExceededError, toolCallLimitMiddleware } from "langchain";
import { test } from "vitest";
import { z } from "zod";
import { config } from "../../../../shared/config";
import { ScriptedChatModel } from "../../../../test/chat-model";
import { createSourceWeftToolCallCountChannelsMiddleware } from "./tool-call-count-channels";
import {
  AGENT_TOOL_BUDGET_EXCEEDED,
  createSourceWeftGlobalToolCallLimitMiddleware,
  toAgentToolBudgetContentError,
} from "./tool-call-budget";

type TestOptions = { configurable: { thread_id: string } };
type BudgetTestAgent = {
  invoke(
    input: { messages: BaseMessage[] } | Command,
    options?: TestOptions,
  ): Promise<{ messages: BaseMessage[] }>;
  getState(options: TestOptions): Promise<{
    values: {
      threadToolCallCount: Record<string, number>;
      runToolCallCount: Record<string, number>;
      sourceweftToolBudgetTurnId?: string | null;
    };
    tasks: Array<{ interrupts?: unknown[] }>;
  }>;
  updateState(
    options: TestOptions,
    update: Record<string, unknown>,
  ): Promise<unknown>;
};

// The runtime initializes defaulted count channels itself; the SDK's inferred
// invocation type loses those defaults at the zod v3/v4 bridge. Do not seed {}
// into every invocation just to satisfy that type: it would erase the very
// checkpointed budgets this integration verifies.
function createBudgetTestAgent(
  input: Parameters<typeof createDeepAgent>[0],
): BudgetTestAgent {
  return createDeepAgent(input) as unknown as BudgetTestAgent;
}

function limiter(
  runLimit: number,
  threadLimit: number,
  userMessageId: string | null = "test-user",
) {
  const previous = { ...config.chat.agent };
  try {
    config.chat.agent.toolCallRunLimit = runLimit;
    config.chat.agent.toolCallThreadLimit = threadLimit;
    return createSourceWeftGlobalToolCallLimitMiddleware({ userMessageId });
  } finally {
    Object.assign(config.chat.agent, previous);
  }
}

const call = (id: string, name = "budget_probe") => ({ id, name, args: {} });
function expectBudget(error: unknown) {
  const mapped = toAgentToolBudgetContentError(error);
  assert.equal(mapped?.code, AGENT_TOOL_BUDGET_EXCEEDED);
  return true;
}

test("only typed SDK budget errors and their wrapped causes get safe non-retryable classification", () => {
  const source = new ToolCallLimitExceededError(
    3,
    2,
    2,
    9,
    "private-tool-secret",
  );
  const cycle: { cause?: unknown; error?: unknown } = {};
  cycle.cause = cycle;
  cycle.error = source;
  for (const error of [
    source,
    new Error("private-wrapper", { cause: source }),
    { error: source },
    cycle,
  ]) {
    const mapped = toAgentToolBudgetContentError(error);
    assert.equal(mapped?.statusCode, 409);
    assert.equal(mapped?.code, AGENT_TOOL_BUDGET_EXCEEDED);
    assert.deepEqual(mapped?.details, { scope: "thread", retryable: false });
    assert.equal(mapped?.recoverable, false);
    assert.doesNotMatch(mapped?.message ?? "", /private|secret/);
  }
  for (const error of [
    new Error("Tool call limit exceeded"),
    { name: "ToolCallLimitExceededError", threadCount: 300 },
    new Error("ordinary execute failure"),
  ]) {
    assert.equal(toAgentToolBudgetContentError(error), null);
  }
});

test("real graph counts accumulate across checkpointed turns and thread exhaustion executes no blocked tool", async () => {
  let executions = 0;
  let ids = 0;
  const execute = tool(
    async () => {
      executions++;
      return "saved";
    },
    {
      name: "budget_probe",
      description: "Track execution",
      schema: z.object({}),
    },
  );
  const model = new ScriptedChatModel((messages) =>
    ToolMessage.isInstance(messages.at(-1))
      ? new AIMessage("done")
      : new AIMessage({ content: "", tool_calls: [call(`tool-${++ids}`)] }),
  );
  const agent = createBudgetTestAgent({
    model,
    tools: [execute],
    backend: new StateBackend(),
    checkpointer: new MemorySaver(),
    middleware: [
      createSourceWeftToolCallCountChannelsMiddleware(),
      ...limiter(2, 2),
    ],
  });
  const options = { configurable: { thread_id: "budget-thread" } };
  await agent.invoke({ messages: [new HumanMessage("first")] }, options);
  await agent.invoke({ messages: [new HumanMessage("second")] }, options);
  await assert.rejects(
    agent.invoke({ messages: [new HumanMessage("blocked")] }, options),
    expectBudget,
  );
  assert.equal(executions, 2);
  const state = await agent.getState(options);
  assert.equal(state.values.threadToolCallCount.__all__, 2);
});

test("mixed over-budget batch executes neither allowed prefix nor publisher side effects", async () => {
  let executions = 0;
  let publications = 0;
  let modelCalls = 0;
  const execute = tool(
    async () => {
      executions++;
      return "saved";
    },
    {
      name: "budget_probe",
      description: "Track execution",
      schema: z.object({}),
    },
  );
  const publish = tool(
    async () => {
      publications++;
      return "published";
    },
    {
      name: "publish_artifact",
      description: "Track publication",
      schema: z.object({}),
    },
  );
  const agent = createBudgetTestAgent({
    model: new ScriptedChatModel(() => {
      modelCalls++;
      return new AIMessage({
        content: "",
        tool_calls: [call("one"), call("two", "publish_artifact")],
      });
    }),
    tools: [execute, publish],
    backend: new StateBackend(),
    middleware: [
      createSourceWeftToolCallCountChannelsMiddleware(),
      ...limiter(1, 8),
    ],
  });
  await assert.rejects(
    agent.invoke({ messages: [new HumanMessage("two calls")] }),
    expectBudget,
  );
  assert.equal(executions, 0);
  assert.equal(publications, 0);
  assert.equal(modelCalls, 1);
});

test("run exhaustion must not poison a subsequent new user turn while the thread budget remains", async () => {
  let executions = 0;
  let ids = 0;
  const execute = tool(
    async () => {
      executions++;
      return "saved";
    },
    {
      name: "budget_probe",
      description: "Track execution",
      schema: z.object({}),
    },
  );
  const model = new ScriptedChatModel((messages) => {
    const last = messages.at(-1);
    const isNewTurn = messages.some(
      (message) =>
        HumanMessage.isInstance(message) &&
        message.content === "new user request",
    );
    if (isNewTurn && ToolMessage.isInstance(last))
      return new AIMessage("new request completed");
    return new AIMessage({ content: "", tool_calls: [call(`tool-${++ids}`)] });
  });
  const checkpointer = new MemorySaver();
  const build = (userMessageId: string) =>
    createBudgetTestAgent({
      model,
      tools: [execute],
      backend: new StateBackend(),
      checkpointer,
      middleware: [
        createSourceWeftToolCallCountChannelsMiddleware(),
        ...limiter(1, 8, userMessageId),
      ],
    });
  const agent = build("first-user-id");
  const options = { configurable: { thread_id: "new-turn-budget" } };
  await assert.rejects(
    agent.invoke(
      { messages: [new HumanMessage("exhaust this request")] },
      options,
    ),
    (error) => {
      assert.deepEqual(toAgentToolBudgetContentError(error)?.details, {
        scope: "run",
        retryable: false,
      });
      const typed =
        error instanceof ToolCallLimitExceededError
          ? error
          : (error as { cause?: unknown }).cause;
      assert.ok(typed instanceof ToolCallLimitExceededError);
      assert.equal(typed.runCount, 2);
      assert.equal(typed.runLimit, 1);
      return true;
    },
  );
  assert.equal(executions, 1);
  const afterFailure = await agent.getState(options);
  assert.equal(afterFailure.values.threadToolCallCount.__all__, 1);
  // Rebuilding for the SAME source message is a retry, never a new budget.
  await assert.rejects(
    build("first-user-id").invoke(
      { messages: [new HumanMessage("same-user retry")] },
      options,
    ),
    expectBudget,
  );
  const newAgent = build("second-user-id");
  const result = await newAgent.invoke(
    { messages: [new HumanMessage("new user request")] },
    options,
  );
  assert.equal(executions, 2);
  assert.equal(result.messages.at(-1)?.content, "new request completed");
  const afterRecovery = await newAgent.getState(options);
  assert.equal(afterRecovery.values.threadToolCallCount.__all__, 2);
});

test("within-budget tool-only completion stays valid", async () => {
  let executions = 0;
  let modelCalls = 0;
  const execute = tool(
    async () => {
      executions++;
      return "saved";
    },
    {
      name: "budget_probe",
      description: "Track execution",
      schema: z.object({}),
    },
  );
  const model = new ScriptedChatModel(() =>
    ++modelCalls === 1
      ? new AIMessage({ content: "", tool_calls: [call("one")] })
      : new AIMessage(""),
  );
  const agent = createBudgetTestAgent({
    model,
    tools: [execute],
    backend: new StateBackend(),
    middleware: [
      createSourceWeftToolCallCountChannelsMiddleware(),
      ...limiter(1, 4),
    ],
  });
  const result = await agent.invoke({
    messages: [new HumanMessage("tool-only")],
  });
  assert.equal(executions, 1);
  assert.equal(result.messages.at(-1)?.content, "");
});

test("named ask_user continue policy remains independent from global error policy", async () => {
  let executions = 0;
  let modelCalls = 0;
  const ask = tool(
    async () => {
      executions++;
      return "answered";
    },
    { name: "ask_user", description: "Track named tool", schema: z.object({}) },
  );
  const agent = createBudgetTestAgent({
    model: new ScriptedChatModel(() =>
      ++modelCalls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [
              call("ask-one", "ask_user"),
              call("ask-two", "ask_user"),
            ],
          })
        : new AIMessage("done"),
    ),
    tools: [ask],
    backend: new StateBackend(),
    middleware: [
      createSourceWeftToolCallCountChannelsMiddleware(),
      toolCallLimitMiddleware({
        toolName: "ask_user",
        runLimit: 1,
        exitBehavior: "continue",
      }),
      ...limiter(8, 12),
    ],
  });
  const result = await agent.invoke({
    messages: [new HumanMessage("ask twice")],
  });
  assert.equal(executions, 1);
  assert.ok(
    result.messages.some(
      (message) =>
        ToolMessage.isInstance(message) &&
        message.status === "error" &&
        String(message.content).includes("Do not call 'ask_user' again"),
    ),
  );
});

test("legacy nonzero run counts bind without reset, then a distinct trusted user ID recovers only the run budget", async () => {
  let executions = 0;
  let ids = 0;
  const probe = tool(
    async () => {
      executions++;
      return "saved";
    },
    {
      name: "budget_probe",
      description: "Count effects",
      schema: z.object({}),
    },
  );
  const model = new ScriptedChatModel((messages) =>
    ToolMessage.isInstance(messages.at(-1))
      ? new AIMessage("done")
      : new AIMessage({ content: "", tool_calls: [call(`legacy-${++ids}`)] }),
  );
  const checkpointer = new MemorySaver();
  const build = (id: string | null) =>
    createBudgetTestAgent({
      model,
      tools: [probe],
      backend: new StateBackend(),
      checkpointer,
      middleware: [
        createSourceWeftToolCallCountChannelsMiddleware(),
        ...limiter(1, 8, id),
      ],
    });
  const options = { configurable: { thread_id: "legacy-budget" } };
  const legacy = build(null);
  await legacy.updateState(options, {
    messages: [new HumanMessage("legacy request")],
    runToolCallCount: { __all__: 1 },
    threadToolCallCount: { __all__: 1 },
  });
  const bound = build("legacy-user");
  await assert.rejects(
    bound.invoke(
      { messages: [new HumanMessage("same legacy request")] },
      options,
    ),
    expectBudget,
  );
  assert.equal(executions, 0);
  const afterBinding = await bound.getState(options);
  assert.equal(afterBinding.values.sourceweftToolBudgetTurnId, "legacy-user");
  assert.equal(afterBinding.values.runToolCallCount.__all__, 1);
  const next = build("new-user");
  await next.invoke({ messages: [new HumanMessage("new request")] }, options);
  const afterNext = await next.getState(options);
  assert.equal(executions, 1);
  assert.equal(afterNext.values.sourceweftToolBudgetTurnId, "new-user");
  assert.equal(afterNext.values.threadToolCallCount.__all__, 2);
});

test("empty IDs and stale/default child marker writes cannot reset a same-turn budget", async () => {
  const model = new ScriptedChatModel(
    () => new AIMessage({ content: "", tool_calls: [call("blocked")] }),
  );
  const checkpointer = new MemorySaver();
  const build = (id: string | null) =>
    createBudgetTestAgent({
      model,
      backend: new StateBackend(),
      checkpointer,
      middleware: [
        createSourceWeftToolCallCountChannelsMiddleware(),
        ...limiter(1, 8, id),
      ],
    });
  const options = { configurable: { thread_id: "stale-marker" } };
  const current = build("current-user");
  await current.updateState(options, {
    sourceweftToolBudgetTurnId: "current-user",
    runToolCallCount: { __all__: 1 },
    threadToolCallCount: { __all__: 1 },
  });
  await current.updateState(options, {
    sourceweftToolBudgetTurnId: "stale-child-user",
  });
  await current.updateState(options, { sourceweftToolBudgetTurnId: null });
  assert.equal(
    (await current.getState(options)).values.sourceweftToolBudgetTurnId,
    "current-user",
  );
  await assert.rejects(
    current.invoke({ messages: [new HumanMessage("retry")] }, options),
    expectBudget,
  );
  for (const id of [null, ""]) {
    const missing = build(id);
    await assert.rejects(
      missing.invoke(
        { messages: [new HumanMessage("missing identifier")] },
        options,
      ),
      expectBudget,
    );
    assert.equal(
      (await missing.getState(options)).values.sourceweftToolBudgetTurnId,
      "current-user",
    );
  }
});

test("HITL resume keeps the same run budget rather than clearing it", async () => {
  let effects = 0;
  const pause = tool(async () => String(interrupt("approval required")), {
    name: "pause_budget",
    description: "Pause inside a real tool",
    schema: z.object({}),
  });
  const probe = tool(
    async () => {
      effects++;
      return "saved";
    },
    {
      name: "budget_probe",
      description: "Must remain blocked",
      schema: z.object({}),
    },
  );
  const model = new ScriptedChatModel(
    (messages) =>
      new AIMessage({
        content: "",
        tool_calls: [
          ToolMessage.isInstance(messages.at(-1))
            ? call("after-pause")
            : call("pause", "pause_budget"),
        ],
      }),
  );
  const checkpointer = new MemorySaver();
  const build = () =>
    createBudgetTestAgent({
      model,
      tools: [pause, probe],
      backend: new StateBackend(),
      checkpointer,
      middleware: [
        createSourceWeftToolCallCountChannelsMiddleware(),
        ...limiter(1, 8, "same-user"),
      ],
    });
  const agent = build();
  const options = { configurable: { thread_id: "hitl-budget" } };
  await agent.invoke(
    { messages: [new HumanMessage("pause then act")] },
    options,
  );
  const paused = await agent.getState(options);
  assert.equal(paused.values.runToolCallCount.__all__, 1);
  assert.ok(paused.tasks.some((task) => task.interrupts?.length));
  await assert.rejects(
    build().invoke(new Command({ resume: "approved" }), options),
    expectBudget,
  );
  assert.equal(effects, 0);
  assert.equal(
    (await agent.getState(options)).values.sourceweftToolBudgetTurnId,
    "same-user",
  );
});

test("real parallel child tasks share their parent's trusted marker without channel conflicts", async () => {
  let executions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = tool(
    async () => {
      executions++;
      if (executions === 2) release();
      await gate;
      return "child complete";
    },
    {
      name: "budget_probe",
      description: "Exercise parallel children",
      schema: z.object({}),
    },
  );
  const childModel = new ScriptedChatModel((messages) =>
    ToolMessage.isInstance(messages.at(-1))
      ? new AIMessage("child done")
      : new AIMessage({
          content: "",
          tool_calls: [call(`child-${executions}`)],
        }),
  );
  let parentCalls = 0;
  const parent = createBudgetTestAgent({
    model: new ScriptedChatModel(() =>
      ++parentCalls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [1, 2].map((n) => ({
              id: `task-${n}`,
              name: "task",
              args: {
                description: `child ${n}`,
                subagent_type: "budget-child",
              },
            })),
          })
        : new AIMessage("parent done"),
    ),
    backend: new StateBackend(),
    checkpointer: new MemorySaver(),
    middleware: [
      createSourceWeftToolCallCountChannelsMiddleware(),
      ...limiter(8, 20, "parent-user"),
    ],
    subagents: [
      {
        name: "budget-child",
        description: "Probe budget lifecycle",
        systemPrompt: "Run the probe then finish",
        model: childModel,
        tools: [probe],
        middleware: [
          createSourceWeftToolCallCountChannelsMiddleware(),
          ...limiter(8, 20, "parent-user"),
        ],
      },
    ],
  });
  const options = { configurable: { thread_id: "parallel-marker" } };
  const result = await parent.invoke(
    { messages: [new HumanMessage("parallel")] },
    options,
  );
  assert.equal(executions, 2);
  assert.equal(result.messages.at(-1)?.content, "parent done");
  const state = await parent.getState(options);
  assert.equal(state.values.sourceweftToolBudgetTurnId, "parent-user");
  assert.ok((state.values.threadToolCallCount.__all__ ?? 0) >= 2);
});

test("a delegated child budget failure stays a task error under the existing parent tool-error policy", async () => {
  const { createSourceWeftToolErrorMiddleware } = await import("./tool-error");
  let childEffects = 0;
  let parentCalls = 0;
  let childCalls = 0;
  const probe = tool(
    async () => {
      childEffects++;
      return "saved";
    },
    {
      name: "budget_probe",
      description: "Track child effects",
      schema: z.object({}),
    },
  );
  const parent = createBudgetTestAgent({
    model: new ScriptedChatModel(() =>
      ++parentCalls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "task-budget",
                name: "task",
                args: {
                  description: "try two probes",
                  subagent_type: "limited-child",
                },
              },
            ],
          })
        : new AIMessage("The delegated task reached its budget."),
    ),
    backend: new StateBackend(),
    middleware: [
      createSourceWeftToolCallCountChannelsMiddleware(),
      createSourceWeftToolErrorMiddleware(),
      ...limiter(8, 20, "parent-id"),
    ],
    subagents: [
      {
        name: "limited-child",
        description: "Exercise child error boundary",
        systemPrompt: "Probe twice",
        tools: [probe],
        model: new ScriptedChatModel(
          () =>
            new AIMessage({
              content: "",
              tool_calls: [call(`child-probe-${++childCalls}`)],
            }),
        ),
        middleware: [
          createSourceWeftToolCallCountChannelsMiddleware(),
          ...limiter(2, 20, "parent-id"),
        ],
      },
    ],
  });
  const result = await parent.invoke({
    messages: [new HumanMessage("delegate")],
  });
  assert.equal(childEffects, 1);
  const taskError = result.messages.find(
    (message) =>
      ToolMessage.isInstance(message) && message.tool_call_id === "task-budget",
  );
  assert.ok(ToolMessage.isInstance(taskError));
  assert.equal(taskError.status, "error");
  assert.match(String(taskError.content), /[Tt]ool call limit/);
  assert.equal(
    result.messages.at(-1)?.content,
    "The delegated task reached its budget.",
  );
});
