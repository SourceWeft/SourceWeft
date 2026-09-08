import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { z } from "zod";
import type { ObserveSink, UsageInfo } from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "../../../modules/content/billing-port";
import type { ModelUsageContext } from "./context";
import { openBillingScope } from "./scope";
import { createSourceWeftSummarizationMiddleware } from "../../../modules/threads/agent/middleware/context-compression";

const rawMocks = vi.hoisted(() => ({
  getRawModelGatewayClient: vi.fn(),
  createRawAgentChatModel: vi.fn(),
}));

vi.mock("../internal/raw", () => rawMocks);

const { createBilledAgentChatModel } = await import("./langchain-proxy");

const USAGE: UsageInfo = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

class ScriptedChatModel extends BaseChatModel {
  generateCount = 0;

  constructor(
    private readonly sink: ObserveSink | undefined,
    private readonly script: Array<{ content: string; toolCalls?: unknown[] }>,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }

  _llmType() {
    return "scripted";
  }

  bindTools(_tools: unknown[]) {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const step =
      this.script[Math.min(this.generateCount, this.script.length - 1)];
    this.generateCount += 1;

    await this.sink?.onGenerationEnd?.({ usage: USAGE } as never);

    const message = new AIMessage({
      content: step?.content ?? "",
      tool_calls: (step?.toolCalls ?? []) as never,
      usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    });
    return { generations: [{ text: step?.content ?? "", message }] };
  }
}

function createBilling(): ContentBillingPort {
  return {
    getSummary: vi.fn(async (teamId: string) => ({
      teamId,
      billingMode: "enforced",
      credits: { available: 1000, consumedThisCycle: 0 },
    })),
    meterConsume: vi.fn(),
    meterIngestion: vi.fn(),
  } as unknown as ContentBillingPort;
}

function meterUsageStub() {
  return vi.fn(async () => ({
    billing: {
      teamId: "team_1",
      consumedCredits: 1,
      availableCredits: 999,
      consumedThisCycle: 1,
      idempotencyReplayed: false,
    },
    cost: {
      providerCostUsd: 0.01,
      pricingSnapshot: null,
      costSource: "price_book",
      missingPriceComponents: [],
    },
    billedBy: "provider_cost" as const,
    skipReason: null,
  }));
}

function createScope() {
  const context: ModelUsageContext = {
    teamId: "team_1",
    workspaceId: "ws_1",
    actorUserId: "user_1",
    feature: "chat",
    intent: { mode: "billed" },
    scopeKind: "thread-turn",
    scopeId: "trace_1",
  };
  return openBillingScope({
    context,
    billing: createBilling(),
    billingMode: "enforced",
    availableCredits: 1000,
    meterUsage: meterUsageStub() as never,
  });
}

/**
 * Exercises the production agent factory — deepagents' `createDeepAgent`, which
 * layers its own middleware and composition (withConfig, bind) on top of the
 * LangGraph loop — rather than langchain's plainer `createAgent`.
 *
 * This is the verification that gates replacing the post-hoc accounting in
 * llm-call-billing.ts: it answers empirically whether the billing proxy sees
 * every model call the real agent stack makes.
 */
async function buildDeepAgentWithBilledModel(
  script: Array<{ content: string; toolCalls?: unknown[] }>,
  options: {
    buildMiddleware?: (model: unknown) => unknown[];
    subagents?: unknown[];
  } = {},
) {
  const scope = createScope();
  let underlying: ScriptedChatModel | undefined;

  rawMocks.createRawAgentChatModel.mockImplementation(
    async (input: { observeSink?: ObserveSink }) => {
      underlying = new ScriptedChatModel(input.observeSink, script);
      return underlying;
    },
  );

  const model = await createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scope.context.scopeId,
      teamId: scope.context.teamId,
      workspaceId: scope.context.workspaceId!,
    },
    context: scope.context,
    scope,
    billing: {
      modelKind: "chat",
      profileAlias: "default-chat",
      gatewayConfigId: "gw_1",
    },
  });

  const echo = tool(async ({ text }: { text: string }) => `echoed:${text}`, {
    name: "echo",
    description: "Echo the input back.",
    schema: z.object({ text: z.string() }),
  });

  const agent = createDeepAgent({
    model: model as never,
    tools: [echo],
    checkpointer: new MemorySaver(),
    ...(options.buildMiddleware
      ? { middleware: options.buildMiddleware(model) }
      : {}),
    ...(options.subagents ? { subagents: options.subagents } : {}),
  } as never);

  return { agent, scope, getUnderlying: () => underlying };
}

const runConfig = {
  configurable: { thread_id: "thread_1" },
  recursionLimit: 12,
};

test("deepagents: every model call in a tool-calling loop is billed exactly once", async () => {
  const { agent, scope, getUnderlying } = await buildDeepAgentWithBilledModel([
    {
      content: "",
      toolCalls: [{ id: "call_1", name: "echo", args: { text: "hi" } }],
    },
    { content: "All done." },
  ]);

  await (
    agent as never as {
      invoke: (i: unknown, c: unknown) => Promise<unknown>;
    }
  ).invoke({ messages: [new HumanMessage("say hi")] }, runConfig);

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;
  assert.ok(
    actualModelCalls >= 2,
    `expected >=2 model calls, got ${actualModelCalls}`,
  );
  assert.equal(
    scope.meteredCalls().length,
    actualModelCalls,
    `agent made ${actualModelCalls} model calls but ${scope.meteredCalls().length} were billed`,
  );
});

test("deepagents: a single-shot turn is billed exactly once", async () => {
  const { agent, scope, getUnderlying } = await buildDeepAgentWithBilledModel([
    { content: "Immediate answer." },
  ]);

  await (
    agent as never as {
      invoke: (i: unknown, c: unknown) => Promise<unknown>;
    }
  ).invoke({ messages: [new HumanMessage("hello")] }, runConfig);

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;
  assert.equal(actualModelCalls, 1);
  assert.equal(scope.meteredCalls().length, actualModelCalls);
});

test("deepagents: a streamed turn bills every model call", async () => {
  const { agent, scope, getUnderlying } = await buildDeepAgentWithBilledModel([
    {
      content: "",
      toolCalls: [{ id: "call_1", name: "echo", args: { text: "hi" } }],
    },
    { content: "Done streaming." },
  ]);

  const stream = await (
    agent as never as {
      stream: (i: unknown, c: unknown) => Promise<AsyncIterable<unknown>>;
    }
  ).stream({ messages: [new HumanMessage("say hi")] }, runConfig);
  for await (const _chunk of stream) {
    // drain
  }

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;
  assert.ok(
    actualModelCalls >= 2,
    `expected >=2 model calls, got ${actualModelCalls}`,
  );
  assert.equal(
    scope.meteredCalls().length,
    actualModelCalls,
    `agent made ${actualModelCalls} model calls but ${scope.meteredCalls().length} were billed`,
  );
});

test("deepagents: a subagent's model calls settle against the parent billing scope", async () => {
  // A subagent that omits `model` inherits the billed defaultModel — this is the
  // billing-propagation contract the read-only delegates rely on. Delegating
  // to it must bill the child's model call, not leak it unbilled.
  const { agent, scope, getUnderlying } = await buildDeepAgentWithBilledModel(
    [
      // 1) parent delegates to the child via the task tool
      {
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "task",
            args: { description: "look something up", subagent_type: "child" },
          },
        ],
      },
      // 2) the child runs and returns its report — its own billed model call
      { content: "child report" },
      // 3) parent resumes with the final answer
      { content: "all done" },
    ],
    {
      subagents: [
        {
          name: "child",
          description: "A child delegate used to prove billing propagation.",
          systemPrompt: "You are a child agent. Answer briefly.",
          // `model` intentionally omitted → inherits the billed defaultModel.
        },
      ],
    },
  );

  await (
    agent as never as {
      invoke: (i: unknown, c: unknown) => Promise<unknown>;
    }
  ).invoke({ messages: [new HumanMessage("delegate please")] }, runConfig);

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;
  // parent (task call) + child (report) + parent (final) = at least 3 calls.
  assert.ok(
    actualModelCalls >= 3,
    `expected >=3 model calls incl. the subagent, got ${actualModelCalls}`,
  );
  // Every call — parent and child alike — settled against the one scope.
  assert.equal(
    scope.meteredCalls().length,
    actualModelCalls,
    `agent made ${actualModelCalls} model calls (incl. subagent) but ${scope.meteredCalls().length} were billed`,
  );
});

test("deepagents: SourceWeft summary generation uses the billed model", async () => {
  const { agent, scope, getUnderlying } = await buildDeepAgentWithBilledModel(
    [
      { content: "compressed memory [citation:old-1]" },
      { content: "answer after summary" },
    ],
    {
      buildMiddleware: (model) => [
        createSourceWeftSummarizationMiddleware({
          backend: new StateBackend(),
          chatProfileConfig: { contextLength: 100_000 },
          model: model as never,
        }),
      ],
    },
  );

  const result = await (
    agent as never as {
      invoke: (i: unknown, c: unknown) => Promise<unknown>;
    }
  ).invoke(
    {
      messages: Array.from(
        { length: 41 },
        (_, index) =>
          new HumanMessage(
            index === 0
              ? "historical message 0 [citation:stale]"
              : `historical message ${index}`,
          ),
      ),
    },
    runConfig,
  );

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;
  assert.ok(
    actualModelCalls >= 2,
    `expected summary + agent generation calls, got ${actualModelCalls}`,
  );
  assert.equal(scope.meteredCalls().length, actualModelCalls);
  const files = (result as { files?: Record<string, { content?: unknown }> })
    .files;
  const historyPath = Object.keys(files ?? {}).find((path) =>
    path.startsWith("/conversation_history/"),
  );
  assert.ok(historyPath);
  const historyContent = String(files?.[historyPath]?.content ?? "");
  assert.match(historyContent, /old citation marker stale removed/);
  assert.doesNotMatch(historyContent, /\[citation:stale\]/);
});
