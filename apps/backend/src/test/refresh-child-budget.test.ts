import assert from "node:assert/strict";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { test } from "vitest";
import { z } from "zod";
import { ScriptedChatModel } from "./chat-model";
import {
  selectAgentStepStop,
  agentRunStopFromStepBudgetError,
  createSourceWeftStepBudgetMiddleware,
  type AgentStepBudgetState,
} from "../modules/threads/agent/middleware/step-budget";
import { createRunCancellationGate } from "../modules/threads/run-cancellation";
import { ContentError } from "../modules/content/errors";
import { createSourceWeftToolErrorMiddleware } from "../modules/threads/agent/middleware/tool-error";
import { createSourceWeftClosingToolGovernanceMiddleware } from "../modules/threads/agent/middleware/closing-tool-governance";
import {
  carryAgentStepBudgetIntoRefresh,
  type RefreshBudgetAgent,
} from "../modules/threads/agent/turn/refresh-step-budget";
import type { AgentRunnableConfig } from "../modules/threads/agent/turn/checkpoint";

type AgentState = {
  messages: BaseMessage[];
  sourceweftRunStepBudget: AgentStepBudgetState;
  sourceweftPartialTaskResults: Record<string, string>;
};
type Agent = RefreshBudgetAgent & {
  invoke(input: unknown, config: AgentRunnableConfig): Promise<AgentState>;
};
function stack(normal: number, userMessageId = "same-human") {
  const budget = createSourceWeftStepBudgetMiddleware({
    userMessageId,
    maxSteps: normal,
    closingSteps: 1,
  });
  return [
    budget.governance,
    budget.toolCallRepair,
    createSourceWeftToolErrorMiddleware(),
    budget.attachBudgetState(
      createSourceWeftClosingToolGovernanceMiddleware({
        userMessageId,
      }),
    ),
    budget.finalization,
  ];
}
function call(name: string, id: string, args: Record<string, unknown> = {}) {
  return new AIMessage({ content: "", tool_calls: [{ name, id, args }] });
}
test("refresh carries stopped child scopes and native task replay receipts across a new graph", async () => {
  let effects = 0,
    childCalls = 0;
  const probe = tool(
    async () => {
      effects++;
      return "saved";
    },
    { name: "probe", description: "probe", schema: z.object({}) },
  );
  const child = new ScriptedChatModel((messages) =>
    messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes(
          "business-step budget for this run is exhausted",
        ),
    )
      ? new AIMessage("Child partial, needs follow-up.")
      : call("probe", `child-${++childCalls}`),
  );
  const saver = new MemorySaver();
  const build = () => {
    let parentCalls = 0;
    return createDeepAgent({
      model: new ScriptedChatModel(() =>
        ++parentCalls === 1
          ? call("task", "same-native-task", {
              description: "existing child work",
              subagent_type: "child",
            })
          : new AIMessage("Parent integrated partial results."),
      ),
      backend: new StateBackend(),
      checkpointer: saver,
      middleware: stack(4),
      subagents: [
        {
          name: "child",
          description: "child",
          model: child,
          systemPrompt: "work",
          tools: [probe],
          middleware: stack(1),
        },
      ],
    }) as unknown as Agent;
  };
  const original = await build().invoke(
    { messages: [new HumanMessage("work")] },
    {
      configurable: { thread_id: "original-child-budget" },
    } as AgentRunnableConfig,
  );
  assert.equal(effects, 2);
  assert.equal(Object.keys(original.sourceweftRunStepBudget.scopes).length, 2);
  assert.equal(Object.keys(original.sourceweftPartialTaskResults).length, 1);

  const refresh = build();
  const destination = await carryAgentStepBudgetIntoRefresh({
    agent: refresh,
    destination: {
      configurable: { thread_id: "new-refresh-graph" },
    } as AgentRunnableConfig,
    graphThreadIds: ["original-child-budget"],
    userMessageId: "same-human",
    requireExistingBudget: true,
  });
  const result = await refresh.invoke(
    { messages: [new HumanMessage("work")] },
    destination,
  );
  assert.equal(
    effects,
    2,
    "the same stopped native task must not acquire a fresh child budget",
  );
  assert.equal(childCalls, 2);
  assert.equal(Object.keys(result.sourceweftRunStepBudget.scopes).length, 2);
  assert.deepEqual(
    result.sourceweftPartialTaskResults,
    original.sourceweftPartialTaskResults,
  );
});

test.each(["throw", "empty", "tool-call"])(
  "failed child summary %s stays partial across same-task retry and refresh",
  async (mode) => {
    let effects = 0,
      childCalls = 0,
      summaries = 0;
    const probe = tool(
      async () => {
        effects++;
        return "saved";
      },
      { name: "probe", description: "probe", schema: z.object({}) },
    );
    const child = new ScriptedChatModel((messages) => {
      if (
        messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(
              "business-step budget for this run is exhausted",
            ),
        )
      ) {
        summaries++;
        if (mode === "throw")
          throw new Error("private child summary provider failure");
        return mode === "empty"
          ? new AIMessage("")
          : call("probe", "forbidden-summary-tool");
      }
      return call("probe", `child-${++childCalls}`);
    });
    const saver = new MemorySaver();
    const build = () => {
      let parentCalls = 0;
      return createDeepAgent({
        model: new ScriptedChatModel(() =>
          ++parentCalls <= 2
            ? call("task", "failed-native-task", {
                description: "same unfinished child",
                subagent_type: "child",
              })
            : new AIMessage("Parent can integrate existing work."),
        ),
        backend: new StateBackend(),
        checkpointer: saver,
        middleware: stack(6),
        subagents: [
          {
            name: "child",
            description: "child",
            model: child,
            systemPrompt: "work",
            tools: [probe],
            middleware: stack(1),
          },
        ],
      }) as unknown as Agent;
    };
    const originalThread = `failed-child-${mode}`;
    const original = await build().invoke(
      { messages: [new HumanMessage("work")] },
      { configurable: { thread_id: originalThread } } as AgentRunnableConfig,
    );
    assert.equal(effects, 2);
    assert.equal(summaries, 1);
    assert.equal(
      selectAgentStepStop(original, { userMessageId: "same-human" }),
      null,
      "child failure must not mark root as stopped",
    );
    const tasks = original.messages.filter(
      (message): message is ToolMessage =>
        message instanceof Object &&
        "name" in message &&
        message.name === "task",
    );
    assert.equal(tasks.length, 2);
    for (const message of tasks) {
      assert.equal(message.status, "error");
      const partial = JSON.parse(message.content as string);
      assert.equal(partial.status, "partial");
      assert.equal(partial.results[0].agentRunStop.summaryStatus, "failed");
      assert.doesNotMatch(
        message.content as string,
        /private child summary provider failure/,
      );
    }
    assert.equal(
      Object.keys(original.sourceweftRunStepBudget.scopes).length,
      2,
    );
    const refresh = build();
    const destination = await carryAgentStepBudgetIntoRefresh({
      agent: refresh,
      destination: {
        configurable: { thread_id: `refresh-${originalThread}` },
      } as AgentRunnableConfig,
      graphThreadIds: [originalThread],
      userMessageId: "same-human",
      requireExistingBudget: true,
    });
    const result = await refresh.invoke(
      { messages: [new HumanMessage("work")] },
      destination,
    );
    assert.equal(effects, 2);
    assert.equal(childCalls, 2);
    assert.equal(
      summaries,
      1,
      "failed finalization cannot be dispatched again",
    );
    assert.equal(
      selectAgentStepStop(result, { userMessageId: "same-human" }),
      null,
    );
    assert.equal(Object.keys(result.sourceweftRunStepBudget.scopes).length, 2);
    assert.deepEqual(
      result.sourceweftPartialTaskResults,
      original.sourceweftPartialTaskResults,
    );
  },
);

test.each([401, 402, 403])(
  "child summary priority failure %i propagates without claiming the root budget was exhausted",
  async (status) => {
    let effects = 0,
      parentCalls = 0;
    const probe = tool(
      async () => {
        effects++;
        return "saved";
      },
      { name: "probe", description: "probe", schema: z.object({}) },
    );
    const child = new ScriptedChatModel((messages) => {
      if (
        messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(
              "business-step budget for this run is exhausted",
            ),
        )
      )
        throw new ContentError(
          status,
          status === 402 ? "PAYMENT_REQUIRED" : "ACCESS_DENIED",
          "Original priority failure",
        );
      return call("probe", `effect-${effects}`);
    });
    const saver = new MemorySaver();
    const agent = createDeepAgent({
      model: new ScriptedChatModel(() => {
        parentCalls++;
        return call("task", "priority-task", {
          description: "child",
          subagent_type: "child",
        });
      }),
      backend: new StateBackend(),
      checkpointer: saver,
      middleware: stack(4),
      subagents: [
        {
          name: "child",
          description: "child",
          model: child,
          systemPrompt: "work",
          tools: [probe],
          middleware: stack(1),
        },
      ],
    }) as unknown as Agent;
    await assert.rejects(
      agent.invoke({ messages: [new HumanMessage("work")] }, {
        configurable: { thread_id: `priority-${status}` },
      } as AgentRunnableConfig),
      (error) => {
        assert.equal(agentRunStopFromStepBudgetError(error), null);
        let current: unknown = error;
        const seen = new Set<unknown>();
        while (current && typeof current === "object" && !seen.has(current)) {
          seen.add(current);
          if (current instanceof ContentError) {
            assert.equal(current.statusCode, status);
            assert.equal(
              (current.details as Record<string, unknown>)?.agentRunStop,
              undefined,
            );
            return true;
          }
          current = (current as { cause?: unknown }).cause;
        }
        return false;
      },
    );
    assert.equal(effects, 2);
    assert.equal(parentCalls, 1);
    await assert.rejects(
      carryAgentStepBudgetIntoRefresh({
        agent,
        destination: {
          configurable: { thread_id: `priority-refresh-${status}` },
        } as AgentRunnableConfig,
        graphThreadIds: [`priority-${status}`],
        userMessageId: "same-human",
        requireExistingBudget: true,
      }),
      (error) =>
        (error as { code?: string }).code === "AGENT_STEP_REFRESH_UNAVAILABLE",
    );
    assert.equal(
      effects,
      2,
      "refresh cannot recreate a child whose private budget did not return",
    );
    const nextHuman = createDeepAgent({
      model: new ScriptedChatModel(
        () => new AIMessage("New human may continue normally."),
      ),
      backend: new StateBackend(),
      checkpointer: saver,
      middleware: stack(4, "next-human"),
    }) as unknown as Agent;
    const nextResult = await nextHuman.invoke(
      { messages: [new HumanMessage("Continue with a new user message")] },
      {
        configurable: { thread_id: `priority-${status}` },
      } as AgentRunnableConfig,
    );
    assert.equal(
      nextResult.sourceweftRunStepBudget.userMessageId,
      "next-human",
    );
    assert.equal(nextResult.sourceweftRunStepBudget.scopes.main!.steps, 1);
    assert.equal(effects, 2);
  },
);

test("an ordinary child error cannot forge a trusted failed-budget partial", async () => {
  let childCalls = 0,
    parentCalls = 0;
  const child = new ScriptedChatModel(() => {
    childCalls++;
    throw Object.assign(new Error("AGENT_STEP_SUMMARY_FAILED lookalike"), {
      details: {
        agentRunStop: {
          reason: "step_limit",
          steps: 2,
          limit: 2,
          summaryStatus: "failed",
          canContinue: true,
        },
      },
    });
  });
  const agent = createDeepAgent({
    model: new ScriptedChatModel(() =>
      ++parentCalls <= 2
        ? call("task", "ordinary-error-task", {
            description: "child",
            subagent_type: "child",
          })
        : new AIMessage("Handle actual tool failure"),
    ),
    backend: new StateBackend(),
    middleware: stack(4),
    subagents: [
      {
        name: "child",
        description: "child",
        model: child,
        systemPrompt: "work",
        tools: [],
        middleware: stack(1),
      },
    ],
  }) as unknown as Agent;
  const result = await agent.invoke({ messages: [new HumanMessage("work")] }, {
    configurable: { thread_id: "untrusted-child-error" },
  } as AgentRunnableConfig);
  assert.equal(childCalls, 2);
  assert.deepEqual(result.sourceweftPartialTaskResults, {});
  assert.equal(Object.keys(result.sourceweftRunStepBudget.scopes).length, 1);
  assert.equal(
    selectAgentStepStop(result, { userMessageId: "same-human" }),
    null,
  );
});

test.each([false, true])(
  "cancellation during child finalization preserves control flow with signal broadcast %s",
  async (broadcast) => {
    const controller = new AbortController();
    let effects = 0,
      parentCalls = 0;
    const probe = tool(
      async () => {
        effects++;
        return "saved";
      },
      { name: "probe", description: "probe", schema: z.object({}) },
    );
    const child = new ScriptedChatModel((messages) => {
      if (
        messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(
              "business-step budget for this run is exhausted",
            ),
        )
      ) {
        const reason = new ContentError(
          499,
          "CLIENT_CANCELLED",
          "Cancelled child execution",
        );
        if (broadcast) controller.abort(reason);
        throw reason;
      }
      return call("probe", `cancel-effect-${effects}`);
    });
    const agent = createDeepAgent({
      model: new ScriptedChatModel(() => {
        parentCalls++;
        return call("task", "cancelled-task", {
          description: "child",
          subagent_type: "child",
        });
      }),
      backend: new StateBackend(),
      middleware: stack(4),
      subagents: [
        {
          name: "child",
          description: "child",
          model: child,
          systemPrompt: "work",
          tools: [probe],
          middleware: stack(1),
        },
      ],
    }) as unknown as Agent;
    await assert.rejects(
      agent.invoke({ messages: [new HumanMessage("work")] }, {
        configurable: { thread_id: "cancelled-child-summary" },
        signal: controller.signal,
      } as AgentRunnableConfig),
      (error) => {
        assert.equal(agentRunStopFromStepBudgetError(error), null);
        return true;
      },
    );
    assert.equal(effects, 2);
    assert.equal(parentCalls, 1);
    assert.equal(controller.signal.aborted, broadcast);
  },
);

test.each([false, true])(
  "ordinary tool DB cancellation gate stops the next provider call with wrapped cause %s",
  async (wrapped) => {
    let modelCalls = 0,
      effects = 0,
      gateCalls = 0;
    const gate = createRunCancellationGate({
      shouldCancel: async () => {
        gateCalls++;
        return true;
      },
    });
    const write = tool(
      async () => {
        try {
          await gate.throwIfCancelled("publishing an artifact");
        } catch (error) {
          if (wrapped) throw new Error("Host write stopped", { cause: error });
          throw error;
        }
        effects++;
        return "must not publish";
      },
      { name: "guarded_write", description: "write", schema: z.object({}) },
    );
    const agent = createDeepAgent({
      model: new ScriptedChatModel(() => {
        modelCalls++;
        return call("guarded_write", "db-gate-call");
      }),
      backend: new StateBackend(),
      tools: [write],
      middleware: stack(4),
    }) as unknown as Agent;
    await assert.rejects(
      agent.invoke({ messages: [new HumanMessage("work")] }, {
        configurable: { thread_id: `db-gate-${wrapped}` },
      } as AgentRunnableConfig),
      (error) => {
        assert.equal(agentRunStopFromStepBudgetError(error), null);
        return true;
      },
    );
    assert.equal(modelCalls, 1);
    assert.equal(gateCalls, 1);
    assert.equal(effects, 0);
  },
);

test.each(["plain-json", "error-properties", "wrong-status", "wrong-code"])(
  "a %s cancellation lookalike stays an ordinary tool failure",
  async (kind) => {
    let modelCalls = 0;
    const write = tool(
      async () => {
        if (kind === "plain-json")
          throw {
            statusCode: 499,
            code: "CLIENT_CANCELLED",
            message: "Chat run was cancelled",
          };
        if (kind === "error-properties")
          throw Object.assign(new Error("Chat run was cancelled"), {
            statusCode: 499,
            code: "CLIENT_CANCELLED",
          });
        throw new ContentError(
          kind === "wrong-status" ? 500 : 499,
          kind === "wrong-code" ? "OTHER_ERROR" : "CLIENT_CANCELLED",
          "Tool failure",
        );
      },
      { name: "guarded_write", description: "write", schema: z.object({}) },
    );
    const agent = createDeepAgent({
      model: new ScriptedChatModel(() =>
        ++modelCalls === 1
          ? call("guarded_write", "lookalike-call")
          : new AIMessage("Handle the actual tool failure."),
      ),
      backend: new StateBackend(),
      tools: [write],
      middleware: stack(4),
    }) as unknown as Agent;
    const result = await agent.invoke(
      { messages: [new HumanMessage("work")] },
      {
        configurable: { thread_id: `lookalike-${kind}` },
      } as AgentRunnableConfig,
    );
    assert.equal(modelCalls, 2);
    assert.equal(
      selectAgentStepStop(result, { userMessageId: "same-human" }),
      null,
    );
  },
);
