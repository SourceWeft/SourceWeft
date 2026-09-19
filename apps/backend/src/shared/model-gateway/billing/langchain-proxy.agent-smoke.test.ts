import { adaptBillingTestPort } from "../../../test/billing-runtime";
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
import { createAgent } from "langchain";
import { z } from "zod";
import type { ObserveSink, UsageInfo } from "@sourceweft/model-gateway";
import type { LegacyBillingTestPort as ContentBillingPort } from "../../../test/billing-runtime";
import type { ModelUsageContext } from "./context";
import { openBillingScope } from "./scope";

const rawMocks = vi.hoisted(() => ({
  getRawModelGatewayClient: vi.fn(),
  createRawAgentChatModel: vi.fn(),
}));

vi.mock("../internal/raw", () => rawMocks);

const { createBilledAgentChatModel } = await import("./langchain-proxy");

const USAGE: UsageInfo = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

/**
 * A real BaseChatModel, so the agent runtime drives it exactly as it drives a
 * gateway-built model — through whatever composition (bindTools, withConfig,
 * bind) LangGraph chooses internally.
 *
 * It reports usage through the injected observe sink from inside the call,
 * mirroring the real bridge, which is what the billing proxy captures.
 */
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

  /**
   * The agent runtime refuses a model without bindTools. Returning the model
   * itself keeps the fake minimal; the wrapper's job of re-proxying whatever
   * bindTools returns is pinned separately in langchain-proxy.test.ts, along
   * with the withConfig and bind composition paths.
   */
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
  return adaptBillingTestPort({
    getSummary: vi.fn(async (teamId: string) => ({
      teamId,
      billingMode: "enforced",
      credits: { available: 1000, consumedThisCycle: 0 },
    })),
    meterConsume: vi.fn(),
    meterIngestion: vi.fn(),
  }) as unknown as ContentBillingPort;
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

async function buildAgentWithBilledModel(
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

  const agent = createAgent({ model: model as never, tools: [echo] });
  return { agent, scope, getUnderlying: () => underlying };
}

/**
 * The load-bearing verification for replacing the post-hoc accounting in
 * llm-call-billing.ts: the proxy must bill for every model call the real agent
 * runtime actually makes, not merely for the ones a hand-written fake makes.
 */
test("every model call a real agent makes is billed exactly once", async () => {
  const { agent, scope, getUnderlying } = await buildAgentWithBilledModel([
    {
      content: "",
      toolCalls: [{ id: "call_1", name: "echo", args: { text: "hi" } }],
    },
    { content: "All done." },
  ]);

  await agent.invoke({ messages: [new HumanMessage("say hi")] });

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;

  // Two turns of the agent loop: one emitting a tool call, one concluding.
  assert.equal(actualModelCalls, 2);
  assert.equal(
    scope.meteredCalls().length,
    actualModelCalls,
    `agent made ${actualModelCalls} model calls but ${scope.meteredCalls().length} were billed`,
  );
  for (const trace of scope.meteredCalls()) {
    assert.equal(trace.billingStatus, "metered");
    assert.deepEqual(trace.usage, USAGE);
  }
});

test("a single-shot agent turn is billed exactly once", async () => {
  const { agent, scope, getUnderlying } = await buildAgentWithBilledModel([
    { content: "Immediate answer." },
  ]);

  await agent.invoke({ messages: [new HumanMessage("hello")] });

  assert.equal(getUnderlying()?.generateCount, 1);
  assert.equal(scope.meteredCalls().length, 1);
});

test("a streamed agent turn bills every model call", async () => {
  const { agent, scope, getUnderlying } = await buildAgentWithBilledModel([
    {
      content: "",
      toolCalls: [{ id: "call_1", name: "echo", args: { text: "hi" } }],
    },
    { content: "Done streaming." },
  ]);

  for await (const _chunk of await agent.stream({
    messages: [new HumanMessage("say hi")],
  })) {
    // drain
  }

  const actualModelCalls = getUnderlying()?.generateCount ?? 0;
  assert.equal(actualModelCalls, 2);
  assert.equal(scope.meteredCalls().length, actualModelCalls);
});
