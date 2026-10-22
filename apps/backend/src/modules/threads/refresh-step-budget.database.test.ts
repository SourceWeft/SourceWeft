import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, test } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createDeepAgent, StateBackend } from "deepagents";
import { z } from "zod";
import { createIsolatedTestDatabase } from "../../test/isolated-database";
import { UniqueVersionPostgresSaver } from "../../shared/unique-version-postgres-saver";
import { ScriptedChatModel } from "../../test/chat-model";
import {
  createSourceWeftStepBudgetMiddleware,
  readAgentStepBudgetForRefresh,
  type AgentStepBudgetState,
} from "./agent/middleware/step-budget";
import {
  carryAgentStepBudgetIntoRefresh,
  type RefreshBudgetAgent,
} from "./agent/turn/refresh-step-budget";
import type { AgentRunnableConfig } from "./agent/turn/checkpoint";

/** A checkpoint coordinate as the native graph returns it. */
type CheckpointConfig = AgentRunnableConfig & {
  configurable: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
  };
};
type AgentState = { sourceweftRunStepBudget: AgentStepBudgetState };
// The SDK's static middleware inference requires middleware-owned channels at
// invocation; the runtime initializes them, so tests use an explicit boundary.
type Agent = {
  invoke(input: unknown, config?: unknown): Promise<AgentState>;
  getState(
    config: unknown,
  ): Promise<{ config: CheckpointConfig; values: AgentState }>;
  getStateHistory: RefreshBudgetAgent["getStateHistory"];
  updateState(
    config: AgentRunnableConfig,
    update: Record<string, unknown>,
  ): Promise<CheckpointConfig>;
};

let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
let saver: UniqueVersionPostgresSaver;
beforeAll(async () => {
  isolated = await createIsolatedTestDatabase("refresh_budget");
  saver = new UniqueVersionPostgresSaver(
    new Pool({ connectionString: isolated.url }),
    undefined,
    { schema: "langgraph" },
  );
  await saver.setup();
}, 90_000);
afterAll(async () => {
  await saver?.end();
  await isolated?.close();
});

test("PostgreSQL native refresh pages exact root history and preserves the same-human high-water across old assistant branches", async () => {
  let calls = 0,
    effects = 0;
  const probe = tool(
    async () => {
      effects++;
      return "ok";
    },
    { name: "probe", description: "effect", schema: z.object({}) },
  );
  const uid = randomUUID();
  const build = (
    userMessageId: string,
    loop: boolean,
    normal = 1,
    closing = 1,
  ) => {
    const b = createSourceWeftStepBudgetMiddleware({
      userMessageId,
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
        )
          return new AIMessage("Saved partial work.");
        if (!loop) return new AIMessage("Other human finished.");
        calls++;
        return new AIMessage({
          content: "",
          tool_calls: [{ name: "probe", id: `effect-${calls}`, args: {} }],
        });
      }),
      tools: [probe],
      backend: new StateBackend(),
      checkpointer: saver,
      middleware: [b.governance, b.toolCallRepair, b.finalization],
    }) as unknown as Agent;
  };
  const opts = { configurable: { thread_id: randomUUID(), checkpoint_ns: "" } };
  const prior = build("prior-human", false);
  await prior.invoke({ messages: [new HumanMessage("Earlier human")] }, opts);
  const before = await prior.getState(opts);
  const original = build(uid, true);
  await original.invoke(
    { messages: [new HumanMessage("Current human")] },
    opts,
  );
  const exhausted = await original.getState(opts);
  assert.equal(calls, 2);
  assert.equal(effects, 2);
  assert.equal(
    exhausted.values.sourceweftRunStepBudget.scopes.main!.summary,
    "completed",
  );
  // Preserve a lower branch left by the old recharge bug. The newest state is
  // not necessarily the largest consumed budget and cannot be used alone.
  await original.updateState(before.config, {
    sourceweftRunStepBudget: {
      userMessageId: uid,
      scopes: {
        main: {
          policyVersion: 2,
          steps: 1,
          limit: 2,
          normalSteps: 1,
          normalLimit: 1,
          closingSteps: 0,
          closingLimit: 1,
          phase: "working",
          summary: "unused",
        },
      },
    },
  });
  const later = build("later-human", false);
  await later.invoke(
    { messages: [new HumanMessage("Later human now owns HEAD")] },
    opts,
  );
  let head = await later.getState(opts);
  // Exercise the real Postgres `before` paging semantics without extra model
  // requests. These are ordinary native checkpoint updates on the isolated clone.
  for (let i = 0; i < 130; i++) {
    const config = await later.updateState(head.config, {
      sourceweftRunStepBudget: head.values.sourceweftRunStepBudget,
    });
    head = { ...head, config };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = build(uid, true, 90, 10);
    const queries: Array<{
      config: AgentRunnableConfig;
      options: { limit: number; before?: AgentRunnableConfig };
    }> = [];
    const agent: RefreshBudgetAgent = {
      async *getStateHistory(config, options) {
        queries.push({ config, options });
        yield* fresh.getStateHistory(config, options);
      },
      updateState: (config, update) => fresh.updateState(config, update),
    };
    const controller = new AbortController();
    const destination = {
      ...before.config,
      signal: controller.signal,
      tags: ["host-refresh"],
      metadata: { hostTrace: "postgres-refresh" },
      configurable: {
        ...before.config.configurable,
        team_id: "host-team",
        workspace_id: "host-workspace",
      },
    };
    const config = await carryAgentStepBudgetIntoRefresh({
      agent,
      destination,
      userMessageId: uid,
      graphThreadIds: [opts.configurable.thread_id],
      requireExistingBudget: true,
      checkpointRefs: [
        {
          threadId: opts.configurable.thread_id,
          checkpointId: before.config.configurable.checkpoint_id,
        },
        {
          threadId: opts.configurable.thread_id,
          checkpointId: exhausted.config.configurable.checkpoint_id,
        },
      ],
      historyFloors: [
        {
          threadId: opts.configurable.thread_id,
          checkpointId: before.config.configurable.checkpoint_id,
        },
      ],
    });
    assert.ok(
      queries.length >= 2,
      "must page past the later human's checkpoints",
    );
    for (const query of queries)
      assert.deepEqual(query.config.configurable, {
        thread_id: opts.configurable.thread_id,
        checkpoint_ns: "",
      });
    assert.equal(config.signal, controller.signal);
    assert.deepEqual(config.tags, destination.tags);
    assert.deepEqual(config.metadata, destination.metadata);
    assert.equal(config.configurable?.team_id, "host-team");
    assert.equal(config.configurable?.workspace_id, "host-workspace");
    assert.notEqual(
      config.configurable?.checkpoint_id,
      before.config.configurable.checkpoint_id,
    );
    const result = await fresh.invoke(
      { messages: [new HumanMessage("Retry the same old assistant branch")] },
      config,
    );
    assert.equal(calls, 2);
    assert.equal(effects, 2);
    assert.deepEqual(
      result.sourceweftRunStepBudget.scopes.main,
      exhausted.values.sourceweftRunStepBudget.scopes.main,
    );
  }
  // Forking must not rewrite the pinned history used by the old assistant.
  const previousBudget = (await saver.getTuple(before.config))?.checkpoint
    .channel_values.sourceweftRunStepBudget as
    { userMessageId: string } | undefined;
  assert.equal(previousBudget?.userMessageId, "prior-human");
});

test.each([
  ["without", undefined],
  [
    "with",
    {
      runId: "interrupted-run",
      startedAtMs: 1_000,
      closingStartedAtMs: 2_000,
      trigger: "wall_clock",
    },
  ],
])(
  "PostgreSQL persisted v2 budget %s a wall clock is read by the refresh parser and carried without one",
  async (_label, wallClock) => {
    const uid = randomUUID();
    const build = () => {
      const b = createSourceWeftStepBudgetMiddleware({
        userMessageId: uid,
        maxSteps: 2,
        closingSteps: 2,
      });
      return createDeepAgent({
        model: new ScriptedChatModel(() => new AIMessage("unused")),
        backend: new StateBackend(),
        checkpointer: saver,
        middleware: [b.governance, b.toolCallRepair, b.finalization],
      }) as unknown as Agent;
    };
    const consumed = {
      policyVersion: 2,
      steps: 3,
      limit: 4,
      normalSteps: 2,
      normalLimit: 2,
      closingSteps: 1,
      closingLimit: 2,
      phase: "closing",
      availableToolIds: ["probe"],
      closingToolIds: ["probe"],
      summary: "unused",
    };
    const persisted = wallClock ? { ...consumed, wallClock } : consumed;
    const opts = {
      configurable: { thread_id: randomUUID(), checkpoint_ns: "" },
    };
    await build().updateState(opts, {
      messages: [new HumanMessage("interrupted work")],
      sourceweftRunStepBudget: {
        userMessageId: uid,
        scopes: { main: persisted },
      },
    });
    // The snapshot the refresh scan reads is the raw PostgreSQL checkpoint.
    const tuple = await saver.getTuple(opts);
    assert.deepEqual(tuple?.checkpoint.channel_values.sourceweftRunStepBudget, {
      userMessageId: uid,
      scopes: { main: persisted },
    });
    assert.deepEqual(
      readAgentStepBudgetForRefresh(tuple?.checkpoint.channel_values, uid),
      { userMessageId: uid, scopes: { main: persisted } },
    );
    const fresh = build();
    const destination = {
      configurable: { thread_id: randomUUID(), checkpoint_ns: "" },
    };
    const config = await carryAgentStepBudgetIntoRefresh({
      agent: fresh,
      destination,
      userMessageId: uid,
      graphThreadIds: [opts.configurable.thread_id],
      requireExistingBudget: true,
    });
    const carried = await fresh.getState(config);
    assert.deepEqual(carried.values.sourceweftRunStepBudget, {
      userMessageId: uid,
      scopes: { main: consumed },
    });
    // The origin checkpoint keeps its own clock; only the fork starts fresh.
    assert.deepEqual(
      (await saver.getTuple(opts))?.checkpoint.channel_values
        .sourceweftRunStepBudget,
      { userMessageId: uid, scopes: { main: persisted } },
    );
  },
);
