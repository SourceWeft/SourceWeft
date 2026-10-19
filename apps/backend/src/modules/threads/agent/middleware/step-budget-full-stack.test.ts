import assert from "node:assert/strict";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { test, vi } from "vitest";
import { z } from "zod";
import { ScriptedChatModel } from "../../../../test/chat-model";
import { config } from "../../../../shared/config";
import { createSourceWeftAgentMiddlewareStack } from "./index";
import { selectAgentRunProgress } from "./step-budget";

// Unit storage boundary only: production agent assembly, compression, SDK
// protocol and approval code remain real. Live-report QA uses PostgreSQL.
vi.mock("../../../../shared/chat-checkpointer", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getChatCheckpointer: async () => saver };
});

test("complete production middleware stack preserves durable preparation and tool-enabled closing", async () => {
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = 2;
  config.chat.agent.closingSteps = 4;
  let calls = 0,
    effects = 0;
  try {
    const model = new ScriptedChatModel(() =>
      ++calls === 5
        ? new AIMessage("Verified delivery finished.")
        : new AIMessage({
            content: "",
            tool_calls: [{ id: `probe-${calls}`, name: "probe", args: {} }],
          }),
    );
    const probe = tool(
      async () => {
        effects++;
        return "verified";
      },
      { name: "probe", description: "verify", schema: z.object({}) },
    );
    const backend = new StateBackend();
    const middleware = await createSourceWeftAgentMiddlewareStack({
      backend,
      model,
      modelAlias: "chat-default",
      filesystemMounts: [],
      toolObservabilityContext: { userMessageId: "full-stack-u" },
    });
    const agent = createDeepAgent({
      model,
      tools: [probe],
      backend,
      middleware,
      checkpointer: new MemorySaver(),
    }) as unknown as {
      invoke(
        input: unknown,
        options?: unknown,
      ): Promise<Record<string, unknown>>;
    };
    const result = await agent.invoke(
      { messages: [new HumanMessage("Verify and deliver.")] },
      { configurable: { thread_id: "full-production-stack" } },
    );
    assert.equal(calls, 5);
    assert.equal(effects, 4);
    assert.equal(
      selectAgentRunProgress(result, { userMessageId: "full-stack-u" })?.phase,
      "closing",
    );
  } finally {
    Object.assign(config.chat.agent, previous);
  }
});
test("preparation does not request approval twice for the prior completed tool batch", async () => {
  const { Command } = await import("@langchain/langgraph");
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = 2;
  config.chat.agent.closingSteps = 3;
  let calls = 0,
    effects = 0;
  try {
    const model = new ScriptedChatModel(() =>
      ++calls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [{ id: "approved-first", name: "probe", args: {} }],
          })
        : new AIMessage("Natural final on normal decision two."),
    );
    const probe = tool(
      async () => {
        effects++;
        return "verified";
      },
      { name: "probe", description: "approval required", schema: z.object({}) },
    );
    const backend = new StateBackend();
    const middleware = await createSourceWeftAgentMiddlewareStack({
      backend,
      model,
      modelAlias: "chat-default",
      filesystemMounts: [],
      interruptOn: { probe: true },
      toolObservabilityContext: { userMessageId: "full-hitl-u" },
    });
    const agent = createDeepAgent({
      model,
      tools: [probe],
      backend,
      middleware,
      interruptOn: { probe: true },
      checkpointer: new MemorySaver(),
    }) as unknown as {
      invoke(input: unknown, options?: unknown): Promise<Record<string, any>>;
      getState(
        options: unknown,
      ): Promise<{ tasks: { interrupts?: unknown[] }[] }>;
    };
    const opts = { configurable: { thread_id: "full-native-hitl" } };
    await agent.invoke(
      { messages: [new HumanMessage("Verify with approval.")] },
      opts,
    );
    assert.equal(calls, 1);
    assert.equal(effects, 0);
    const result = await agent.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      opts,
    );
    assert.equal(effects, 1);
    assert.equal(calls, 2);
    assert.equal(
      (await agent.getState(opts)).tasks.some((t) => t.interrupts?.length),
      false,
    );
    assert.equal(
      selectAgentRunProgress(result, { userMessageId: "full-hitl-u" })
        ?.normalSteps,
      2,
    );
  } finally {
    Object.assign(config.chat.agent, previous);
  }
});
test("production v3 streaming and message adapter accept the no-provider preparation checkpoint", async () => {
  const { adoptV3RunStream, adaptMessagesEvent } =
    await import("../turn/v3-protocol");
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = 2;
  config.chat.agent.closingSteps = 3;
  let calls = 0,
    effects = 0;
  try {
    const model = new ScriptedChatModel(() =>
      ++calls === 4
        ? new AIMessage("Verified delivered.")
        : new AIMessage({
            content: "",
            tool_calls: [
              { id: `stream-probe-${calls}`, name: "probe", args: {} },
            ],
          }),
    );
    const probe = tool(
      async () => {
        effects++;
        return "verified";
      },
      { name: "probe", description: "verify", schema: z.object({}) },
    );
    const backend = new StateBackend();
    const middleware = await createSourceWeftAgentMiddlewareStack({
      backend,
      model,
      modelAlias: "chat-default",
      filesystemMounts: [],
      interruptOn: { probe: false },
      toolObservabilityContext: { userMessageId: "full-stream-u" },
    });
    const agent = createDeepAgent({
      model,
      tools: [probe],
      backend,
      middleware,
      interruptOn: { probe: false },
      checkpointer: new MemorySaver(),
    }) as unknown as {
      streamEvents(input: unknown, options: unknown): Promise<unknown>;
    };
    const stream = adoptV3RunStream(
      await agent.streamEvents(
        { messages: [new HumanMessage("Verify and deliver.")] },
        { version: "v3", configurable: { thread_id: "full-v3-stack" } },
      ),
    );
    let adapted = 0;
    for await (const event of stream) {
      if (event.method === "messages")
        adapted += adaptMessagesEvent(event.params?.data).length;
    }
    const result = await stream.output;
    assert.equal(calls, 4);
    assert.equal(effects, 3);
    assert.equal(
      selectAgentRunProgress(result, { userMessageId: "full-stream-u" })?.phase,
      "closing",
    );
    assert.ok(adapted > 0);
  } finally {
    Object.assign(config.chat.agent, previous);
  }
});
test("production thread v3 streaming preserves nested native summarization and preparation Commands at the boundary", async () => {
  const { adoptV3RunStream, adaptMessagesEvent } =
    await import("../turn/v3-protocol");
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = 2;
  config.chat.agent.closingSteps = 3;
  let calls = 0,
    summaries = 0,
    effects = 0;
  try {
    const model = new ScriptedChatModel((messages) => {
      if (
        typeof messages[0]?.content === "string" &&
        messages[0].content.startsWith(
          "You are SourceWeft's conversation memory compressor.",
        )
      ) {
        summaries++;
        return new AIMessage(
          "## Goal\nFinish the existing task.\n## Constraints\nExisting permissions.\n## Progress\nHistorical only.\n## Key Decisions\nNone.\n## Next Steps\nVerify current evidence.\n## Critical Context\nMemory only.\n## Relevant Sources\nRetrieve current sources.\n## Non-Evidence Reminder\nNot source evidence.",
        );
      }
      calls++;
      return calls === 3
        ? new AIMessage("Verified closing completed.")
        : new AIMessage({
            content: "",
            tool_calls: Array.from({ length: calls === 1 ? 2 : 1 }, (_, i) => ({
              id: `pressure-${calls}-${i}`,
              name: "probe",
              args: {},
            })),
          });
    });
    const probe = tool(
      async () => {
        effects++;
        return "verified";
      },
      { name: "probe", description: "verify", schema: z.object({}) },
    );
    const backend = new StateBackend();
    const { createThreadAgent } = await import("../index");
    const agent = (await createThreadAgent({
      model,
      tools: [probe],
      backend,
      modelAlias: "chat-default",
      filesystemMounts: [],
      interruptOn: { probe: false },
      toolObservabilityContext: { userMessageId: "full-pressure-u" },
    })) as unknown as {
      streamEvents(input: unknown, options: unknown): Promise<unknown>;
    };
    // 37 initial messages -> model1 + two tool receipts -> exactly40; native
    // message-trigger summarization therefore coincides with normal2 preparation.
    const history = Array.from({ length: 18 }, (_, i) => [
      new HumanMessage(`Earlier request${i} ${"context ".repeat(120)}`),
      new AIMessage(`Earlier result${i} ${"memory ".repeat(120)}`),
    ]).flat();
    const stream = adoptV3RunStream(
      await agent.streamEvents(
        {
          messages: [
            ...history,
            new HumanMessage("Verify and deliver current evidence."),
          ],
        },
        { version: "v3", configurable: { thread_id: "full-v3-pressure" } },
      ),
    );
    for await (const event of stream) {
      if (event.method === "messages") adaptMessagesEvent(event.params?.data);
    }
    const result = await stream.output;
    assert.ok(summaries >= 1);
    assert.equal(calls, 3);
    assert.equal(effects, 3);
    assert.equal(
      selectAgentRunProgress(result, { userMessageId: "full-pressure-u" })
        ?.phase,
      "closing",
    );
  } finally {
    Object.assign(config.chat.agent, previous);
  }
});
test("distinct Commands writing conflicting LastValue values still fail", async () => {
  const { createAgent, createMiddleware } = await import("langchain");
  const { Command } = await import("@langchain/langgraph");
  let models = 0;
  const outer = createMiddleware({
    name: "DistinctOuterCommand",
    stateSchema: z.object({ conflict: z.string().optional() }),
    wrapModelCall: async (request, handler) => {
      await handler(request);
      return new Command({ update: { conflict: "outer" } });
    },
  });
  const inner = createMiddleware({
    name: "DistinctInnerCommand",
    wrapModelCall: () => new Command({ update: { conflict: "inner" } }),
  });
  const agent = createAgent({
    model: new ScriptedChatModel(() => {
      models++;
      return new AIMessage("must not run");
    }),
    middleware: [outer, inner],
  }) as unknown as { invoke(input: unknown): Promise<unknown> };
  await assert.rejects(
    agent.invoke({ messages: [new HumanMessage("conflict")] }),
    /Invalid update for channel "conflict"[\s\S]*LastValue can only receive one value per step/,
  );
  assert.equal(models, 0);
});
test("production thread saved-AI replay still requires native approval without another provider call", async () => {
  const { createMiddleware } = await import("langchain");
  const { createThreadAgent } = await import("../index");
  const { Command } = await import("@langchain/langgraph");
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = 1;
  config.chat.agent.closingSteps = 2;
  let firstCalls = 0,
    resumedCalls = 0,
    effects = 0;
  try {
    const probe = tool(
      async () => {
        effects++;
        return "approved";
      },
      { name: "probe", description: "requires approval", schema: z.object({}) },
    );
    const backend = new StateBackend();
    const opts = {
      configurable: { thread_id: "production-saved-ai-approval" },
    };
    const crash = createMiddleware({
      name: "CrashSavedAI",
      afterModel: (state) => {
        if (
          [...state.messages].reverse().find(AIMessage.isInstance)
            ?.tool_calls?.[0]?.id === "saved-native-approval"
        )
          throw new Error("saved-ai-before-approval");
      },
    });
    const first = (await createThreadAgent({
      model: new ScriptedChatModel(() => {
        firstCalls++;
        return new AIMessage({
          content: "",
          tool_calls: [
            { id: "saved-native-approval", name: "probe", args: {} },
          ],
        });
      }),
      tools: [probe],
      backend,
      filesystemMounts: [],
      extraMiddleware: [crash],
      toolObservabilityContext: { userMessageId: "saved-thread-u" },
    })) as unknown as {
      invoke(input: unknown, options: unknown): Promise<unknown>;
    };
    await assert.rejects(
      first.invoke(
        { messages: [new HumanMessage("Deliver approved work.")] },
        opts,
      ),
      /saved-ai-before-approval/,
    );
    assert.equal(firstCalls, 1);
    assert.equal(effects, 0);
    config.chat.agent.maxSteps = 99;
    config.chat.agent.closingSteps = 99;
    const restored = (await createThreadAgent({
      model: new ScriptedChatModel(() => {
        resumedCalls++;
        return new AIMessage("Approved current work finished.");
      }),
      tools: [probe],
      backend,
      filesystemMounts: [],
      interruptOn: { probe: true },
      toolObservabilityContext: { userMessageId: "saved-thread-u" },
    })) as unknown as {
      invoke(
        input: unknown,
        options: unknown,
      ): Promise<Record<string, unknown>>;
      getState(
        options: unknown,
      ): Promise<{ tasks: { interrupts?: unknown[] }[] }>;
    };
    await restored.invoke({ messages: [] }, opts);
    assert.equal(resumedCalls, 0);
    assert.equal(effects, 0);
    assert.ok(
      (await restored.getState(opts)).tasks.some((t) => t.interrupts?.length),
    );
    const result = await restored.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      opts,
    );
    assert.equal(effects, 1);
    assert.equal(resumedCalls, 1);
    assert.equal(firstCalls, 1);
    assert.deepEqual(
      selectAgentRunProgress(result, { userMessageId: "saved-thread-u" }),
      {
        policyVersion: 2,
        phase: "closing",
        normalSteps: 1,
        normalLimit: 1,
        closingSteps: 1,
        closingLimit: 2,
        steps: 2,
        limit: 3,
      },
    );
  } finally {
    Object.assign(config.chat.agent, previous);
  }
});
test("full-stack general-purpose child preserves native approval across its second normal preparation", async () => {
  const { createSourceWeftSubagentMiddlewareStack } = await import("./index");
  const { Command } = await import("@langchain/langgraph");
  const previous = {
    maxSteps: config.chat.agent.maxSteps,
    closingSteps: config.chat.agent.closingSteps,
  };
  config.chat.agent.maxSteps = 2;
  config.chat.agent.closingSteps = 2;
  let parentCalls = 0,
    childCalls = 0,
    effects = 0;
  try {
    const probe = tool(
      async () => {
        effects++;
        return "approved child work";
      },
      { name: "probe", description: "approval", schema: z.object({}) },
    );
    const backend = new StateBackend();
    const interruptOn = { probe: true };
    const parent = new ScriptedChatModel(() =>
      ++parentCalls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "delegate-approved-child",
                name: "task",
                args: {
                  description: "approved child work",
                  subagent_type: "child",
                },
              },
            ],
          })
        : new AIMessage("Integrated child work."),
    );
    const child = new ScriptedChatModel(() =>
      ++childCalls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [{ id: "child-first", name: "probe", args: {} }],
          })
        : new AIMessage("Child verified."),
    );
    const middleware = await createSourceWeftAgentMiddlewareStack({
      backend,
      model: parent,
      modelAlias: "chat-default",
      filesystemMounts: [],
      interruptOn: {},
      toolObservabilityContext: { userMessageId: "full-child-u" },
    });
    const childMiddleware = createSourceWeftSubagentMiddlewareStack({
      backend,
      model: child,
      interruptOn,
      toolObservabilityContext: {
        userMessageId: "full-child-u",
        subagentType: "general-purpose",
      },
    });
    const agent = createDeepAgent({
      model: parent,
      backend,
      middleware,
      interruptOn: {},
      checkpointer: new MemorySaver(),
      subagents: [
        {
          name: "child",
          description: "child",
          systemPrompt: "Complete approved work.",
          model: child,
          tools: [probe],
          interruptOn,
          middleware: childMiddleware,
        },
      ],
    }) as unknown as {
      invoke(
        input: unknown,
        options: unknown,
      ): Promise<Record<string, unknown>>;
      getState(
        options: unknown,
      ): Promise<{ tasks: { interrupts?: unknown[] }[] }>;
    };
    const opts = { configurable: { thread_id: "full-child-native-approval" } };
    await agent.invoke(
      { messages: [new HumanMessage("Delegate and integrate.")] },
      opts,
    );
    assert.equal(effects, 0);
    assert.equal(childCalls, 1);
    const result = await agent.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      opts,
    );
    assert.equal(effects, 1);
    assert.equal(childCalls, 2);
    assert.equal(parentCalls, 2);
    assert.equal(
      (await agent.getState(opts)).tasks.some((t) => t.interrupts?.length),
      false,
    );
    assert.equal(
      selectAgentRunProgress(result, { userMessageId: "full-child-u" })
        ?.normalSteps,
      2,
    );
  } finally {
    Object.assign(config.chat.agent, previous);
  }
});
