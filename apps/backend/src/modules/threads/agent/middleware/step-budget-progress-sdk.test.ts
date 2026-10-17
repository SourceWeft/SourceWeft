import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver, Command, interrupt } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import {
  createMiddleware,
  humanInTheLoopMiddleware,
  type AgentMiddleware,
} from "langchain";
import { test } from "vitest";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import {
  createSourceWeftStepBudgetMiddleware,
  selectAgentRunProgress,
} from "./step-budget";
import { adoptV3RunStream, unwrapCustomEvent } from "../turn/v3-protocol";
type Agent = {
  invoke(input: unknown, options: unknown): Promise<unknown>;
  streamEvents(input: unknown, options: unknown): Promise<unknown>;
};
const call = (id: string, name = "probe") =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args: {} }] });
async function collect(agent: Agent, input: unknown, thread: string) {
  const run = adoptV3RunStream(
    await agent.streamEvents(input, {
      version: "v3",
      configurable: { thread_id: thread },
    }),
  );
  const progress: any[] = [];
  for await (const event of run) {
    const data = unwrapCustomEvent(event.params?.data) as any;
    if (event.method === "custom" && data?.type === "agent-run-progress")
      progress.push(data.progress);
  }
  return { progress, result: await run.output };
}
function build(input: {
  model: ScriptedChatModel;
  saver: MemorySaver;
  tools?: any[];
  hitl?: boolean;
  extra?: (
    budget: ReturnType<typeof createSourceWeftStepBudgetMiddleware>,
  ) => AgentMiddleware[];
}) {
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "u",
    maxSteps: 1,
    closingSteps: 3,
  });
  const interruptOn = input.hitl
    ? {
        probe: {
          allowedDecisions: ["approve" as const],
          when: (request: { toolCall: { id?: string } }) =>
            request.toolCall.id === "closing-gated",
        },
      }
    : undefined;
  return createDeepAgent({
    model: input.model,
    backend: new StateBackend(),
    tools: input.tools ?? [],
    checkpointer: input.saver,
    middleware: [
      budget.governance,
      budget.toolCallRepair,
      ...(input.extra?.(budget) ?? []),
      ...(interruptOn
        ? [budget.guardAfterModel(humanInTheLoopMiddleware({ interruptOn }))]
        : []),
      budget.finalization,
    ],
    ...(interruptOn ? { interruptOn } : {}),
  }) as unknown as Agent;
}
test.each(["ask", "hitl"])(
  "same-user %s checkpoint resume emits current same-phase closing progress",
  async (mode) => {
    const saver = new MemorySaver();
    const thread = `progress-${mode}`;
    const opts = { configurable: { thread_id: thread } };
    let initialCalls = 0,
      resumedCalls = 0,
      effects = 0;
    const probe = tool(
      async () => {
        effects++;
        return "verified";
      },
      { name: "probe", description: "verify", schema: z.object({}) },
    );
    const ask = tool(
      async () => String(interrupt("Clarify the current deliverable.")),
      { name: "ask", description: "clarification", schema: z.object({}) },
    );
    const first = build({
      saver,
      tools: [probe, ask],
      hitl: mode === "hitl",
      model: new ScriptedChatModel(() =>
        ++initialCalls === 1
          ? call("working")
          : call("closing-gated", mode === "ask" ? "ask" : "probe"),
      ),
    });
    await first.invoke(
      { messages: [new HumanMessage("Verify current work.")] },
      opts,
    );
    assert.equal(initialCalls, 2);
    assert.equal(effects, 1);
    const restored = build({
      saver,
      tools: [probe, ask],
      hitl: mode === "hitl",
      model: new ScriptedChatModel(() => {
        resumedCalls++;
        return new AIMessage("Current work complete.");
      }),
    });
    const { progress, result } = await collect(
      restored,
      new Command({
        resume:
          mode === "ask" ? "clarified" : { decisions: [{ type: "approve" }] },
      }),
      thread,
    );
    assert.equal(resumedCalls, 1);
    assert.equal(effects, mode === "hitl" ? 2 : 1);
    assert.deepEqual(
      progress.map((p) => [p.phase, p.normalSteps, p.closingSteps, p.steps]),
      [["closing", 1, 2, 3]],
    );
    assert.equal(
      selectAgentRunProgress(result, { userMessageId: "u" })?.steps,
      3,
    );
  },
);
test.each(["ready", "prepared"])(
  "same-user pending %s preparation restore emits a first observation without recharging",
  async (stage) => {
    const saver = new MemorySaver();
    const thread = `pending-progress-${stage}`;
    const opts = { configurable: { thread_id: thread } };
    let failedCalls = 0,
      resumedCalls = 0;
    const first = build({
      saver,
      model: new ScriptedChatModel(() => {
        failedCalls++;
        throw new Error("provider-failed");
      }),
      extra:
        stage === "prepared"
          ? (budget) => [
              budget.attachBudgetState(
                createMiddleware({
                  name: "CrashPreparedProgress",
                  afterModel: (state) => {
                    if (
                      (state as any).sourceweftRunStepBudget?.scopes.main
                        .decisionPreparation?.status === "prepared"
                    )
                      throw new Error("preparation-crash");
                  },
                }),
              ),
            ]
          : undefined,
    });
    await assert.rejects(
      first.invoke(
        { messages: [new HumanMessage("Finish existing work.")] },
        opts,
      ),
      stage === "prepared" ? /preparation-crash/ : /provider-failed/,
    );
    const restored = build({
      saver,
      model: new ScriptedChatModel(() => {
        resumedCalls++;
        return new AIMessage("Existing work finished.");
      }),
    });
    const { progress, result } = await collect(
      restored,
      { messages: [] },
      thread,
    );
    assert.equal(failedCalls, stage === "prepared" ? 0 : 1);
    assert.equal(resumedCalls, 1);
    assert.deepEqual(
      progress.map((p) => [p.phase, p.normalSteps, p.closingSteps, p.steps]),
      [["working", 1, 0, 1]],
    );
    assert.equal(
      selectAgentRunProgress(result, { userMessageId: "u" })?.steps,
      1,
    );
  },
);
test("a bounded fresh run emits once per root business decision plus its one summary", async () => {
  const saver = new MemorySaver();
  let models = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "saved";
    },
    { name: "probe", description: "save", schema: z.object({}) },
  );
  const model = new ScriptedChatModel((messages) => {
    models++;
    return messages.some(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("business-step budget for this run is exhausted"),
    )
      ? new AIMessage("Four probes ran; publication remains unverified.")
      : call(`probe-${models}`);
  });
  const { progress, result } = await collect(
    build({ saver, model, tools: [probe] }),
    { messages: [new HumanMessage("Keep working until the bounded stop.")] },
    "bounded-progress",
  );
  assert.equal(models, 5);
  assert.equal(effects, 4);
  assert.deepEqual(
    progress.map((p) => [p.phase, p.steps]),
    [
      ["working", 1],
      ["closing", 2],
      ["closing", 3],
      ["closing", 4],
      ["finalizing", 4],
    ],
  );
  assert.equal(progress.length, 1 + 3 + 1);
  assert.equal(
    selectAgentRunProgress(result, { userMessageId: "u" })?.steps,
    4,
  );
});
test("child decisions do not replace or add to root progress observations", async () => {
  const saver = new MemorySaver();
  let roots = 0,
    children = 0,
    effects = 0;
  const rootBudget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "u",
    maxSteps: 2,
    closingSteps: 2,
  });
  const childBudget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "u",
    maxSteps: 1,
    closingSteps: 1,
  });
  const probe = tool(
    async () => {
      effects++;
      return "saved child work";
    },
    { name: "probe", description: "save", schema: z.object({}) },
  );
  const agent = createDeepAgent({
    backend: new StateBackend(),
    checkpointer: saver,
    model: new ScriptedChatModel(() =>
      ++roots === 1
        ? new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "child-task",
                name: "task",
                args: { description: "bounded child", subagent_type: "child" },
              },
            ],
          })
        : new AIMessage("Integrated child work."),
    ),
    middleware: [
      rootBudget.governance,
      rootBudget.toolCallRepair,
      rootBudget.finalization,
    ],
    subagents: [
      {
        name: "child",
        description: "child",
        systemPrompt: "Complete existing child work.",
        tools: [probe],
        model: new ScriptedChatModel(() =>
          ++children === 1
            ? call("child-probe")
            : new AIMessage("Child complete."),
        ),
        middleware: [
          childBudget.governance,
          childBudget.toolCallRepair,
          childBudget.finalization,
        ],
      },
    ],
  }) as unknown as Agent;
  const { progress, result } = await collect(
    agent,
    { messages: [new HumanMessage("Delegate and integrate.")] },
    "root-progress-only",
  );
  assert.equal(roots, 2);
  assert.equal(children, 2);
  assert.equal(effects, 1);
  assert.deepEqual(
    progress.map((p) => [
      p.phase,
      p.normalSteps,
      p.normalLimit,
      p.closingLimit,
    ]),
    [
      ["working", 1, 2, 2],
      ["working", 2, 2, 2],
    ],
  );
  assert.equal(
    selectAgentRunProgress(result, { userMessageId: "u" })?.normalSteps,
    2,
  );
});
