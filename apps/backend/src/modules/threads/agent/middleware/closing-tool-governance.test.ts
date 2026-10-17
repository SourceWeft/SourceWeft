import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createDeepAgent, StateBackend } from "deepagents";
import { test } from "vitest";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import {
  createSourceWeftStepBudgetMiddleware,
  isAgentStepClosing,
  selectAgentStepStop,
} from "./step-budget";
import { createSourceWeftClosingToolGovernanceMiddleware } from "./closing-tool-governance";
import { createCommandToolChoiceMiddleware } from "./command-tool-choice";

type TestAgent = {
  invoke(
    input: unknown,
    options?: { configurable: { thread_id: string } },
  ): Promise<Record<string, any>>;
  getState(options: { configurable: { thread_id: string } }): Promise<{
    values: Record<string, any>;
    tasks: Array<{ interrupts?: unknown[] }>;
  }>;
  updateState(
    options: { configurable: { thread_id: string } },
    update: Record<string, unknown>,
  ): Promise<unknown>;
};
// The SDK's static middleware inference treats defaulted checkpoint channels as
// required public invoke input. Real graphs initialize those channels themselves.
function createTestAgent(
  input: Parameters<typeof createDeepAgent>[0],
): TestAgent {
  return createDeepAgent(input) as unknown as TestAgent;
}

const call = (name: string, id: string, args: Record<string, unknown> = {}) =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args }] });
function stack(normal = 1, closing = 4) {
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "user-1",
    maxSteps: normal,
    closingSteps: closing,
  });
  return {
    budget,
    middleware: [
      budget.governance,
      budget.attachBudgetState(
        createSourceWeftClosingToolGovernanceMiddleware({
          userMessageId: "user-1",
        }),
      ),
      budget.finalization,
    ],
  };
}

test("real SDK closing can verify failure, repair, recheck and publish before natural completion", async () => {
  const effects: string[] = [];
  let valid = false;
  let calls = 0;
  const tools = [
    tool(
      async () => {
        effects.push("verify");
        return valid ? "valid" : "invalid";
      },
      { name: "verify", description: "verify", schema: z.object({}) },
    ),
    tool(
      async () => {
        effects.push("repair");
        valid = true;
        return "fixed";
      },
      { name: "repair", description: "repair", schema: z.object({}) },
    ),
    tool(
      async () => {
        assert(valid);
        effects.push("publish");
        return "committed:version-1";
      },
      { name: "publish", description: "publish", schema: z.object({}) },
    ),
  ];
  const { middleware } = stack(1, 5);
  const model = new ScriptedChatModel(() => {
    calls++;
    return calls === 1
      ? call("verify", "normal-verify")
      : calls === 2
        ? call("verify", "closing-verify")
        : calls === 3
          ? call("repair", "fix")
          : calls === 4
            ? call("verify", "recheck")
            : calls === 5
              ? call("publish", "publish")
              : new AIMessage("Published verified version-1");
  });
  const result = await createTestAgent({
    model,
    tools,
    backend: new StateBackend(),
    middleware,
  }).invoke({ messages: [new HumanMessage("deliver")] });
  assert.deepEqual(effects, [
    "verify",
    "verify",
    "repair",
    "verify",
    "publish",
  ]);
  assert.equal(selectAgentStepStop(result, { userMessageId: "user-1" }), null);
  assert.equal(
    (result as any).sourceweftRunStepBudget.scopes.main.phase,
    "closing",
  );
});

test("closing removes task and capability expansion from advertised tools and rejects hallucinated calls without side effects", async () => {
  let calls = 0,
    effects = 0;
  const bindings: string[][] = [];
  const tools = ["probe", "install_skill", "enable_skill"].map((name) =>
    tool(
      async () => {
        effects++;
        return "ok";
      },
      { name, description: name, schema: z.object({}) },
    ),
  );
  const model = new ScriptedChatModel(() => {
    calls++;
    return calls === 1
      ? call("probe", "normal")
      : calls === 2
        ? call("task", "hallucinated", {
            description: "new",
            subagent_type: "general-purpose",
          })
        : calls === 3
          ? call("install_skill", "install")
          : calls === 4
            ? call("enable_skill", "enable")
            : new AIMessage("done");
  });
  model.bindTools = ((tools: any[]) => {
    bindings.push(tools.map((t) => t.name));
    return model;
  }) as any;
  const result: any = await createTestAgent({
    model,
    tools,
    backend: new StateBackend(),
    middleware: stack(1, 4).middleware,
  }).invoke({ messages: [new HumanMessage("work")] });
  assert(bindings[0]!.includes("task"));
  assert(
    bindings
      .slice(1)
      .every(
        (names) =>
          !names.includes("task") &&
          !names.includes("install_skill") &&
          !names.includes("enable_skill"),
      ),
  );
  assert.equal(effects, 1);
  assert.equal(
    result.messages.filter(
      (m: any) => m instanceof ToolMessage && m.status === "error",
    ).length,
    3,
  );
});

test("command force target yields to auto in closing and freezes full command-authorized surface", async () => {
  let calls = 0;
  const effects: string[] = [];
  const choices: unknown[] = [];
  const tools = ["target", "verify", "blocked"].map((name) =>
    tool(
      async () => {
        effects.push(name);
        return "ok";
      },
      { name, description: name, schema: z.object({}) },
    ),
  );
  const { budget } = stack(1, 2);
  const model = new ScriptedChatModel(() =>
    ++calls === 1
      ? call("target", "target")
      : calls === 2
        ? call("verify", "verify")
        : new AIMessage("done"),
  );
  model.bindTools = ((tools: unknown[], options: any) => {
    choices.push(options?.tool_choice);
    return model;
  }) as any;
  const command = budget.attachBudgetState(
    createCommandToolChoiceMiddleware({
      initialToolPolicy: { kind: "force", toolName: "target" },
      toolPolicy: { deny: ["blocked"] },
    }),
  );
  await createTestAgent({
    model,
    tools,
    backend: new StateBackend(),
    middleware: [
      budget.governance,
      command,
      budget.attachBudgetState(
        createSourceWeftClosingToolGovernanceMiddleware({
          userMessageId: "user-1",
        }),
      ),
      budget.finalization,
    ],
  }).invoke({ messages: [new HumanMessage("work")] });
  assert(choices.some((choice) => choice === "auto"));
  assert.deepEqual(effects, ["target", "verify"]);
});

test("parallel children independently exhaust budgets and return trusted partial task envelopes while parent continues", async () => {
  let parentCalls = 0,
    childCalls = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "ok";
    },
    { name: "probe", description: "probe", schema: z.object({}) },
  );
  const child = new ScriptedChatModel((messages) =>
    messages.some(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("business-step budget for this run is exhausted"),
    )
      ? new AIMessage("Child work remains.")
      : call("probe", `p-${++childCalls}`),
  );
  const parent = new ScriptedChatModel(() =>
    ++parentCalls === 1
      ? new AIMessage({
          content: "",
          tool_calls: [1, 2].map((n) => ({
            id: `task-${n}`,
            name: "task",
            args: { description: `child-${n}`, subagent_type: "child" },
          })),
        })
      : new AIMessage("Parent integrated partial results."),
  );
  const result: any = await createTestAgent({
    model: parent,
    backend: new StateBackend(),
    middleware: stack(2, 1).middleware,
    subagents: [
      {
        name: "child",
        description: "child",
        model: child,
        systemPrompt: "work",
        tools: [probe],
        middleware: stack(1, 1).middleware,
      },
    ],
  }).invoke({ messages: [new HumanMessage("parallel")] });
  assert.equal(effects, 4);
  assert.equal(parentCalls, 2);
  assert.equal(selectAgentStepStop(result, { userMessageId: "user-1" }), null);
  const tasks = result.messages.filter(
    (m: any) => m instanceof ToolMessage && m.name === "task",
  );
  assert.equal(tasks.length, 2);
  for (const task of tasks) {
    const partial = JSON.parse(task.content);
    assert.equal(partial.status, "partial");
    assert.equal(partial.results.length, 1);
    assert.equal(partial.results[0].agentRunStop.steps, 2);
    assert.equal(partial.results[0].agentRunStop.closingSteps, 1);
  }
  assert.equal(Object.keys(result.sourceweftRunStepBudget.scopes).length, 3);
});

test("closing freezes last authorized identities even when a new tool is registered later", async () => {
  let calls = 0;
  const effects: string[] = [];
  const tools = ["probe", "late_tool"].map((name) =>
    tool(
      async () => {
        effects.push(name);
        return "ok";
      },
      { name, description: name, schema: z.object({}) },
    ),
  );
  const { budget } = stack(1, 2);
  const visibility = budget.attachBudgetState(
    createMiddleware({
      name: "Visibility",
      wrapModelCall: async (request, handler) =>
        handler({
          ...request,
          tools: isAgentStepClosing(request.state)
            ? request.tools
            : request.tools.filter((t) => t.name !== "late_tool"),
        }),
    }),
  );
  const model = new ScriptedChatModel(() =>
    ++calls === 1
      ? call("probe", "first")
      : calls === 2
        ? call("late_tool", "late")
        : new AIMessage("done"),
  );
  const result: any = await createTestAgent({
    model,
    tools,
    backend: new StateBackend(),
    middleware: [
      budget.governance,
      visibility,
      budget.attachBudgetState(
        createSourceWeftClosingToolGovernanceMiddleware({
          userMessageId: "user-1",
        }),
      ),
      budget.finalization,
    ],
  }).invoke({ messages: [new HumanMessage("work")] });
  assert.deepEqual(effects, ["probe"]);
  assert(
    result.messages.some(
      (m: any) =>
        m instanceof ToolMessage &&
        m.tool_call_id === "late" &&
        m.status === "error",
    ),
  );
});

test("same trusted tool-call identity replays a stopped child partial without refreshing its budget", async () => {
  let parentCalls = 0,
    effects = 0,
    childCalls = 0;
  const probe = tool(
    async () => {
      effects++;
      return "ok";
    },
    { name: "probe", description: "probe", schema: z.object({}) },
  );
  const child = new ScriptedChatModel((messages) =>
    messages.some(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("business-step budget for this run is exhausted"),
    )
      ? new AIMessage("Partial child.")
      : call("probe", `child-${++childCalls}`),
  );
  const parent = new ScriptedChatModel(() =>
    ++parentCalls <= 2
      ? call("task", "same-native-call", {
          description: "same child",
          subagent_type: "child",
        })
      : new AIMessage("done"),
  );
  const result: any = await createTestAgent({
    model: parent,
    backend: new StateBackend(),
    middleware: stack(3, 1).middleware,
    subagents: [
      {
        name: "child",
        description: "child",
        model: child,
        systemPrompt: "work",
        tools: [probe],
        middleware: stack(1, 1).middleware,
      },
    ],
  }).invoke({ messages: [new HumanMessage("repeat")] });
  assert.equal(effects, 2);
  assert.equal(parentCalls, 3);
  assert.equal(Object.keys(result.sourceweftRunStepBudget.scopes).length, 2);
  const tasks = result.messages.filter(
    (m: any) => m instanceof ToolMessage && m.name === "task",
  );
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].content, tasks[1].content);
});

test("duplicate task identities in one SDK decision reject both children before effects", async () => {
  let parentCalls = 0,
    childCalls = 0;
  const child = new ScriptedChatModel(() => {
    childCalls++;
    return new AIMessage("child must not start");
  });
  const parent = new ScriptedChatModel(() =>
    ++parentCalls === 1
      ? new AIMessage({
          content: "",
          tool_calls: [1, 2].map((n) => ({
            id: "duplicate-task",
            name: "task",
            args: { description: `child-${n}`, subagent_type: "child" },
          })),
        })
      : new AIMessage("duplicate requests rejected"),
  );
  const result: any = await createTestAgent({
    model: parent,
    backend: new StateBackend(),
    middleware: stack(2, 1).middleware,
    subagents: [
      {
        name: "child",
        description: "child",
        systemPrompt: "work",
        model: child,
        tools: [],
        middleware: stack(1, 1).middleware,
      },
    ],
  }).invoke({ messages: [new HumanMessage("duplicate")] });
  assert.equal(childCalls, 0);
  const rejected = result.messages.filter(
    (message: any) =>
      message instanceof ToolMessage &&
      message.tool_call_id === "duplicate-task",
  );
  assert.equal(rejected.length, 2);
  assert(
    rejected.every(
      (message: any) =>
        message.status === "error" &&
        message.content.includes("AGENT_TASK_IDENTITY_DUPLICATE"),
    ),
  );
  assert.equal(Object.keys(result.sourceweftRunStepBudget.scopes).length, 1);
});

test("a new trusted user turn prunes old partial task replay records", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  const options = {
    configurable: { thread_id: "partial-cache-turn-boundary" },
  };
  const oldKey = JSON.stringify(["user-old", "main", "task-old"]);
  const oldBudget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "user-old",
    maxSteps: 1,
    closingSteps: 1,
  });
  const oldAgent = createTestAgent({
    model: new ScriptedChatModel(() => new AIMessage("done")),
    backend: new StateBackend(),
    checkpointer: saver,
    middleware: [
      oldBudget.governance,
      oldBudget.attachBudgetState(
        createSourceWeftClosingToolGovernanceMiddleware({
          userMessageId: "user-old",
        }),
      ),
      oldBudget.finalization,
    ],
  });
  await oldAgent.invoke(
    { messages: [new HumanMessage({ id: "user-old", content: "old" })] },
    options,
  );
  await oldAgent.updateState(options, {
    sourceweftPartialTaskResults: {
      [oldKey]: JSON.stringify({ status: "partial" }),
    },
  });
  assert.equal(
    Object.keys(
      (await oldAgent.getState(options)).values.sourceweftPartialTaskResults,
    ).length,
    1,
  );
  const nextBudget = createSourceWeftStepBudgetMiddleware({
    userMessageId: "user-new",
    maxSteps: 1,
    closingSteps: 1,
  });
  const nextAgent = createTestAgent({
    model: new ScriptedChatModel(() => new AIMessage("new turn done")),
    backend: new StateBackend(),
    checkpointer: saver,
    middleware: [
      nextBudget.governance,
      nextBudget.attachBudgetState(
        createSourceWeftClosingToolGovernanceMiddleware({
          userMessageId: "user-new",
        }),
      ),
      nextBudget.finalization,
    ],
  });
  const result: any = await nextAgent.invoke(
    { messages: [new HumanMessage({ id: "user-new", content: "new" })] },
    options,
  );
  assert.deepEqual(result.sourceweftPartialTaskResults, {});
  assert.equal(result.sourceweftRunStepBudget.userMessageId, "user-new");
});
