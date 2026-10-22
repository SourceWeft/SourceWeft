import assert from "node:assert/strict";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { MemorySaver, Command, interrupt } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { test } from "vitest";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import {
  type AgentStepV2ScopeBudget,
  createSourceWeftStepBudgetMiddleware,
  selectAgentRunProgress,
  selectAgentStepStop,
  getAgentStepPhase,
} from "./step-budget";
// The installed SDK's schema inference requires middleware-owned channels at
// invocation and infers getState as never; the runtime initializes those channels.
// Keep the same explicit test boundary as the historical SDK budget suite.
type AgentOptions = {
  configurable?: { thread_id: string };
  recursionLimit?: number;
};
/** The budget channel as these tests read it: every scope is a v2 entry. */
type BudgetChannel = {
  userMessageId: string;
  scopes: Record<string, AgentStepV2ScopeBudget>;
};
type AgentState = {
  messages: BaseMessage[];
  sourceweftRunStepBudget: BudgetChannel;
};
type Agent = {
  invoke(input: unknown, options?: AgentOptions): Promise<AgentState>;
  getState(options: AgentOptions): Promise<{
    values: AgentState;
    tasks: Array<{ interrupts?: unknown[] }>;
  }>;
};
function setup(input: {
  normal?: number;
  closing?: number;
  uid?: string;
  model: ScriptedChatModel;
  tools?: StructuredToolInterface[];
  saver?: MemorySaver;
}) {
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId: input.uid ?? "u",
    maxSteps: input.normal ?? 2,
    closingSteps: input.closing ?? 2,
  });
  return createDeepAgent({
    model: input.model,
    tools: input.tools ?? [],
    backend: new StateBackend(),
    middleware: [budget.governance, budget.toolCallRepair, budget.finalization],
    ...(input.saver ? { checkpointer: input.saver } : {}),
  }) as unknown as Agent;
}
const call = (name: string, id: string) =>
  new AIMessage({ content: "", tool_calls: [{ name, id, args: {} }] });
const summary = (messages: BaseMessage[]) =>
  messages.some(
    (m) =>
      typeof m.content === "string" &&
      m.content.includes("business-step budget for this run is exhausted"),
  );
test("closing executes verify failure, repair, reverify and committed publisher instead of merely a prompt", async () => {
  let calls = 0,
    valid = false,
    verified = false,
    published = false;
  const operations: string[] = [];
  const make = (name: string, fn: () => unknown) =>
    tool(
      async () => {
        operations.push(name);
        return JSON.stringify(fn());
      },
      { name, description: name, schema: z.object({}) },
    );
  const tools = [
    make("prepare", () => ({ prepared: true })),
    make("verify", () => {
      verified = valid;
      return { passed: valid };
    }),
    make("repair", () => {
      valid = true;
      return { repaired: true };
    }),
    make("publish", () => {
      assert.equal(verified, true);
      published = true;
      return { status: "committed", versionId: "verified-v1" };
    }),
  ];
  const model = new ScriptedChatModel(() => {
    calls++;
    return calls <= 2
      ? call("prepare", `p${calls}`)
      : calls === 3
        ? call("verify", "v1")
        : calls === 4
          ? call("repair", "r")
          : calls === 5
            ? call("verify", "v2")
            : calls === 6
              ? call("publish", "pub")
              : new AIMessage("Verified version committed.");
  });
  const result = await setup({ closing: 5, model, tools }).invoke({
    messages: [new HumanMessage("deliver")],
  });
  assert.deepEqual(operations, [
    "prepare",
    "prepare",
    "verify",
    "repair",
    "verify",
    "publish",
  ]);
  assert.equal(published, true);
  assert.equal(selectAgentStepStop(result, { userMessageId: "u" }), null);
  assert.deepEqual(selectAgentRunProgress(result, { userMessageId: "u" }), {
    policyVersion: 2,
    phase: "closing",
    normalSteps: 2,
    normalLimit: 2,
    closingSteps: 5,
    closingLimit: 5,
    steps: 7,
    limit: 7,
  });
});
test.each([
  [2, 2],
  [400, 40],
])(
  "%i+%i decisions finish complete boundary batches and one tool-free finalization",
  { timeout: 300_000 },
  async (normal, closing) => {
    let effects = 0,
      models = 0,
      summaryCalls = 0;
    const phases: string[] = [];
    const probe = tool(
      async () => {
        effects++;
        return "saved";
      },
      { name: "probe", description: "save", schema: z.object({}) },
    );
    const model = new ScriptedChatModel((messages) => {
      models++;
      if (summary(messages)) {
        summaryCalls++;
        return new AIMessage("Saved progress, publication unverified.");
      }
      return call("probe", `p${models}`);
    });
    const budget = createSourceWeftStepBudgetMiddleware({
      userMessageId: "u",
      maxSteps: normal,
      closingSteps: closing,
    });
    const { createMiddleware } = await import("langchain");
    const observer = budget.attachBudgetState(
      createMiddleware({
        name: "PhaseObserver",
        wrapModelCall: async (request, handler) => {
          const response = await handler(request);
          if (AIMessage.isInstance(response))
            phases.push(getAgentStepPhase(request.state)!);
          return response;
        },
      }),
    );
    const agent = createDeepAgent({
      model,
      tools: [probe],
      backend: new StateBackend(),
      middleware: [
        budget.governance,
        budget.toolCallRepair,
        observer,
        budget.finalization,
      ],
    }) as unknown as Agent;
    const result = await agent.invoke(
      { messages: [new HumanMessage("work")] },
      { recursionLimit: 10000 },
    );
    assert.equal(effects, normal + closing);
    assert.equal(models, normal + closing + 1);
    assert.equal(summaryCalls, 1);
    assert.deepEqual(phases, [
      ...Array(normal).fill("working"),
      ...Array(closing).fill("closing"),
      "finalizing",
    ]);
    assert.deepEqual(
      selectAgentStepStop(result, { userMessageId: "u" })?.agentRunStop,
      {
        policyVersion: 2,
        reason: "step_limit",
        normalSteps: normal,
        normalLimit: normal,
        closingSteps: closing,
        closingLimit: closing,
        steps: normal + closing,
        limit: normal + closing,
        canContinue: true,
        summaryStatus: "completed",
      },
    );
  },
);
test(
  "a working wall-clock trigger keeps all 40 tool-enabled closing decisions before the one tool-free finalization",
  { timeout: 300_000 },
  async () => {
    let now = 0,
      effects = 0,
      models = 0,
      summaryCalls = 0;
    const phases: string[] = [];
    const probe = tool(
      async () => {
        effects++;
        return "saved";
      },
      { name: "probe", description: "save", schema: z.object({}) },
    );
    const model = new ScriptedChatModel((messages) => {
      models++;
      if (summary(messages)) {
        summaryCalls++;
        return new AIMessage("Saved progress, publication unverified.");
      }
      // The working clock expires after the first decision; the closing clock
      // never does, so the closing allowance is exhausted by steps alone.
      if (models === 1) now = 45 * 60_000;
      return call("probe", `p${models}`);
    });
    const budget = createSourceWeftStepBudgetMiddleware({
      userMessageId: "u",
      maxSteps: 400,
      closingSteps: 40,
      runId: "run-1",
      wallClock: { workingMs: 45 * 60_000, closingMs: 10 * 60_000 },
      now: () => now,
    });
    const { createMiddleware } = await import("langchain");
    const observer = budget.attachBudgetState(
      createMiddleware({
        name: "PhaseObserver",
        wrapModelCall: async (request, handler) => {
          const response = await handler(request);
          if (AIMessage.isInstance(response))
            phases.push(getAgentStepPhase(request.state)!);
          return response;
        },
      }),
    );
    const agent = createDeepAgent({
      model,
      tools: [probe],
      backend: new StateBackend(),
      middleware: [
        budget.governance,
        budget.toolCallRepair,
        observer,
        budget.finalization,
      ],
    }) as unknown as Agent;
    const result = await agent.invoke(
      { messages: [new HumanMessage("work")] },
      { recursionLimit: 10000 },
    );
    // One normal decision, the wall-clock-forced last normal decision, forty
    // closing decisions, then the summary.
    assert.equal(effects, 42);
    assert.equal(models, 43);
    assert.equal(summaryCalls, 1);
    assert.deepEqual(phases, [
      "working",
      "working",
      ...Array(40).fill("closing"),
      "finalizing",
    ]);
    assert.deepEqual(
      selectAgentStepStop(result, { userMessageId: "u" })?.agentRunStop,
      {
        policyVersion: 2,
        reason: "step_limit",
        normalSteps: 400,
        normalLimit: 400,
        closingSteps: 40,
        closingLimit: 40,
        steps: 440,
        limit: 440,
        canContinue: true,
        summaryStatus: "completed",
      },
    );
    assert.deepEqual(result.sourceweftRunStepBudget.scopes.main!.wallClock, {
      runId: "run-1",
      startedAtMs: 0,
      closingStartedAtMs: 45 * 60_000,
      trigger: "wall_clock",
    });
  },
);
test.each([2, 4])(
  "natural final at decision %i never adds forced summary",
  async (final) => {
    let models = 0,
      effects = 0;
    const probe = tool(
      async () => {
        effects++;
        return "ok";
      },
      { name: "probe", description: "probe", schema: z.object({}) },
    );
    const result = await setup({
      model: new ScriptedChatModel(() =>
        ++models === final
          ? new AIMessage("done")
          : call("probe", `p${models}`),
      ),
      tools: [probe],
    }).invoke({ messages: [new HumanMessage("work")] });
    assert.equal(models, final);
    assert.equal(effects, final - 1);
    assert.equal(selectAgentStepStop(result, { userMessageId: "u" }), null);
  },
);
test("HITL and same-ID factory restore retain closing snapshot and counters; a new user adopts new limits", async () => {
  const saver = new MemorySaver();
  const opts = { configurable: { thread_id: "three-phase-resume" } };
  let effects = 0,
    calls = 0;
  const pause = tool(
    async () => {
      const answer = interrupt("approval");
      effects++;
      return String(answer);
    },
    { name: "pause", description: "pause", schema: z.object({}) },
  );
  const probe = tool(async () => "ok", {
    name: "probe",
    description: "probe",
    schema: z.object({}),
  });
  const first = setup({
    normal: 1,
    closing: 2,
    saver,
    tools: [probe, pause],
    model: new ScriptedChatModel(() =>
      ++calls === 1 ? call("probe", "p") : call("pause", "a"),
    ),
  });
  await first.invoke({ messages: [new HumanMessage("work")] }, opts);
  const state = await first.getState(opts);
  assert.equal(
    selectAgentRunProgress(state, { userMessageId: "u" })?.closingSteps,
    1,
  );
  const restored = setup({
    normal: 99,
    closing: 99,
    saver,
    tools: [probe, pause],
    model: new ScriptedChatModel(() => new AIMessage("done")),
  });
  const result = await restored.invoke(new Command({ resume: "yes" }), opts);
  assert.equal(effects, 1);
  assert.deepEqual(selectAgentRunProgress(result, { userMessageId: "u" }), {
    policyVersion: 2,
    phase: "closing",
    normalSteps: 1,
    normalLimit: 1,
    closingSteps: 2,
    closingLimit: 2,
    steps: 3,
    limit: 3,
  });
  const next = await setup({
    uid: "new",
    normal: 3,
    closing: 4,
    saver,
    model: new ScriptedChatModel(() => new AIMessage("continued")),
  }).invoke({ messages: [new HumanMessage("continue")] }, opts);
  assert.deepEqual(selectAgentRunProgress(next, { userMessageId: "new" }), {
    policyVersion: 2,
    phase: "working",
    normalSteps: 1,
    normalLimit: 3,
    closingSteps: 0,
    closingLimit: 4,
    steps: 1,
    limit: 7,
  });
});
test("persisted v1 same-user resume stays two-stage; next user receives v2 budget", async () => {
  const saver = new MemorySaver();
  const opts = { configurable: { thread_id: "explicit-v1-migration" } };
  let summaries = 0;
  const old = {
    userMessageId: "u",
    scopes: { main: { steps: 1, limit: 1, summary: "unused" } },
  };
  const result = await setup({
    saver,
    model: new ScriptedChatModel((messages) => {
      assert.equal(summary(messages), true);
      summaries++;
      return new AIMessage("Old progress remains incomplete.");
    }),
  }).invoke(
    {
      messages: [new HumanMessage("resume")],
      sourceweftRunStepBudget: old,
    },
    opts,
  );
  assert.equal(summaries, 1);
  assert.deepEqual(
    selectAgentStepStop(result, { userMessageId: "u" })?.agentRunStop,
    {
      reason: "step_limit",
      steps: 1,
      limit: 1,
      canContinue: true,
      summaryStatus: "completed",
    },
  );
  assert.equal(selectAgentRunProgress(result, { userMessageId: "u" }), null);
  const next = await setup({
    uid: "new",
    saver,
    normal: 4,
    closing: 3,
    model: new ScriptedChatModel(() => new AIMessage("continue")),
  }).invoke({ messages: [new HumanMessage("continue")] }, opts);
  assert.equal(
    selectAgentRunProgress(next, { userMessageId: "new" })?.normalLimit,
    4,
  );
});
test("unknown versions and inconsistent v2 counters fail before model dispatch", async () => {
  let calls = 0;
  for (const entry of [
    { policyVersion: 3, steps: 0, limit: 4, summary: "unused" },
    {
      policyVersion: 2,
      steps: 0,
      limit: 4,
      normalSteps: 1,
      normalLimit: 2,
      closingSteps: 0,
      closingLimit: 2,
      phase: "working",
      summary: "unused",
    },
  ]) {
    await assert.rejects(
      setup({
        model: new ScriptedChatModel(() => {
          calls++;
          return new AIMessage("must not run");
        }),
      }).invoke({
        messages: [new HumanMessage("work")],
        sourceweftRunStepBudget: {
          userMessageId: "u",
          scopes: { main: entry },
        },
      }),
    );
  }
  assert.equal(calls, 0);
});
test("last working task batch completes independent parallel child 1+1 budgets before root closing", async () => {
  let parentCalls = 0,
    effects = 0,
    childSummaries = 0;
  const probe = tool(
    async () => {
      effects++;
      return "saved";
    },
    { name: "probe", description: "save", schema: z.object({}) },
  );
  const childBudget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "u",
    maxSteps: 1,
    closingSteps: 1,
  });
  const parentBudget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "u",
    maxSteps: 1,
    closingSteps: 1,
  });
  const agent = createDeepAgent({
    model: new ScriptedChatModel(() =>
      ++parentCalls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [1, 2].map((n) => ({
              id: `task-${n}`,
              name: "task",
              args: { description: `independent${n}`, subagent_type: "child" },
            })),
          })
        : new AIMessage("Integrated child partial results."),
    ),
    backend: new StateBackend(),
    middleware: [
      parentBudget.governance,
      parentBudget.toolCallRepair,
      parentBudget.finalization,
    ],
    subagents: [
      {
        name: "child",
        description: "child",
        systemPrompt: "work",
        model: new ScriptedChatModel((messages) =>
          summary(messages)
            ? (childSummaries++,
              new AIMessage("Partial saved; verification remains."))
            : call("probe", `p-${effects}`),
        ),
        tools: [probe],
        middleware: [
          childBudget.governance,
          childBudget.toolCallRepair,
          childBudget.finalization,
        ],
      },
    ],
  }) as unknown as Agent;
  const result = await agent.invoke({
    messages: [new HumanMessage("parallel")],
  });
  assert.equal(parentCalls, 2);
  assert.equal(effects, 4);
  assert.equal(childSummaries, 2);
  const scopes = result.sourceweftRunStepBudget.scopes;
  assert.equal(Object.keys(scopes).length, 3);
  assert.equal(scopes.main!.phase, "closing");
  assert.equal(scopes.main!.steps, 2);
  for (const [scope, entry] of Object.entries(scopes)) {
    if (scope === "main") continue;
    assert.equal(entry.steps, 2);
    assert.equal(entry.normalSteps, 1);
    assert.equal(entry.closingSteps, 1);
    assert.equal(entry.summary, "completed");
  }
  assert.equal(selectAgentStepStop(result, { userMessageId: "u" }), null);
});
test("missing boundary tool snapshot fails explicitly instead of silently dropping all tools", async () => {
  let calls = 0;
  const agent = setup({
    model: new ScriptedChatModel(() => {
      calls++;
      return new AIMessage("must not dispatch");
    }),
  });
  await assert.rejects(
    agent.invoke({
      messages: [new HumanMessage("retry")],
      sourceweftRunStepBudget: {
        userMessageId: "u",
        scopes: {
          main: {
            policyVersion: 2,
            steps: 2,
            limit: 4,
            normalSteps: 2,
            normalLimit: 2,
            closingSteps: 0,
            closingLimit: 2,
            phase: "working",
            summary: "unused",
          },
        },
      },
    }),
    /closing tool snapshot is unavailable/,
  );
  assert.equal(calls, 0);
});
test("last normal provider failure has a durable tool snapshot and same-user reinvoke consumes no extra decision", async () => {
  const saver = new MemorySaver();
  const opts = { configurable: { thread_id: "last-normal-failure" } };
  let firstCalls = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "verified";
    },
    { name: "probe", description: "verify", schema: z.object({}) },
  );
  const failed = setup({
    normal: 1,
    closing: 2,
    saver,
    tools: [probe],
    model: new ScriptedChatModel(() => {
      firstCalls++;
      throw new Error("provider-boundary-failure");
    }),
  });
  await assert.rejects(
    failed.invoke({ messages: [new HumanMessage("work")] }, opts),
    /provider-boundary-failure/,
  );
  assert.equal(firstCalls, 1);
  assert.equal(effects, 0);
  const checkpoint = await failed.getState(opts);
  const entry = checkpoint.values.sourceweftRunStepBudget.scopes.main!;
  assert.equal(entry.normalSteps, 1);
  assert.equal(entry.decisionPreparation!.status, "ready");
  assert.ok(entry.availableToolIds!.includes("probe"));
  let resumedCalls = 0;
  const restored = setup({
    normal: 99,
    closing: 99,
    saver,
    tools: [probe],
    model: new ScriptedChatModel(() =>
      ++resumedCalls === 1
        ? call("probe", "retained-normal-tool")
        : new AIMessage("Verified and complete."),
    ),
  });
  const result = await restored.invoke({ messages: [] }, opts);
  assert.equal(resumedCalls, 2);
  assert.equal(effects, 1);
  assert.deepEqual(selectAgentRunProgress(result, { userMessageId: "u" }), {
    policyVersion: 2,
    phase: "closing",
    normalSteps: 1,
    normalLimit: 1,
    closingSteps: 1,
    closingLimit: 2,
    steps: 2,
    limit: 3,
  });
  assert.equal(
    result.sourceweftRunStepBudget.scopes.main!.decisionPreparation,
    undefined,
  );
});
test.each([false, true])(
  "successful last normal AI checkpoint survives afterModel crash (tool request=%s)",
  async (withTool) => {
    const { createMiddleware, modelRetryMiddleware } =
      await import("langchain");
    const saver = new MemorySaver();
    const opts = {
      configurable: { thread_id: `after-model-crash-${withTool}` },
    };
    let effects = 0,
      firstCalls = 0,
      resumedCalls = 0;
    const probe = tool(
      async () => {
        effects++;
        return "verified";
      },
      { name: "probe", description: "verify", schema: z.object({}) },
    );
    const budget = createSourceWeftStepBudgetMiddleware({
      userMessageId: "u",
      maxSteps: 1,
      closingSteps: 2,
    });
    const crash = budget.attachBudgetState(
      createMiddleware({
        name: "CrashBeforeBudgetAfterModel",
        afterModel: (state) => {
          const entry = (state as Partial<AgentState>).sourceweftRunStepBudget
            ?.scopes.main;
          const latest = [...state.messages]
            .reverse()
            .find(AIMessage.isInstance);
          if (
            entry?.decisionPreparation?.status === "ready" &&
            latest?.id !== entry.decisionPreparation.previousAssistantId
          )
            throw new Error("after-model-crash");
        },
      }),
    );
    const failed = createDeepAgent({
      backend: new StateBackend(),
      checkpointer: saver,
      tools: [probe],
      model: new ScriptedChatModel(() => {
        firstCalls++;
        return withTool
          ? call("probe", "pre-crash-tool")
          : new AIMessage("Finished before crash.");
      }),
      middleware: [
        budget.governance,
        budget.toolCallRepair,
        crash,
        modelRetryMiddleware({ retryOn: () => false, onFailure: "error" }),
        budget.finalization,
      ],
    }) as unknown as Agent;
    await assert.rejects(
      failed.invoke({ messages: [new HumanMessage("work")] }, opts),
      /after-model-crash/,
    );
    assert.equal(firstCalls, 1);
    assert.equal(effects, 0);
    const result = await setup({
      normal: 9,
      closing: 9,
      saver,
      tools: [probe],
      model: new ScriptedChatModel(() => {
        resumedCalls++;
        return new AIMessage("Existing work verified.");
      }),
    }).invoke({ messages: [] }, opts);
    assert.equal(firstCalls, 1);
    assert.equal(
      effects,
      withTool ? 1 : 0,
      JSON.stringify({ result, firstCalls, resumedCalls }),
    );
    assert.equal(resumedCalls, withTool ? 1 : 0);
    const progress = selectAgentRunProgress(result, { userMessageId: "u" });
    assert.equal(progress?.normalSteps, 1);
    assert.equal(progress?.normalLimit, 1);
    assert.equal(progress?.closingSteps, withTool ? 1 : 0);
    assert.equal(selectAgentStepStop(result, { userMessageId: "u" }), null);
  },
);
test("saved AI replay preserves the native HITL approval chain before tools", async () => {
  const { createMiddleware } = await import("langchain");
  const saver = new MemorySaver();
  const opts = { configurable: { thread_id: "prepared-native-hitl" } };
  let effects = 0,
    resumedModels = 0;
  const probe = tool(
    async () => {
      effects++;
      return "approved verified";
    },
    { name: "probe", description: "requires approval", schema: z.object({}) },
  );
  const initialBudget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "u",
    maxSteps: 1,
    closingSteps: 2,
  });
  const crash = initialBudget.attachBudgetState(
    createMiddleware({
      name: "CrashBeforeApproval",
      afterModel: (state) => {
        const entry = (state as Partial<AgentState>).sourceweftRunStepBudget
          ?.scopes.main;
        const latest = [...state.messages].reverse().find(AIMessage.isInstance);
        if (
          entry?.decisionPreparation?.status === "ready" &&
          latest?.id !== entry.decisionPreparation.previousAssistantId
        )
          throw new Error("pre-approval-crash");
      },
    }),
  );
  const first = createDeepAgent({
    model: new ScriptedChatModel(() => call("probe", "approval-pending")),
    tools: [probe],
    backend: new StateBackend(),
    checkpointer: saver,
    middleware: [
      initialBudget.governance,
      initialBudget.toolCallRepair,
      crash,
      initialBudget.finalization,
    ],
  }) as unknown as Agent;
  await assert.rejects(
    first.invoke({ messages: [new HumanMessage("work")] }, opts),
    /pre-approval-crash/,
  );
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "u",
    maxSteps: 9,
    closingSteps: 9,
  });
  const restored = createDeepAgent({
    model: new ScriptedChatModel(() => {
      resumedModels++;
      return new AIMessage("Approved work complete.");
    }),
    tools: [probe],
    backend: new StateBackend(),
    checkpointer: saver,
    interruptOn: { probe: true },
    middleware: [budget.governance, budget.toolCallRepair, budget.finalization],
  }) as unknown as Agent;
  await restored.invoke({ messages: [] }, opts);
  assert.equal(effects, 0);
  assert.equal(resumedModels, 0);
  const pending = await restored.getState(opts);
  assert.ok(pending.tasks.some((t) => t.interrupts?.length));
  assert.equal(
    selectAgentRunProgress(pending, { userMessageId: "u" })?.steps,
    1,
  );
  const result = await restored.invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    opts,
  );
  assert.equal(effects, 1);
  assert.equal(resumedModels, 1);
  assert.equal(
    selectAgentRunProgress(result, { userMessageId: "u" })?.steps,
    2,
  );
});
test("crash after preparation checkpoint but before readiness does not dispatch or recharge", async () => {
  const { createMiddleware } = await import("langchain");
  const saver = new MemorySaver();
  const opts = { configurable: { thread_id: "prepared-before-ready" } };
  let models = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "verified";
    },
    { name: "probe", description: "verify", schema: z.object({}) },
  );
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "u",
    maxSteps: 1,
    closingSteps: 2,
  });
  const crash = budget.attachBudgetState(
    createMiddleware({
      name: "CrashAfterPreparation",
      afterModel: (state) => {
        if (
          (state as Partial<AgentState>).sourceweftRunStepBudget?.scopes.main!
            .decisionPreparation?.status === "prepared"
        )
          throw new Error("prepared-before-ready-crash");
      },
    }),
  );
  const first = createDeepAgent({
    model: new ScriptedChatModel(() => {
      models++;
      return call("probe", "normal");
    }),
    tools: [probe],
    backend: new StateBackend(),
    checkpointer: saver,
    middleware: [
      budget.governance,
      budget.toolCallRepair,
      crash,
      budget.finalization,
    ],
  }) as unknown as Agent;
  await assert.rejects(
    first.invoke({ messages: [new HumanMessage("work")] }, opts),
    /prepared-before-ready-crash/,
  );
  assert.equal(models, 0);
  assert.equal(effects, 0);
  const state = await first.getState(opts);
  assert.equal(
    state.values.sourceweftRunStepBudget.scopes.main!.decisionPreparation!
      .status,
    "prepared",
  );
  const result = await setup({
    normal: 99,
    closing: 99,
    saver,
    tools: [probe],
    model: new ScriptedChatModel(() =>
      ++models === 1 ? call("probe", "normal") : new AIMessage("Done."),
    ),
  }).invoke({ messages: [] }, opts);
  assert.equal(models, 2);
  assert.equal(effects, 1);
  assert.equal(
    selectAgentRunProgress(result, { userMessageId: "u" })?.steps,
    2,
  );
  assert.equal(
    selectAgentRunProgress(result, { userMessageId: "u" })?.normalLimit,
    1,
  );
});
