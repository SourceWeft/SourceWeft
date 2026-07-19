import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { z } from "zod";
import type { ObserveSink, UsageInfo } from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "../../../modules/content/billing-port";
import type { ModelUsageContext } from "./context";
import { openBillingScope } from "./scope";

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
    const step = this.script[Math.min(this.generateCount, this.script.length - 1)];
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
  } as never);

  return { agent, scope, getUnderlying: () => underlying };
}

const runConfig = { configurable: { thread_id: "thread_1" }, recursionLimit: 12 };

test("deepagents: every model call in a tool-calling loop is billed exactly once", async () => {
  const { agent, scope, getUnderlying } = await buildDeepAgentWithBilledModel([
    {
      content: "",
      toolCalls: [{ id: "call_1", name: "echo", args: { text: "hi" } }],
    },
    { content: "All done." },
  ]);

  await (agent as never as {
    invoke: (i: unknown, c: unknown) => Promise<unknown>;
  }).invoke({ messages: [new HumanMessage("say hi")] }, runConfig);

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;
  assert.ok(actualModelCalls >= 2, `expected >=2 model calls, got ${actualModelCalls}`);
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

  await (agent as never as {
    invoke: (i: unknown, c: unknown) => Promise<unknown>;
  }).invoke({ messages: [new HumanMessage("hello")] }, runConfig);

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

  const stream = await (agent as never as {
    stream: (i: unknown, c: unknown) => Promise<AsyncIterable<unknown>>;
  }).stream({ messages: [new HumanMessage("say hi")] }, runConfig);
  for await (const _chunk of stream) {
    // drain
  }

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;
  assert.ok(actualModelCalls >= 2, `expected >=2 model calls, got ${actualModelCalls}`);
  assert.equal(
    scope.meteredCalls().length,
    actualModelCalls,
    `agent made ${actualModelCalls} model calls but ${scope.meteredCalls().length} were billed`,
  );
});
