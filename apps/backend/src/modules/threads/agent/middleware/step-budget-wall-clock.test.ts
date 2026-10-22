import assert from "node:assert/strict";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { MemorySaver, Command, interrupt } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { createMiddleware, type AgentMiddleware } from "langchain";
import { test } from "vitest";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import {
  createSourceWeftStepBudgetMiddleware,
  currentAgentStepScope,
  selectAgentRunProgress,
  selectAgentStepStop,
  type AgentStepBudgetState,
  type AgentStepV2ScopeBudget,
} from "./step-budget";

// Run-level wall clock (M3): the working clock turns the current call into the
// last normal decision, the closing clock exhausts the closing allowance, and
// both are keyed by the durable run so a resumed run restarts timing.
type AgentOptions = {
  configurable?: { thread_id: string };
  recursionLimit?: number;
};
type AgentState = {
  messages: BaseMessage[];
  sourceweftRunStepBudget: AgentStepBudgetState;
};
type Agent = {
  invoke(input: unknown, options?: AgentOptions): Promise<AgentState>;
  getState(
    options: AgentOptions,
  ): Promise<{ values: AgentState; tasks: unknown[] }>;
};
/** The governance `beforeAgent` hook as the v1 seeding wrapper calls it. */
type BudgetBeforeAgent = (
  state: {
    sourceweftRunStepBudget?: { scopes?: Record<string, unknown> } | null;
  },
  runtime: unknown,
) => Record<string, unknown> | undefined;
const MINUTE = 60_000;
const WORKING_MS = 45 * MINUTE;
const CLOSING_MS = 10 * MINUTE;
const CLOSING_MARKER = "You have entered bounded delivery closing";
const SUMMARY_MARKER = "business-step budget for this run is exhausted";
const call = (name: string, id: string) =>
  new AIMessage({ content: "", tool_calls: [{ name, id, args: {} }] });
const hasText = (messages: BaseMessage[], marker: string) =>
  messages.some(
    (m) => typeof m.content === "string" && m.content.includes(marker),
  );
const closingRemaining = (messages: BaseMessage[]) => {
  const system = messages.find(
    (m) => typeof m.content === "string" && m.content.includes(CLOSING_MARKER),
  );
  const match =
    /Remaining closing decisions \(including this one\): (\d+)/.exec(
      String(system?.content ?? ""),
    );
  return match ? Number(match[1]) : null;
};
function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (ms: number) => void (t = ms) };
}
function probeTool(onEffect?: () => void) {
  return tool(
    async () => {
      onEffect?.();
      return "saved";
    },
    { name: "probe", description: "save", schema: z.object({}) },
  );
}
function budgetFor(input: {
  uid?: string;
  runId?: string | null;
  normal?: number;
  closing?: number;
  now: () => number;
  turnStartedAtMs?: number | null;
}) {
  return createSourceWeftStepBudgetMiddleware({
    userMessageId: input.uid ?? "u",
    maxSteps: input.normal ?? 400,
    closingSteps: input.closing ?? 40,
    runId: input.runId === undefined ? "run-1" : input.runId,
    wallClock: { workingMs: WORKING_MS, closingMs: CLOSING_MS },
    now: input.now,
    turnStartedAtMs: input.turnStartedAtMs,
  });
}
/** Records the budget each model call ran under, as the progress projection. */
function progressObserver(
  budget: ReturnType<typeof createSourceWeftStepBudgetMiddleware>,
  seen: Array<ReturnType<typeof selectAgentRunProgress>>,
  uid = "u",
): AgentMiddleware {
  return budget.attachBudgetState(
    createMiddleware({
      name: "ProgressObserver",
      wrapModelCall: async (request, handler) => {
        const response = await handler(request);
        if (AIMessage.isInstance(response))
          seen.push(
            selectAgentRunProgress(request.state, { userMessageId: uid }),
          );
        return response;
      },
    }),
  );
}
function agentFor(input: {
  budget: ReturnType<typeof createSourceWeftStepBudgetMiddleware>;
  model: ScriptedChatModel;
  tools?: StructuredToolInterface[];
  saver?: MemorySaver;
  observer?: AgentMiddleware;
}) {
  return createDeepAgent({
    model: input.model,
    tools: input.tools ?? [],
    backend: new StateBackend(),
    middleware: [
      input.budget.governance,
      input.budget.toolCallRepair,
      ...(input.observer ? [input.observer] : []),
      input.budget.finalization,
    ],
    ...(input.saver ? { checkpointer: input.saver } : {}),
  }) as unknown as Agent;
}
const mainScope = (state: AgentState) =>
  state.sourceweftRunStepBudget.scopes.main as AgentStepV2ScopeBudget;

test("44:59 stays working; 45:00 makes the call the last normal decision and the next call runs closing with CLOSING_PROMPT and closingToolIds; closing +10:00 finalizes with a step_limit stop", async () => {
  const time = clock();
  let effects = 0,
    calls = 0,
    summaryCalls = 0;
  const closingPrompts: Array<number | null> = [];
  const model = new ScriptedChatModel((messages) => {
    calls++;
    if (hasText(messages, SUMMARY_MARKER)) {
      summaryCalls++;
      return new AIMessage("Progress saved; publication unverified.");
    }
    if (hasText(messages, CLOSING_MARKER))
      closingPrompts.push(closingRemaining(messages));
    // Time advances inside the model call; the next beforeModel observes it.
    if (calls === 1) time.set(WORKING_MS - 1_000);
    if (calls === 2) time.set(WORKING_MS);
    if (calls === 4) time.set(WORKING_MS + CLOSING_MS);
    return call("probe", `p${calls}`);
  });
  const budget = budgetFor({ now: time.now });
  const seen: Array<ReturnType<typeof selectAgentRunProgress>> = [];
  const result = await agentFor({
    budget,
    model,
    tools: [probeTool(() => effects++)],
    observer: progressObserver(budget, seen),
  }).invoke({ messages: [new HumanMessage("work")] }, { recursionLimit: 200 });
  assert.equal(calls, 5);
  assert.equal(effects, 4);
  assert.equal(summaryCalls, 1);
  // Call 3 became the last normal decision without a closing prompt; call 4 is
  // the first closing decision with the full closing allowance announced.
  assert.deepEqual(
    seen.map((p) => [p?.phase, p?.normalSteps, p?.closingSteps, p?.steps]),
    [
      ["working", 1, 0, 1],
      ["working", 2, 0, 2],
      ["working", 400, 0, 400],
      ["closing", 400, 1, 401],
      ["finalizing", 400, 40, 440],
    ],
  );
  assert.deepEqual(closingPrompts, [40]);
  // The closing tool snapshot is the advertised set of the last normal
  // decision (deep-agent builtins plus the bound probe), sorted.
  const closingToolIds = mainScope(result).closingToolIds!;
  assert.ok(closingToolIds.includes("probe"));
  assert.deepEqual(closingToolIds, [...closingToolIds].sort());
  assert.deepEqual(closingToolIds, mainScope(result).availableToolIds);
  assert.deepEqual(mainScope(result).wallClock, {
    runId: "run-1",
    startedAtMs: 0,
    closingStartedAtMs: WORKING_MS,
    trigger: "wall_clock",
  });
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
});

test("the closing clock starts at the first closing decision, not at the working expiry", async () => {
  const time = clock();
  let calls = 0,
    summaryCalls = 0;
  const model = new ScriptedChatModel((messages) => {
    calls++;
    if (hasText(messages, SUMMARY_MARKER)) {
      summaryCalls++;
      return new AIMessage("Summary.");
    }
    // Working expires at call 2; the first closing decision (call 3) happens
    // 9 minutes later, so closing still has its full 10 minutes from there.
    if (calls === 1) time.set(WORKING_MS);
    if (calls === 2) time.set(WORKING_MS + 9 * MINUTE);
    if (calls === 3) time.set(WORKING_MS + 9 * MINUTE + CLOSING_MS - 1);
    if (calls === 4) time.set(WORKING_MS + 9 * MINUTE + CLOSING_MS);
    return call("probe", `p${calls}`);
  });
  const budget = budgetFor({ now: time.now });
  const seen: Array<ReturnType<typeof selectAgentRunProgress>> = [];
  await agentFor({
    budget,
    model,
    tools: [probeTool()],
    observer: progressObserver(budget, seen),
  }).invoke({ messages: [new HumanMessage("work")] }, { recursionLimit: 200 });
  assert.equal(summaryCalls, 1);
  assert.deepEqual(
    seen.map((p) => [p?.phase, p?.closingSteps]),
    [
      ["working", 0],
      ["working", 0],
      ["closing", 1],
      ["closing", 2],
      ["finalizing", 40],
    ],
  );
});

test.each([null, "run-1"])(
  "a checkpoint whose clock belongs to run %j restarts timing under a new runId, while the same runId keeps its origin",
  async (initialRunId) => {
    const pause = tool(
      async () => {
        const answer = interrupt("approval");
        return String(answer);
      },
      { name: "pause", description: "pause", schema: z.object({}) },
    );
    const runFirst = async (saver: MemorySaver, opts: AgentOptions) => {
      const time = clock();
      let calls = 0;
      const first = agentFor({
        budget: budgetFor({ now: time.now, runId: initialRunId }),
        saver,
        tools: [probeTool(), pause],
        model: new ScriptedChatModel(() => {
          calls++;
          if (calls === 1) time.set(30 * MINUTE);
          return calls === 1 ? call("probe", "p1") : call("pause", "a");
        }),
      });
      await first.invoke({ messages: [new HumanMessage("work")] }, opts);
      const state = await first.getState(opts);
      assert.equal(state.tasks.length, 1);
      assert.deepEqual(
        mainScope(state.values).wallClock,
        initialRunId ? { runId: "run-1", startedAtMs: 0 } : undefined,
      );
    };
    const resume = async (runId: string) => {
      const saver = new MemorySaver();
      const opts = { configurable: { thread_id: `resume-${runId}` } };
      await runFirst(saver, opts);
      const time = clock(50 * MINUTE);
      const seen: Array<ReturnType<typeof selectAgentRunProgress>> = [];
      const budget = budgetFor({ now: time.now, runId });
      const restored = agentFor({
        budget,
        saver,
        tools: [probeTool(), pause],
        observer: progressObserver(budget, seen),
        model: new ScriptedChatModel(() => new AIMessage("done")),
      });
      const result = await restored.invoke(
        new Command({ resume: "yes" }),
        opts,
      );
      return { seen, scope: mainScope(result) };
    };
    // New run: waiting time is not charged; the clock restarts at resume time.
    const fresh = await resume("run-2");
    assert.deepEqual(
      fresh.seen.map((p) => [p?.phase, p?.normalSteps]),
      [["working", 3]],
    );
    assert.deepEqual(fresh.scope.wallClock, {
      runId: "run-2",
      startedAtMs: 50 * MINUTE,
    });
    if (!initialRunId) return;
    // Same runId (the clock's own run): the origin stands and 50 minutes have
    // elapsed, so the resumed call is the last normal decision. In production
    // a durable run is never re-executed, so this only guards the keying.
    const same = await resume("run-1");
    assert.deepEqual(
      same.seen.map((p) => [p?.phase, p?.normalSteps]),
      [["working", 400]],
    );
    assert.deepEqual(same.scope.wallClock, {
      runId: "run-1",
      startedAtMs: 0,
      trigger: "wall_clock",
    });
  },
);

test("a legacy v1 scope keeps its two-stage policy and never gains a clock", async () => {
  const time = clock(10 * 60 * MINUTE);
  let calls = 0,
    summaryCalls = 0;
  const budget = budgetFor({ now: time.now, normal: 400, closing: 40 });
  // Seed the persisted v1 budget the way the historical suite does.
  const original = budget.governance
    .beforeAgent as unknown as BudgetBeforeAgent;
  const seedV1: BudgetBeforeAgent = (state, runtime) => {
    const initialized = original(state, runtime);
    if (state.sourceweftRunStepBudget?.scopes?.[currentAgentStepScope()])
      return initialized;
    return {
      ...initialized,
      sourceweftRunStepBudget: {
        userMessageId: "u",
        scopes: {
          [currentAgentStepScope()]: { steps: 0, limit: 2, summary: "unused" },
        },
      },
    };
  };
  budget.governance.beforeAgent =
    seedV1 as unknown as typeof budget.governance.beforeAgent;
  const result = await agentFor({
    budget,
    tools: [probeTool()],
    model: new ScriptedChatModel((messages) => {
      calls++;
      if (hasText(messages, SUMMARY_MARKER)) {
        summaryCalls++;
        return new AIMessage("Summary.");
      }
      return call("probe", `p${calls}`);
    }),
  }).invoke({ messages: [new HumanMessage("work")] });
  assert.equal(calls, 3);
  assert.equal(summaryCalls, 1);
  const scope = result.sourceweftRunStepBudget.scopes.main!;
  assert.equal("policyVersion" in scope, false);
  assert.equal("wallClock" in scope, false);
  assert.deepEqual(
    selectAgentStepStop(result, { userMessageId: "u" })?.agentRunStop,
    {
      reason: "step_limit",
      steps: 2,
      limit: 2,
      canContinue: true,
      summaryStatus: "completed",
    },
  );
});

test.each([true, false])(
  "a child scope created late in the run measures from the run origin when turnStartedAtMs is passed (%s)",
  async (shareOrigin) => {
    const time = clock();
    let parentCalls = 0,
      childCalls = 0,
      childSummaries = 0;
    const origin = shareOrigin ? 0 : undefined;
    const childBudget = budgetFor({
      now: time.now,
      normal: 5,
      closing: 2,
      turnStartedAtMs: origin,
    });
    const parentBudget = budgetFor({
      now: time.now,
      normal: 5,
      closing: 2,
      turnStartedAtMs: origin,
    });
    const agent = createDeepAgent({
      model: new ScriptedChatModel(() => {
        parentCalls++;
        if (parentCalls === 1) {
          // The child is spawned 30 seconds before the run's working clock ends.
          time.set(WORKING_MS - 30_000);
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "task-1",
                name: "task",
                args: { description: "late", subagent_type: "child" },
              },
            ],
          });
        }
        return new AIMessage("Integrated.");
      }),
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
          model: new ScriptedChatModel((messages) => {
            childCalls++;
            if (hasText(messages, SUMMARY_MARKER)) {
              childSummaries++;
              return new AIMessage("Partial saved.");
            }
            if (childCalls === 1) time.set(WORKING_MS);
            return childCalls >= 3
              ? new AIMessage("child done")
              : call("probe", `c${childCalls}`);
          }),
          tools: [probeTool()],
          middleware: [
            childBudget.governance,
            childBudget.toolCallRepair,
            childBudget.finalization,
          ],
        },
      ],
    }) as unknown as Agent;
    const result = await agent.invoke(
      { messages: [new HumanMessage("delegate")] },
      { recursionLimit: 200 },
    );
    const scopes = result.sourceweftRunStepBudget.scopes as Record<
      string,
      AgentStepV2ScopeBudget
    >;
    const child = Object.entries(scopes).find(([scope]) => scope !== "main")!;
    assert.ok(child);
    if (shareOrigin) {
      // Origin 0 from the run: the child's second call is its last normal
      // decision and the third runs closing.
      assert.deepEqual(child[1].wallClock, {
        runId: "run-1",
        startedAtMs: 0,
        closingStartedAtMs: WORKING_MS,
        trigger: "wall_clock",
      });
      assert.equal(child[1].normalSteps, 5);
      assert.equal(child[1].phase, "closing");
      assert.equal(child[1].closingSteps, 1);
      assert.equal(childSummaries, 0);
    } else {
      // Without a shared origin the child clock starts when it is spawned.
      assert.deepEqual(child[1].wallClock, {
        runId: "run-1",
        startedAtMs: WORKING_MS - 30_000,
      });
      assert.equal(child[1].normalSteps, 3);
      assert.equal(child[1].phase, "working");
    }
    assert.equal(childCalls, 3);
  },
);

test("wall-clock limits and the run origin are validated like the step limits", () => {
  for (const wallClock of [
    { workingMs: 0, closingMs: CLOSING_MS },
    { workingMs: WORKING_MS, closingMs: -1 },
    { workingMs: 1.5, closingMs: CLOSING_MS },
    { workingMs: Number.NaN, closingMs: CLOSING_MS },
  ])
    assert.throws(
      () =>
        createSourceWeftStepBudgetMiddleware({ userMessageId: "u", wallClock }),
      /Invalid agent wall-clock limits/,
    );
  for (const turnStartedAtMs of [-1, 0.5, Number.NaN])
    assert.throws(
      () =>
        createSourceWeftStepBudgetMiddleware({
          userMessageId: "u",
          turnStartedAtMs,
        }),
      /Invalid agent run start time/,
    );
  assert.doesNotThrow(() =>
    createSourceWeftStepBudgetMiddleware({
      userMessageId: "u",
      runId: "run-1",
      turnStartedAtMs: null,
    }),
  );
});
