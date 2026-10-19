import assert from "node:assert/strict";
import { test } from "vitest";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { z } from "zod";
import { ScriptedChatModel } from "./chat-model";
import { createSourceWeftStepBudgetMiddleware } from "../modules/threads/agent/middleware/step-budget";
import {
  carryAgentStepBudgetIntoRefresh,
  type RefreshBudgetAgent,
} from "../modules/threads/agent/turn/refresh-step-budget";

const destination = {
  configurable: { thread_id: "destination", checkpoint_ns: "" },
};
function v2(overrides: Record<string, unknown> = {}) {
  return {
    policyVersion: 2,
    steps: 1,
    limit: 4,
    normalSteps: 1,
    normalLimit: 2,
    closingSteps: 0,
    closingLimit: 2,
    phase: "working",
    summary: "unused",
    ...overrides,
  };
}
const exhausted = () =>
  v2({
    steps: 4,
    normalSteps: 2,
    closingSteps: 2,
    phase: "finalizing",
    availableToolIds: ["probe"],
    closingToolIds: ["probe"],
    summary: "completed",
    summaryText: "Saved progress.",
  });
function snapshot(
  id: string,
  entry: unknown,
  uid = "u",
  extra: Record<string, unknown> = {},
) {
  return {
    config: {
      configurable: {
        thread_id: "origin",
        checkpoint_ns: "",
        checkpoint_id: id,
      },
    },
    values: {
      sourceweftRunStepBudget:
        entry === null ? null : { userMessageId: uid, scopes: { main: entry } },
      ...extra,
    },
  };
}
function fake(states: ReturnType<typeof snapshot>[]) {
  const updates: Record<string, unknown>[] = [],
    queries: unknown[] = [];
  const agent: RefreshBudgetAgent = {
    async *getStateHistory(config, options) {
      queries.push({ config, options });
      const floor = (options.before as any)?.configurable.checkpoint_id;
      const start = floor
        ? states.findIndex(
            (state) => state.config.configurable.checkpoint_id === floor,
          ) + 1
        : 0;
      yield* states.slice(start, start + options.limit);
    },
    async updateState(_config, update) {
      updates.push(update);
      return {
        configurable: {
          thread_id: "destination",
          checkpoint_ns: "",
          checkpoint_id: "carried",
        },
      };
    },
  };
  return { agent, updates, queries };
}
const failure = (error: unknown) =>
  (error as any)?.code === "AGENT_STEP_REFRESH_UNAVAILABLE";
async function carry(
  agent: RefreshBudgetAgent,
  extra: Record<string, unknown> = {},
) {
  return carryAgentStepBudgetIntoRefresh({
    agent,
    destination,
    userMessageId: "u",
    graphThreadIds: ["origin"],
    requireExistingBudget: true,
    ...extra,
  });
}

test("refresh keeps an older exhausted high-water mark over a newer buggy low-budget branch", async () => {
  const { agent, updates } = fake([
    snapshot("new-low", v2()),
    snapshot("old-full", exhausted()),
  ]);
  await carry(agent);
  assert.deepEqual(
    (updates[0]!.sourceweftRunStepBudget as any).scopes.main,
    exhausted(),
  );
});

test.each(["prepared", "ready"])(
  "equal-step %s preparation keeps frozen identities and consumes the reserved slot without old AI replay",
  async (status) => {
    const latest = v2({
      steps: 2,
      normalSteps: 2,
      availableToolIds: ["probe"],
      decisionPreparation: { status, previousAssistantId: "old-wrong-ai" },
    });
    const { agent, updates } = fake([
      snapshot("latest", latest),
      snapshot("earlier", v2({ steps: 2, normalSteps: 2 })),
    ]);
    await carry(agent);
    const entry = (updates[0]!.sourceweftRunStepBudget as any).scopes.main;
    assert.equal(entry.steps, 2);
    assert.equal(entry.decisionPreparation, undefined);
    assert.deepEqual(entry.availableToolIds, ["probe"]);
  },
);

test.each([
  ["limits", v2({ limit: 5, closingLimit: 3 })],
  ["policy", { steps: 1, limit: 4, summary: "unused" }],
  [
    "tool identities",
    v2({ steps: 2, normalSteps: 2, availableToolIds: ["other"] }),
  ],
  ["summary conflict", { ...exhausted(), summaryText: "different" }],
])(
  "incompatible same-human %s fails before writing a refresh",
  async (_label, other) => {
    const base =
      _label === "tool identities"
        ? v2({ steps: 2, normalSteps: 2, availableToolIds: ["probe"] })
        : _label === "summary conflict"
          ? exhausted()
          : v2();
    const { agent, updates } = fake([
      snapshot("new", base),
      snapshot("old", other),
    ]);
    await assert.rejects(carry(agent), failure);
    assert.equal(updates.length, 0);
  },
);

test("foreign human budgets are never copied, malformed current-human state is rejected", async () => {
  const foreign = fake([snapshot("other", exhausted(), "other-human")]);
  await assert.rejects(carry(foreign.agent), failure);
  assert.equal(foreign.updates.length, 0);
  for (const entry of [
    v2({ policyVersion: 3 }),
    v2({ normalSteps: 99 }),
    { ...exhausted(), summaryText: "" },
  ]) {
    const f = fake([snapshot("bad", entry)]);
    await assert.rejects(carry(f.agent), failure);
    assert.equal(f.updates.length, 0);
  }
});

test("exact root namespace, existing checkpoint references and bounded scans are mandatory", async () => {
  for (const config of [
    { thread_id: "sibling", checkpoint_ns: "", checkpoint_id: "bad" },
    { thread_id: "origin", checkpoint_ns: "tools:child", checkpoint_id: "bad" },
  ]) {
    const state = snapshot("bad", v2());
    state.config.configurable = config;
    const f = fake([state]);
    await assert.rejects(carry(f.agent), failure);
  }
  const missing = fake([snapshot("exists", v2())]);
  await assert.rejects(
    carry(missing.agent, {
      checkpointRefs: [{ threadId: "origin", checkpointId: "deleted" }],
    }),
    failure,
  );
  const bound = fake([snapshot("one", v2()), snapshot("two", v2())]);
  await assert.rejects(carry(bound.agent, { maxCheckpoints: 1 }), failure);
  assert.equal(bound.updates.length, 0);
});

test("native history is paged and a trusted beforeInput floor avoids scanning earlier human turns", async () => {
  const states = Array.from({ length: 140 }, (_, i) =>
    snapshot(String(200 - i), v2()),
  );
  const f = fake(states);
  await carry(f.agent);
  assert.equal(f.queries.length, 2);
  for (const query of f.queries as any[])
    assert.deepEqual(query.config, {
      configurable: { thread_id: "origin", checkpoint_ns: "" },
    });
  const bounded = fake([
    snapshot("new", v2()),
    snapshot("before", v2(), "prior"),
    snapshot("old-invalid", v2({ policyVersion: 99 })),
  ]);
  await carry(bounded.agent, {
    maxCheckpoints: 2,
    checkpointRefs: [{ threadId: "origin", checkpointId: "before" }],
    historyFloors: [{ threadId: "origin", checkpointId: "before" }],
  });
  assert.equal(bounded.updates.length, 1);
});

test("legacy adoption is explicit, and missing recorded policy is not mistaken for legacy", async () => {
  const legacy = fake([snapshot("legacy", null)]);
  assert.deepEqual(
    await carry(legacy.agent, { requireExistingBudget: false }),
    destination,
  );
  assert.equal(legacy.updates.length, 0);
  await assert.rejects(carry(legacy.agent), failure);
  const v1 = { steps: 1, limit: 2, summary: "unused" };
  const known = fake([snapshot("v1", v1)]);
  await carry(known.agent);
  assert.deepEqual(
    (known.updates[0]!.sourceweftRunStepBudget as any).scopes.main,
    v1,
  );
});

test.each(["reserved", "completed"])(
  "native SDK repeated old-branch refresh never recharges v2 %s summary",
  async (summaryStatus) => {
    const saver = new MemorySaver();
    let effects = 0,
      calls = 0;
    const probe = tool(
      async () => {
        effects++;
        return "ok";
      },
      { name: "probe", description: "effect", schema: z.object({}) },
    );
    function graph(uid: string, loop: boolean, normal = 1, closing = 1) {
      const b = createSourceWeftStepBudgetMiddleware({
        userMessageId: uid,
        maxSteps: normal,
        closingSteps: closing,
      });
      return createDeepAgent({
        model: new ScriptedChatModel((messages) => {
          if (
            messages.some(
              (m) =>
                typeof m.content === "string" &&
                m.content.includes(
                  "business-step budget for this run is exhausted",
                ),
            )
          ) {
            if (summaryStatus === "reserved") throw new Error("summary failed");
            return new AIMessage("Saved progress.");
          }
          if (!loop) return new AIMessage("Done.");
          calls++;
          return new AIMessage({
            content: "",
            tool_calls: [{ name: "probe", id: `p${calls}`, args: {} }],
          });
        }),
        tools: [probe],
        backend: new StateBackend(),
        checkpointer: saver,
        middleware: [b.governance, b.toolCallRepair, b.finalization],
      }) as any;
    }
    const opts = { configurable: { thread_id: `sdk-${summaryStatus}` } };
    const prior = graph("prior", false);
    await prior.invoke({ messages: [new HumanMessage("prior")] }, opts);
    const base = await prior.getState(opts);
    const original = graph("u", true);
    if (summaryStatus === "reserved")
      await assert.rejects(
        original.invoke({ messages: [new HumanMessage("work")] }, opts),
      );
    else await original.invoke({ messages: [new HumanMessage("work")] }, opts);
    assert.equal(calls, 2);
    assert.equal(effects, 2);
    // Later human owns HEAD. The old human must still recover its own high-water.
    await graph("later", false).invoke(
      { messages: [new HumanMessage("later")] },
      opts,
    );
    for (let i = 0; i < 2; i++) {
      const refreshed = graph("u", true, 90, 10);
      const controller = new AbortController();
      const refreshDestination = {
        ...base.config,
        signal: controller.signal,
        tags: ["host-refresh"],
        metadata: { hostTrace: "refresh-lineage" },
        configurable: {
          ...base.config.configurable,
          team_id: "host-team",
          workspace_id: "host-workspace",
        },
      };
      const config = await carryAgentStepBudgetIntoRefresh({
        agent: refreshed,
        destination: refreshDestination,
        userMessageId: "u",
        graphThreadIds: [opts.configurable.thread_id],
        requireExistingBudget: true,
      });
      assert.equal(config.signal, controller.signal);
      assert.deepEqual(config.tags, refreshDestination.tags);
      assert.deepEqual(config.metadata, refreshDestination.metadata);
      assert.equal(config.configurable?.team_id, "host-team");
      assert.equal(config.configurable?.workspace_id, "host-workspace");
      const result = refreshed.invoke(
        { messages: [new HumanMessage("same human refresh")] },
        config,
      );
      if (summaryStatus === "reserved") await assert.rejects(result);
      else await result;
      assert.equal(calls, 2);
      assert.equal(effects, 2);
    }
    const next = graph("new-human", false, 3, 2);
    await next.invoke({ messages: [new HumanMessage("continue")] }, opts);
    const state = await next.getState(opts);
    assert.equal(
      state.values.sourceweftRunStepBudget.userMessageId,
      "new-human",
    );
    assert.equal(
      state.values.sourceweftRunStepBudget.scopes.main.normalLimit,
      3,
    );
    assert.equal(
      state.values.sourceweftRunStepBudget.scopes.main.normalSteps,
      1,
    );
  },
);

test.each(["prepared", "ready"])(
  "native SDK refresh of %s preparation never treats an older assistant as the saved response",
  async (status) => {
    const saver = new MemorySaver();
    let calls = 0;
    const build = () => {
      const b = createSourceWeftStepBudgetMiddleware({
        userMessageId: "u",
        maxSteps: 1,
        closingSteps: 2,
      });
      return createDeepAgent({
        model: new ScriptedChatModel(() => {
          calls++;
          return new AIMessage("Closed with an actual new decision.");
        }),
        backend: new StateBackend(),
        checkpointer: saver,
        middleware: [b.governance, b.toolCallRepair, b.finalization],
      }) as any;
    };
    const origin = build();
    const opts = { configurable: { thread_id: `pending-${status}` } };
    const entry = v2({
      limit: 3,
      normalLimit: 1,
      closingLimit: 2,
      normalSteps: 1,
      steps: 1,
      availableToolIds: [],
      decisionPreparation: {
        status,
        previousAssistantId: "a-different-old-ai",
      },
    });
    await origin.updateState(opts, {
      messages: [
        new AIMessage({
          id: "base-old-ai",
          content: "Must not replay this earlier answer.",
        }),
      ],
      sourceweftRunStepBudget: { userMessageId: "u", scopes: { main: entry } },
    });
    const fresh = build();
    const config = await carryAgentStepBudgetIntoRefresh({
      agent: fresh,
      destination: { configurable: { thread_id: `fresh-pending-${status}` } },
      userMessageId: "u",
      graphThreadIds: [opts.configurable.thread_id],
      requireExistingBudget: true,
    });
    const result = await fresh.invoke(
      { messages: [new HumanMessage("refresh")] },
      config,
    );
    assert.equal(calls, 1);
    assert.equal(result.sourceweftRunStepBudget.scopes.main.normalSteps, 1);
    assert.equal(result.sourceweftRunStepBudget.scopes.main.closingSteps, 1);
  },
);

test("native SDK refresh keeps v1 policy instead of reopening a closing allowance", async () => {
  const saver = new MemorySaver();
  let calls = 0;
  const probe = tool(async () => "ok", {
    name: "probe",
    description: "probe",
    schema: z.object({}),
  });
  const build = (uid: string) => {
    const b = createSourceWeftStepBudgetMiddleware({
      userMessageId: uid,
      maxSteps: 70,
      closingSteps: 9,
    });
    return createDeepAgent({
      model: new ScriptedChatModel((messages) => {
        calls++;
        return messages.some(
          (m) =>
            typeof m.content === "string" &&
            m.content.includes(
              "business-step budget for this run is exhausted",
            ),
        )
          ? new AIMessage("Legacy partial saved.")
          : new AIMessage({
              content: "",
              tool_calls: [{ name: "probe", id: `legacy-${calls}`, args: {} }],
            });
      }),
      tools: [probe],
      backend: new StateBackend(),
      checkpointer: saver,
      middleware: [b.governance, b.toolCallRepair, b.finalization],
    }) as any;
  };
  const origin = build("u");
  const opts = { configurable: { thread_id: "legacy-v1-origin" } };
  await origin.invoke(
    {
      messages: [new HumanMessage("legacy")],
      sourceweftRunStepBudget: {
        userMessageId: "u",
        scopes: { main: { steps: 1, limit: 2, summary: "unused" } },
      },
    },
    opts,
  );
  assert.equal(calls, 2);
  const fresh = build("u");
  const config = await carryAgentStepBudgetIntoRefresh({
    agent: fresh,
    destination: { configurable: { thread_id: "legacy-v1-refreshed" } },
    userMessageId: "u",
    graphThreadIds: [opts.configurable.thread_id],
    requireExistingBudget: true,
  });
  const result = await fresh.invoke(
    { messages: [new HumanMessage("retry same legacy human")] },
    config,
  );
  assert.equal(calls, 2);
  assert.equal(
    result.sourceweftRunStepBudget.scopes.main.policyVersion,
    undefined,
  );
  assert.equal(result.sourceweftRunStepBudget.scopes.main.limit, 2);
});

test("reaching an early floor cannot hide a required known checkpoint", async () => {
  const f = fake([snapshot("new", v2()), snapshot("floor", null)]);
  await assert.rejects(
    carry(f.agent, {
      checkpointRefs: [
        { threadId: "origin", checkpointId: "floor" },
        { threadId: "origin", checkpointId: "deleted-final" },
      ],
      historyFloors: [{ threadId: "origin", checkpointId: "floor" }],
    }),
    failure,
  );
  assert.equal(f.updates.length, 0);
});

test("refresh keeps the abort signal and host configuration when native updateState returns only checkpoint coordinates", async () => {
  const controller = new AbortController();
  const f = fake([snapshot("source", v2())]);
  const dest = {
    signal: controller.signal,
    metadata: { trace: "host" },
    configurable: {
      thread_id: "destination",
      checkpoint_ns: "",
      checkpoint_id: "old-pin",
      team_id: "team",
      workspace_id: "workspace",
      sourceweft_thread_id: "chat",
    },
  };
  const config = await carry(f.agent, { destination: dest });
  assert.equal(config.signal, controller.signal);
  assert.deepEqual(config.metadata, dest.metadata);
  assert.deepEqual(config.configurable, {
    ...dest.configurable,
    checkpoint_id: "carried",
  });
});

test("an abort observed during history inspection prevents checkpoint carry", async () => {
  const controller = new AbortController();
  const f = fake([]);
  let writes = 0;
  const agent: RefreshBudgetAgent = {
    ...f.agent,
    async *getStateHistory() {
      controller.abort(new Error("cancelled during recovery"));
      yield snapshot("source", v2());
    },
    async updateState() {
      writes++;
      return destination;
    },
  };
  await assert.rejects(
    carry(agent, {
      destination: { ...destination, signal: controller.signal },
    }),
    /cancelled during recovery/,
  );
  assert.equal(writes, 0);
});

test("abort after the native checkpoint update prevents invoking any further decision and retains the original reason", async () => {
  const controller = new AbortController();
  const cancelled = new Error("cancelled after carry");
  const f = fake([snapshot("source", v2())]);
  const agent: RefreshBudgetAgent = {
    ...f.agent,
    async updateState() {
      controller.abort(cancelled);
      return {
        configurable: { thread_id: "destination", checkpoint_id: "new" },
      };
    },
  };
  await assert.rejects(
    carry(agent, {
      destination: { ...destination, signal: controller.signal },
    }),
    (error) => error === cancelled,
  );
});

test("refresh refuses the latest current-human root snapshot with an unreturned native delegate", async () => {
  const task = new AIMessage({
    id: "a",
    content: "",
    tool_calls: [{ name: "task", id: "native-task", args: {} }],
  });
  const f = fake([
    snapshot("latest", v2(), "u", {
      messages: [new HumanMessage("work"), task],
    }),
  ]);
  await assert.rejects(carry(f.agent), failure);
  assert.equal(f.updates.length, 0);
});

test("a completed latest task permits refresh even though older checkpoints contain pending task nodes", async () => {
  const task = new AIMessage({
    id: "a",
    content: "",
    tool_calls: [{ name: "task", id: "native-task", args: {} }],
  });
  const latest = snapshot("latest", v2(), "u", {
    messages: [
      new HumanMessage("work"),
      task,
      new ToolMessage({
        content: "done",
        name: "task",
        tool_call_id: "native-task",
      }),
    ],
  });
  const old = snapshot("old", v2(), "u", {
    messages: [new HumanMessage("work"), task],
  });
  const f = fake([latest, old]);
  await carry(f.agent);
  assert.equal(f.updates.length, 1);
});

test("old-human pending tasks and an earlier same-id receipt cannot masquerade as the current task's outcome", async () => {
  const task = new AIMessage({
    id: "a",
    content: "",
    tool_calls: [{ name: "task", id: "native-task", args: {} }],
  });
  const old = new ToolMessage({
    content: "earlier task done",
    name: "task",
    tool_call_id: "native-task",
  });
  const f = fake([
    snapshot("latest", v2(), "u", {
      messages: [new HumanMessage("work"), old, task],
    }),
  ]);
  await assert.rejects(carry(f.agent), failure);
  const newHuman = fake([
    snapshot("latest", v2(), "u", {
      messages: [
        new HumanMessage("old"),
        task,
        new HumanMessage("new human with a distinct fresh budget"),
      ],
    }),
  ]);
  await carry(newHuman.agent);
  assert.equal(newHuman.updates.length, 1);
});
