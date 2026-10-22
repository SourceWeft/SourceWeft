import assert from "node:assert/strict";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { MemorySaver, Command, interrupt } from "@langchain/langgraph";
import {
  createDeepAgent,
  StateBackend,
  createSummarizationMiddleware,
  type SubAgent,
} from "deepagents";
import {
  createMiddleware,
  modelRetryMiddleware,
  type AgentMiddleware,
} from "langchain";
import { test } from "vitest";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import { ContentError } from "../../../content/errors";
import {
  createSourceWeftStepBudgetMiddleware as createCurrentStepBudgetMiddleware,
  selectAgentStepStop,
  agentRunStopFromStepBudgetError,
  currentAgentStepScope,
  agentStepBudgetContentError,
  isAgentStepFinalizing,
  buildAgentStepSummaryInput,
  type AgentStepBudgetState,
} from "./step-budget";
import { createSourceWeftSummarizationMiddleware } from "./context-compression";
import { createCommandToolChoiceMiddleware } from "./command-tool-choice";
import { createSourceWeftToolCallCountChannelsMiddleware } from "./tool-call-count-channels";
import { createSourceWeftToolCallContextMiddleware } from "./tool-call-context";

/** The governance `beforeAgent` hook as the v1 seeding wrapper calls it. */
type BudgetBeforeAgent = (
  state: {
    sourceweftRunStepBudget?: {
      userMessageId?: unknown;
      scopes?: Record<string, unknown>;
    } | null;
  },
  runtime: unknown,
) => Record<string, unknown> | undefined;
// Historical suite exercises explicit checkpoint v1; production initializes v2.
function createSourceWeftStepBudgetMiddleware(input: {
  userMessageId?: string;
  maxSteps?: number;
}) {
  const budget = createCurrentStepBudgetMiddleware(input);
  const original = budget.governance
    .beforeAgent as unknown as BudgetBeforeAgent;
  const seedV1: BudgetBeforeAgent = (state, runtime) => {
    const initialized = original(state, runtime);
    const previous = state.sourceweftRunStepBudget;
    if (
      previous != null &&
      (!previous.scopes || typeof previous.userMessageId !== "string")
    )
      return initialized;
    const scope = currentAgentStepScope();
    const existing =
      previous?.userMessageId === input.userMessageId ? previous!.scopes : {};
    if (existing?.[scope]) return initialized;
    return {
      ...initialized,
      sourceweftRunStepBudget: {
        userMessageId: input.userMessageId,
        scopes: {
          ...existing,
          [scope]: { steps: 0, limit: input.maxSteps ?? 2, summary: "unused" },
        },
      },
    };
  };
  budget.governance.beforeAgent =
    seedV1 as unknown as typeof budget.governance.beforeAgent;
  return budget;
}

type Options = { configurable: { thread_id: string } };
type AgentState = {
  messages: BaseMessage[];
  sourceweftRunStepBudget: AgentStepBudgetState;
};
type Agent = {
  invoke(input: unknown, options?: Options): Promise<AgentState>;
  getState(options: Options): Promise<{
    values: AgentState;
    tasks: Array<{ interrupts?: unknown[] }>;
  }>;
  updateState(
    options: Options,
    update: Record<string, unknown>,
  ): Promise<unknown>;
};
function graph(input: {
  model: ScriptedChatModel;
  uid?: string;
  limit?: number;
  tools?: StructuredToolInterface[];
  checkpointer?: MemorySaver;
  middleware?: AgentMiddleware[];
  subagents?: SubAgent[];
}) {
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId: input.uid ?? "user-1",
    maxSteps: input.limit ?? 2,
  });
  return createDeepAgent({
    model: input.model,
    tools: input.tools ?? [],
    backend: new StateBackend(),
    ...(input.checkpointer ? { checkpointer: input.checkpointer } : {}),
    middleware: [
      budget.governance,
      createSourceWeftToolCallContextMiddleware(),
      ...(input.middleware ?? []).map(budget.attachBudgetState),
      budget.finalization,
    ],
    ...(input.subagents ? { subagents: input.subagents } : {}),
  }) as unknown as Agent;
}
const call = (id: string, name = "probe") => ({ id, name, args: {} });
const isSummary = (messages: BaseMessage[]) =>
  messages.some(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes(
        "business-step budget for this run is exhausted",
      ),
  );
class RecordingModel extends ScriptedChatModel {
  bindings: Array<{ tools: unknown[]; options: Record<string, unknown> }> = [];
  bindTools(tools?: unknown[], options?: Record<string, unknown>) {
    this.bindings.push({ tools: tools ?? [], options: options ?? {} });
    return this;
  }
}

test("a model decision and its parallel tool batch count once, then one tool-free summary is checkpointed", async () => {
  let modelCalls = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "saved";
    },
    { name: "probe", description: "effect", schema: z.object({}) },
  );
  const model = new RecordingModel((messages) => {
    modelCalls++;
    return isSummary(messages)
      ? new AIMessage(
          "Ran four probes; publication remains unverified. Send a new message to continue.",
        )
      : new AIMessage({
          content: "",
          tool_calls: [call(`a${modelCalls}`), call(`b${modelCalls}`)],
        });
  });
  const agent = graph({
    model,
    tools: [probe],
    checkpointer: new MemorySaver(),
  });
  const options = { configurable: { thread_id: "batches" } };
  const result = await agent.invoke(
    { messages: [new HumanMessage("work")] },
    options,
  );
  assert.equal(modelCalls, 3);
  assert.equal(effects, 4);
  const selected = selectAgentStepStop(result, { userMessageId: "user-1" });
  assert.deepEqual(selected?.agentRunStop, {
    reason: "step_limit",
    steps: 2,
    limit: 2,
    canContinue: true,
    summaryStatus: "completed",
  });
  assert.match(selected?.summaryText ?? "", /four probes/);
  assert.equal(model.bindings.at(-1)?.tools.length, 0);
  assert.equal(model.bindings.at(-1)?.options.tool_choice, "none");
  assert.equal(model.bindings.at(-1)?.options.maxTokens, 2048);
  assert.deepEqual(
    selectAgentStepStop(await agent.getState(options), {
      userMessageId: "user-1",
    }),
    selected,
  );
});

test("a normal final answer on the last business decision does not force a summary", async () => {
  let calls = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "done";
    },
    { name: "probe", description: "effect", schema: z.object({}) },
  );
  const agent = graph({
    model: new ScriptedChatModel(() =>
      ++calls === 1
        ? new AIMessage({ content: "", tool_calls: [call("one")] })
        : new AIMessage("finished normally"),
    ),
    tools: [probe],
  });
  const result = await agent.invoke({ messages: [new HumanMessage("work")] });
  assert.equal(calls, 2);
  assert.equal(effects, 1);
  assert.equal(selectAgentStepStop(result, { userMessageId: "user-1" }), null);
});

test("summary wrapper re-entry cannot dispatch a second physical model request", async () => {
  let calls = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "ok";
    },
    { name: "probe", description: "effect", schema: z.object({}) },
  );
  const repeat = createMiddleware({
    name: "RepeatSameDecision",
    wrapModelCall: async (request, handler) => {
      const first = await handler(request);
      if (isAgentStepFinalizing(request.state)) return handler(request);
      return first;
    },
  });
  const model = new RecordingModel((messages) => {
    calls++;
    return isSummary(messages)
      ? new AIMessage("One probe completed; unfinished work can continue.")
      : new AIMessage({ content: "", tool_calls: [call("effect")] });
  });
  const result = await graph({
    model,
    tools: [probe],
    limit: 1,
    middleware: [repeat],
  }).invoke({ messages: [new HumanMessage("work")] });
  assert.equal(calls, 2);
  assert.equal(effects, 1);
  assert.equal(
    selectAgentStepStop(result, { userMessageId: "user-1" })?.agentRunStop
      .steps,
    1,
  );
});

test("malformed or tool-requesting summaries never execute another tool", async () => {
  const violations = [
    () => new AIMessage(""),
    () =>
      new AIMessage({
        content: "pretend summary",
        tool_calls: [call("violation")],
      }),
    () =>
      new AIMessage({
        content: "pretend summary",
        additional_kwargs: {
          function_call: { name: "probe", arguments: "{}" },
        },
      }),
    () =>
      Object.assign(new AIMessage("pretend summary"), {
        function_call: { name: "probe", arguments: "{}" },
      }),
    () =>
      new AIMessage({
        content: [
          { type: "tool_use", id: "violation", name: "probe", input: {} },
        ] as never,
      }),
  ];
  for (const violation of violations) {
    let calls = 0,
      effects = 0;
    const probe = tool(
      async () => {
        effects++;
        return "ok";
      },
      { name: "probe", description: "effect", schema: z.object({}) },
    );
    const model = new ScriptedChatModel((messages) => {
      calls++;
      return isSummary(messages)
        ? violation()
        : new AIMessage({ content: "", tool_calls: [call("effect")] });
    });
    await assert.rejects(
      graph({ model, tools: [probe], limit: 1 }).invoke({
        messages: [new HumanMessage("work")],
      }),
      (error) => {
        assert.equal(
          agentStepBudgetContentError(error)?.code,
          "AGENT_STEP_SUMMARY_FAILED",
        );
        assert.equal(
          agentRunStopFromStepBudgetError(error)?.summaryStatus,
          "failed",
        );
        return true;
      },
    );
    assert.equal(effects, 1);
    assert.equal(calls, 2);
  }
});

test("same-ID retry preserves a reserved finalization slot; a distinct new user starts a new frozen budget", async () => {
  let business = 0,
    summaries = 0;
  const saver = new MemorySaver();
  const probe = tool(async () => "ok", {
    name: "probe",
    description: "effect",
    schema: z.object({}),
  });
  const model = new ScriptedChatModel((messages) => {
    if (isSummary(messages)) {
      summaries++;
      throw new Error("summary unavailable");
    }
    business++;
    return new AIMessage({ content: "", tool_calls: [call(`p${business}`)] });
  });
  const options = { configurable: { thread_id: "failed-slot" } };
  await assert.rejects(
    graph({ model, tools: [probe], limit: 1, checkpointer: saver }).invoke(
      { messages: [new HumanMessage("work")] },
      options,
    ),
  );
  assert.equal(summaries, 1);
  await assert.rejects(
    graph({ model, tools: [probe], limit: 9, checkpointer: saver }).invoke(
      { messages: [new HumanMessage("same user retry")] },
      options,
    ),
  );
  assert.equal(summaries, 1);
  assert.equal(business, 1);
  const next = graph({
    model: new ScriptedChatModel(() => new AIMessage("new request finished")),
    uid: "new-user",
    limit: 3,
    checkpointer: saver,
  });
  await next.invoke({ messages: [new HumanMessage("continue")] }, options);
  const state = await next.getState(options);
  assert.equal(state.values.sourceweftRunStepBudget.userMessageId, "new-user");
  assert.equal(state.values.sourceweftRunStepBudget.scopes.main!.limit, 3);
  assert.equal(state.values.sourceweftRunStepBudget.scopes.main!.steps, 1);
});

test("checkpointed completed summaries freeze the original limit and do not spend again on same-ID re-entry", async () => {
  let calls = 0;
  const saver = new MemorySaver();
  const probe = tool(async () => "ok", {
    name: "probe",
    description: "effect",
    schema: z.object({}),
  });
  const model = new ScriptedChatModel((messages) => {
    calls++;
    return isSummary(messages)
      ? new AIMessage("Progress saved.")
      : new AIMessage({ content: "", tool_calls: [call(`p${calls}`)] });
  });
  const options = { configurable: { thread_id: "complete-slot" } };
  await graph({ model, tools: [probe], limit: 1, checkpointer: saver }).invoke(
    { messages: [new HumanMessage("work")] },
    options,
  );
  const result = await graph({
    model,
    tools: [probe],
    limit: 9,
    checkpointer: saver,
  }).invoke({ messages: [new HumanMessage("same-ID retry")] }, options);
  assert.equal(calls, 2);
  assert.equal(
    selectAgentStepStop(result, { userMessageId: "user-1" })?.agentRunStop
      .limit,
    1,
  );
});

test("HITL resume in a fresh graph preserves business steps and its original limit", async () => {
  let effects = 0,
    calls = 0;
  const saver = new MemorySaver();
  const pause = tool(async () => String(interrupt("approval")), {
    name: "pause",
    description: "pause",
    schema: z.object({}),
  });
  const probe = tool(
    async () => {
      effects++;
      return "wrong";
    },
    { name: "probe", description: "effect", schema: z.object({}) },
  );
  const model = new ScriptedChatModel((messages) => {
    calls++;
    return isSummary(messages)
      ? new AIMessage(
          "Approved operation completed; remaining work can continue.",
        )
      : new AIMessage({
          content: "",
          tool_calls: [call("pause-call", "pause")],
        });
  });
  const options = { configurable: { thread_id: "step-hitl" } };
  await graph({
    model,
    tools: [pause, probe],
    limit: 1,
    checkpointer: saver,
  }).invoke({ messages: [new HumanMessage("work")] }, options);
  const result = await graph({
    model,
    tools: [pause, probe],
    limit: 9,
    checkpointer: saver,
  }).invoke(new Command({ resume: "yes" }), options);
  assert.equal(calls, 2);
  assert.equal(effects, 0);
  assert.equal(
    selectAgentStepStop(result, { userMessageId: "user-1" })?.agentRunStop
      .limit,
    1,
  );
});

test("root and parallel children own stable independent graph budgets", async () => {
  let effects = 0,
    summaryCalls = 0,
    parentCalls = 0;
  const probe = tool(
    async () => {
      effects++;
      return "ok";
    },
    { name: "probe", description: "effect", schema: z.object({}) },
  );
  const childBudget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "user-1",
    maxSteps: 2,
  });
  const child = new ScriptedChatModel((messages) =>
    isSummary(messages)
      ? (summaryCalls++, new AIMessage("Child progress saved."))
      : new AIMessage({ content: "", tool_calls: [call(`p${effects}`)] }),
  );
  const model = new ScriptedChatModel(() =>
    ++parentCalls === 1
      ? new AIMessage({
          content: "",
          tool_calls: [1, 2].map((n) => ({
            id: `task-${n}`,
            name: "task",
            args: { description: `child${n}`, subagent_type: "child" },
          })),
        })
      : new AIMessage("Parent finished normally."),
  );
  const result = await graph({
    model,
    subagents: [
      {
        name: "child",
        description: "child",
        systemPrompt: "work",
        model: child,
        tools: [probe],
        middleware: [
          childBudget.governance,
          createSourceWeftToolCallContextMiddleware({ subagentType: "child" }),
          childBudget.finalization,
        ],
      },
    ],
  }).invoke({ messages: [new HumanMessage("parallel")] });
  assert.equal(parentCalls, 2);
  assert.equal(summaryCalls, 2);
  assert.equal(effects, 4);
  const scopes = Object.entries(result.sourceweftRunStepBudget.scopes);
  assert.equal(scopes.find(([key]) => key === "main")?.[1].steps, 2);
  assert.equal(scopes.filter(([key]) => key !== "main").length, 2);
  assert.equal(selectAgentStepStop(result, { userMessageId: "user-1" }), null);
});

test("priority auth/billing failures retain their code while carrying trusted failed-step metadata", async () => {
  for (const status of [402, 403]) {
    const probe = tool(async () => "ok", {
      name: "probe",
      description: "effect",
      schema: z.object({}),
    });
    const model = new ScriptedChatModel((messages) => {
      if (isSummary(messages))
        throw new ContentError(
          status,
          "BILLING_OR_PERMISSION",
          "Original safe priority message",
        );
      return new AIMessage({ content: "", tool_calls: [call("one")] });
    });
    await assert.rejects(
      graph({ model, tools: [probe], limit: 1 }).invoke({
        messages: [new HumanMessage("work")],
      }),
      (error) => {
        assert.equal(agentStepBudgetContentError(error)?.statusCode, status);
        assert.equal(
          agentStepBudgetContentError(error)?.code,
          "BILLING_OR_PERMISSION",
        );
        assert.equal(
          agentRunStopFromStepBudgetError(error)?.summaryStatus,
          "failed",
        );
        return true;
      },
    );
  }
});

test("summary inputs keep bounded explicitly untrusted result excerpts and discard raw reasoning", () => {
  const inputs = buildAgentStepSummaryInput([
    new HumanMessage("goal"),
    new AIMessage({
      content: "prior progress",
      additional_kwargs: { reasoning_content: "PRIVATE_REASONING" },
    }),
    ...Array.from(
      { length: 40 },
      () =>
        new ToolMessage({
          tool_call_id: "probe",
          name: "probe",
          content: "untrusted result " + "x".repeat(20_000),
        }),
    ),
  ]);
  const text = String(inputs[0]?.content);
  assert.ok(text.length <= 24_000);
  assert.match(text, /prior progress/);
  assert.match(text, /resultExcerpt/);
  assert.doesNotMatch(text, /PRIVATE_REASONING/);
});

test(
  "400 business decisions finish their tools before one finalization without hitting graph recursion",
  { timeout: 300_000 },
  async () => {
    let business = 0,
      summaries = 0,
      effects = 0;
    const probe = tool(
      async () => {
        effects++;
        return "saved";
      },
      { name: "probe", description: "effect", schema: z.object({}) },
    );
    const model = new ScriptedChatModel((messages) =>
      isSummary(messages)
        ? (summaries++,
          new AIMessage(
            "400 operations completed; remaining work can continue.",
          ))
        : (business++,
          new AIMessage({
            content: "",
            tool_calls: [call(`step-${business}`)],
          })),
    );
    const result = await graph({ model, tools: [probe], limit: 400 }).invoke({
      messages: [new HumanMessage("long task")],
    });
    assert.equal(business, 400);
    assert.equal(effects, 400);
    assert.equal(summaries, 1);
    assert.equal(
      selectAgentStepStop(result, { userMessageId: "user-1" })?.agentRunStop
        .steps,
      400,
    );
  },
);

test("legacy tool audit counters never become steps or block a fresh policy run", async () => {
  const saver = new MemorySaver();
  const options = { configurable: { thread_id: "legacy-audit" } };
  const model = new ScriptedChatModel(() => new AIMessage("ordinary final"));
  const agent = createDeepAgent({
    model,
    checkpointer: saver,
    backend: new StateBackend(),
    middleware: [createSourceWeftToolCallCountChannelsMiddleware()],
  }) as unknown as Agent;
  await agent.invoke({ messages: [new HumanMessage("first")] }, options);
  // This checkpoint update models an existing old policy checkpoint, not a new business turn.
  await agent.updateState(options, {
    threadToolCallCount: { __all__: 300 },
    runToolCallCount: { __all__: 48 },
  });
  const result = await graph({ model, checkpointer: saver, limit: 2 }).invoke(
    { messages: [new HumanMessage("same legacy request")] },
    options,
  );
  assert.equal(result.sourceweftRunStepBudget.scopes.main!.steps, 1);
  assert.equal(selectAgentStepStop(result, { userMessageId: "user-1" }), null);
});

test("native summarization private fields retain their schema and the shared reduced budget channel", async () => {
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "user-1",
    maxSteps: 1,
  });
  const native = createSummarizationMiddleware({
    backend: new StateBackend(),
    model: new ScriptedChatModel(() => new AIMessage("auxiliary memory")),
    trigger: { type: "messages", value: 1000 },
    keep: { type: "messages", value: 2 },
  });
  assert.equal(native.beforeModel, undefined);
  const attached = budget.attachBudgetState(native);
  const fields = (
    attached.stateSchema as unknown as { fields: Record<string, unknown> }
  ).fields;
  assert.ok(fields._summarizationSessionId);
  assert.ok(fields._summarizationEvent);
  assert.ok(fields.sourceweftRunStepBudget);
  let auxiliary = 0;
  const wrapped = budget.attachBudgetState({
    ...native,
    wrapModelCall: async (request, handler) => {
      if (isAgentStepFinalizing(request.state)) return handler(request);
      auxiliary++;
      return native.wrapModelCall!(request, handler);
    },
  });
  let business = 0,
    summaries = 0;
  const probe = tool(async () => "saved", {
    name: "probe",
    description: "effect",
    schema: z.object({}),
  });
  const model = new ScriptedChatModel((messages) =>
    isSummary(messages)
      ? (summaries++, new AIMessage("Saved progress."))
      : (business++, new AIMessage({ content: "", tool_calls: [call("one")] })),
  );
  const result = await createDeepAgent({
    model,
    backend: new StateBackend(),
    tools: [probe],
    middleware: [budget.governance, wrapped, budget.finalization],
  }).invoke({ messages: [new HumanMessage("work")] } as never);
  assert.equal(auxiliary, 1);
  assert.equal(business, 1);
  assert.equal(summaries, 1);
  assert.equal(
    selectAgentStepStop(result, { userMessageId: "user-1" })?.agentRunStop
      .limit,
    1,
  );
});

test("business model retries and command handler repeat remain one logical decision", async () => {
  let physical = 0,
    effects = 0,
    summaries = 0;
  const probe = tool(
    async () => {
      effects++;
      return "saved";
    },
    { name: "probe", description: "effect", schema: z.object({}) },
  );
  const model = new ScriptedChatModel((messages) => {
    if (isSummary(messages)) {
      summaries++;
      return new AIMessage("Probe completed. Continue with a new message.");
    }
    physical++;
    if (physical === 1) throw new Error("transient provider error");
    return physical === 2
      ? new AIMessage("No initial tool call")
      : new AIMessage({ content: "", tool_calls: [call("forced")] });
  });
  const result = await graph({
    model,
    tools: [probe],
    limit: 1,
    middleware: [
      modelRetryMiddleware({ maxRetries: 1, initialDelayMs: 0 }),
      createCommandToolChoiceMiddleware({
        initialToolPolicy: { kind: "force", toolName: "probe" },
      }),
    ],
  }).invoke({ messages: [new HumanMessage("work")] });
  assert.equal(physical, 3);
  assert.equal(effects, 1);
  assert.equal(summaries, 1);
  assert.equal(
    selectAgentStepStop(result, { userMessageId: "user-1" })?.agentRunStop
      .steps,
    1,
  );
});

test("summary provider failure is physically attempted once even under model retry middleware", async () => {
  let summaries = 0;
  const probe = tool(async () => "saved", {
    name: "probe",
    description: "effect",
    schema: z.object({}),
  });
  const model = new ScriptedChatModel((messages) => {
    if (isSummary(messages)) {
      summaries++;
      throw new Error("unavailable");
    }
    return new AIMessage({ content: "", tool_calls: [call("one")] });
  });
  await assert.rejects(
    graph({
      model,
      tools: [probe],
      limit: 1,
      middleware: [
        modelRetryMiddleware({
          maxRetries: 2,
          initialDelayMs: 0,
          onFailure: "error",
        }),
      ],
    }).invoke({ messages: [new HumanMessage("work")] }),
  );
  assert.equal(summaries, 1);
});

test("production native compression can run on the last business decision but never adds an auxiliary summary during finalization", async () => {
  let auxiliary = 0,
    business = 0,
    summaries = 0;
  const backend = new StateBackend();
  const memoryModel = new ScriptedChatModel(() => {
    auxiliary++;
    return new AIMessage("Previous conversation memory.");
  });
  const native = createSourceWeftSummarizationMiddleware({
    backend,
    model: memoryModel,
    chatProfileConfig: { contextLength: 128 },
  });
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "user-1",
    maxSteps: 1,
  });
  const probe = tool(async () => "saved", {
    name: "probe",
    description: "effect",
    schema: z.object({}),
  });
  const model = new ScriptedChatModel((messages) =>
    isSummary(messages)
      ? (summaries++,
        new AIMessage("Progress saved; continue with a new message."))
      : (business++, new AIMessage({ content: "", tool_calls: [call("one")] })),
  );
  const agent = createDeepAgent({
    model,
    backend,
    checkpointer: new MemorySaver(),
    tools: [probe],
    middleware: [
      budget.governance,
      budget.attachBudgetState(native),
      budget.finalization,
    ],
  }) as unknown as Agent;
  const options = { configurable: { thread_id: "native-budget" } };
  const result = await agent.invoke(
    {
      messages: [
        ...Array.from({ length: 40 }, (_, index) =>
          index % 2 === 0
            ? new HumanMessage("Old request " + index)
            : new AIMessage("Old history " + "x".repeat(1000)),
        ),
        new HumanMessage("Current work"),
      ],
    } as never,
    options,
  );
  const state = (await agent.getState(options)).values as unknown as Record<
    string,
    unknown
  >;
  assert.equal(auxiliary, 1);
  assert.equal(business, 1);
  assert.equal(summaries, 1);
  assert.ok(state._summarizationEvent);
  assert.ok(state._summarizationSessionId);
  assert.equal(
    selectAgentStepStop(result, { userMessageId: "user-1" })?.agentRunStop
      .steps,
    1,
  );
});

test("an approved legacy HITL checkpoint adopts steps only after its pending tools resume", async () => {
  const saver = new MemorySaver();
  const options = { configurable: { thread_id: "legacy-hitl-migration" } };
  let effects = 0,
    calls = 0;
  const pause = tool(
    async () => {
      const approval = interrupt("approval");
      effects++;
      return String(approval);
    },
    { name: "pause", description: "approval", schema: z.object({}) },
  );
  const oldModel = new ScriptedChatModel(
    () =>
      new AIMessage({
        content: "",
        tool_calls: [call("legacy-pause", "pause")],
      }),
  );
  const legacy = createDeepAgent({
    model: oldModel,
    backend: new StateBackend(),
    tools: [pause],
    checkpointer: saver,
    middleware: [
      createSourceWeftToolCallCountChannelsMiddleware(),
      createSourceWeftToolCallContextMiddleware(),
    ],
  }) as unknown as Agent;
  await legacy.invoke(
    {
      messages: [new HumanMessage("old approved operation")],
      threadToolCallCount: { __all__: 300 },
      runToolCallCount: { __all__: 48 },
    },
    options,
  );
  assert.equal(effects, 0);
  assert.ok(
    (await legacy.getState(options)).tasks.some(
      (task) => task.interrupts?.length,
    ),
  );
  const resumed = graph({
    model: new ScriptedChatModel(() => {
      calls++;
      return new AIMessage("Approved work completed normally.");
    }),
    tools: [pause],
    limit: 2,
    checkpointer: saver,
  });
  const result = await resumed.invoke(
    new Command({ resume: "approved" }),
    options,
  );
  assert.equal(effects, 1);
  assert.equal(calls, 1);
  assert.equal(result.sourceweftRunStepBudget.userMessageId, "user-1");
  assert.equal(result.sourceweftRunStepBudget.scopes.main!.steps, 1);
  assert.equal(selectAgentStepStop(result, { userMessageId: "user-1" }), null);
});

test("legacy resume initialization rejects non-null malformed or foreign policy state", async () => {
  for (const raw of [
    { malformed: true },
    { userMessageId: "foreign-user", scopes: {} },
  ]) {
    const saver = new MemorySaver();
    const options = { configurable: { thread_id: "invalid-legacy-resume" } };
    let models = 0;
    const pause = tool(async () => String(interrupt("approval")), {
      name: "pause",
      description: "approval",
      schema: z.object({}),
    });
    const oldState = createMiddleware({
      name: "HistoricalPolicyState",
      stateSchema: z.object({
        sourceweftRunStepBudget: z.unknown().optional(),
      }),
    });
    const legacy = createDeepAgent({
      model: new ScriptedChatModel(
        () =>
          new AIMessage({
            content: "",
            tool_calls: [call("legacy-pause", "pause")],
          }),
      ),
      backend: new StateBackend(),
      tools: [pause],
      checkpointer: saver,
      middleware: [oldState, createSourceWeftToolCallContextMiddleware()],
    }) as unknown as Agent;
    await legacy.invoke(
      {
        messages: [new HumanMessage("old work")],
        sourceweftRunStepBudget: raw,
      },
      options,
    );
    const resumed = graph({
      model: new ScriptedChatModel(() => {
        models++;
        return new AIMessage("must not run");
      }),
      tools: [pause],
      checkpointer: saver,
    });
    await assert.rejects(
      resumed.invoke(new Command({ resume: "approved" }), options),
      /Agent step budget identity is invalid/,
    );
    assert.equal(models, 0);
  }
});
