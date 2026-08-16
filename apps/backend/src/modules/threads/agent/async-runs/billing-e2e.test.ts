/**
 * E6 — billing settlement for a background delegate. The money-critical
 * invariant: every model call a delegate makes settles against the run's scope
 * exactly once. This drives the REAL async execution path — createDelegateRun
 * ContextResolver → createDelegateRunExecutor → createDelegateGraph → the billed
 * model — with the raw gateway mocked (no network/API key), and asserts
 * `meteredCalls === model-call-count`.
 *
 * The assertion holds regardless of how the delegate graph terminates (answer or
 * recursion cap), so it doesn't depend on the delegate's responseFormat details.
 * Self-skips without DATABASE_URL (the run config is read from real Postgres).
 */
import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { Pool } from "pg";
import {
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import type { ObserveSink, UsageInfo } from "@sourceweft/model-gateway";
import type { ContentBillingPort } from "../../../content";
import type { ModelUsageContext } from "../../../../shared/model-gateway/billing/context";

const rawMocks = vi.hoisted(() => ({
  getRawModelGatewayClient: vi.fn(),
  createRawAgentChatModel: vi.fn(),
}));
vi.mock("../../../../shared/model-gateway/internal/raw", () => rawMocks);

const { openBillingScope } = await import(
  "../../../../shared/model-gateway/billing/scope"
);
const { createBilledAgentChatModel } = await import(
  "../../../../shared/model-gateway/billing/langchain-proxy"
);
const { PostgresRunsStore } = await import("./postgres-store");
const { createDelegateRunContextResolver } = await import(
  "./run-context-resolver"
);
const { createDelegateRunExecutor } = await import("./delegate-executor");

const USAGE: UsageInfo = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

/** Emits a plain answer each call; records how many times it was invoked. */
class ScriptedChatModel extends BaseChatModel {
  generateCount = 0;
  constructor(
    private readonly sink: ObserveSink | undefined,
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }
  _llmType() {
    return "scripted";
  }
  bindTools() {
    return this;
  }
  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    this.generateCount += 1;
    await this.sink?.onGenerationEnd?.({ usage: USAGE } as never);
    const message = new AIMessage({
      content: "the delegate's answer",
      usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    });
    return { generations: [{ text: "the delegate's answer", message }] };
  }
  /**
   * The delegate makes a dedicated structured call after investigating. Model it
   * as a single model invocation (so it counts + emits usage for billing) that
   * returns a valid structured object — the harness stands in for the bridge's
   * available-tool strip, which on real DeepSeek succeeds and therefore settles.
   */
  withStructuredOutput(_schema: unknown, _config?: unknown) {
    return {
      invoke: async (messages: BaseMessage[]) => {
        await this._generate(messages);
        return { summary: "structured", steps: [] };
      },
    };
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresRunsStore(pool);
const createdThreads: string[] = [];

afterAll(async () => {
  for (const threadId of createdThreads) {
    await store.deleteThread(threadId);
  }
  await pool.end();
});

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

test.skipIf(!process.env.DATABASE_URL)(
  "E6: every model call a background delegate makes settles against the run scope",
  async () => {
    await store.ensureSchema();
    const thread = await store.createThread();
    createdThreads.push(thread.threadId);
    const run = await store.createRun({
      threadId: thread.threadId,
      graphId: "explore",
      multitaskStrategy: "reject",
      input: { messages: [{ role: "user", content: "investigate briefly" }] },
      context: {
        teamId: "team_1",
        workspaceId: "ws_1",
        userId: "user_1",
        modelAlias: "chat-default",
        providerModel: "deepseek-chat",
        profileAlias: "default",
        gatewayConfigId: "gw_1",
        parentThreadId: "thread_parent",
      },
    });

    // A real scope (observable) built the way the worker-job scope is, plus a
    // billed model over the mocked raw layer.
    const context: ModelUsageContext = {
      teamId: "team_1",
      workspaceId: "ws_1",
      actorUserId: "user_1",
      feature: "chat",
      intent: { mode: "billed" },
      scopeKind: "worker-job",
      scopeId: run.runId,
      threadId: "thread_parent",
    };
    const scope = openBillingScope({
      context,
      billing: createBilling(),
      billingMode: "enforced",
      availableCredits: 1000,
      meterUsage: meterUsageStub() as never,
    });

    let underlying: ScriptedChatModel | undefined;
    rawMocks.createRawAgentChatModel.mockImplementation(
      async (input: { observeSink?: ObserveSink }) => {
        underlying = new ScriptedChatModel(input.observeSink);
        return underlying;
      },
    );

    const resolver = createDelegateRunContextResolver({
      store,
      // Inject a gateway that opens our observable scope + billed model, instead
      // of the real admission/gateway path.
      openGateway: (async () => ({
        scope,
        gateway: {
          agentChatModel: async (a: {
            modelAlias: string;
            billing: Record<string, unknown>;
          }) =>
            createBilledAgentChatModel({
              modelAlias: a.modelAlias,
              context,
              scope,
              billing: a.billing as never,
            }),
        },
      })) as never,
      resolveBillingOrganizationId: async () => "team_1",
      getCheckpointer: async () => new MemorySaver(),
    });

    const execute = createDelegateRunExecutor(resolver);
    // The delegate graph may answer or hit its recursion cap; either way the
    // invariant below must hold. Swallow a recursion-cap throw.
    await execute(run, new AbortController().signal).catch(() => {});

    const calls = underlying?.generateCount ?? 0;
    assert.ok(calls >= 1, `the delegate model was invoked (${calls})`);
    assert.equal(
      scope.meteredCalls().length,
      calls,
      `delegate made ${calls} model calls but ${scope.meteredCalls().length} settled`,
    );
  },
);
