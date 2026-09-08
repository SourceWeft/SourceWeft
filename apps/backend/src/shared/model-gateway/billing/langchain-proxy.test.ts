import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
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

const USAGE: UsageInfo = { inputTokens: 10, outputTokens: 4 };

/**
 * Stands in for the gateway-built LangChain model: it reports usage through the
 * injected observe sink, exactly as the real bridge does, so the proxy is
 * exercised against the real usage-transport contract rather than a shortcut.
 */
function createFakeModel(sink: ObserveSink | undefined, usage: UsageInfo) {
  const report = async () => {
    await sink?.onGenerationEnd?.({ usage } as never);
  };

  const model: Record<string, unknown> = {
    getName: () => "fake",
    invoke: async () => {
      await report();
      return { content: "hi" };
    },
    stream: async () => {
      await report();
      return (async function* () {
        yield { content: "h" };
        yield { content: "i" };
      })();
    },
    bindTools: () => model,
    withStructuredOutput: () => ({
      invoke: async () => {
        await report();
        return { ok: true };
      },
    }),
  };
  return model;
}

function createBilling(): ContentBillingPort {
  return {
    getSummary: vi.fn(async (teamId: string) => ({
      teamId,
      billingMode: "enforced",
      credits: { available: 500, consumedThisCycle: 0 },
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
      availableCredits: 499,
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

function createScope(teamId = "team_1") {
  const context: ModelUsageContext = {
    teamId,
    workspaceId: "ws_1",
    actorUserId: "user_1",
    feature: "chat",
    intent: { mode: "billed" },
    scopeKind: "thread-turn",
    scopeId: `trace_${teamId}`,
  };
  return openBillingScope({
    context,
    billing: createBilling(),
    billingMode: "enforced",
    availableCredits: 500,
    meterUsage: meterUsageStub() as never,
  });
}

const billing = {
  modelKind: "chat" as const,
  profileAlias: "default-chat",
  gatewayConfigId: "gw_1",
};

async function buildModel(
  scope: ReturnType<typeof createScope>,
  usage = USAGE,
) {
  rawMocks.createRawAgentChatModel.mockImplementation(
    async (input: { observeSink?: ObserveSink }) =>
      createFakeModel(input.observeSink, usage),
  );
  return createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scope.context.scopeId,
      teamId: scope.context.teamId,
      workspaceId: scope.context.workspaceId!,
    },
    context: scope.context,
    scope,
    billing,
  });
}

beforeEach(() => {
  rawMocks.createRawAgentChatModel.mockReset();
});

test("trusted trace scope overrides request metadata without changing the payer", async () => {
  const scope = createScope("guest-payer");
  rawMocks.createRawAgentChatModel.mockImplementation(async (input) =>
    createFakeModel(input.observeSink, USAGE),
  );
  const model = await createBilledAgentChatModel({
    modelAlias: "chat-default",
    context: scope.context,
    scope,
    billing,
    observationContext: {
      traceId: "actual-trace",
      parentSpanId: "actual-parent",
      teamId: "workspace-owner",
      workspaceId: "ws_1",
    },
    execution: {
      metadata: {
        traceId: "forged-trace",
        teamId: "forged-team",
        workspaceId: "forged-workspace",
      },
    },
  });
  const metadata =
    rawMocks.createRawAgentChatModel.mock.calls[0]![0].execution.metadata;
  assert.equal(metadata.traceId, "actual-trace");
  assert.equal(metadata.parentSpanId, "actual-parent");
  assert.equal(metadata.teamId, "workspace-owner");
  assert.equal(metadata.workspaceId, "ws_1");
  await model.invoke("hello");
  assert.equal(scope.context.teamId, "guest-payer");
  assert.equal(scope.meteredCalls().length, 1);
});

test("missing trace identity fails before the model is created or billed", async () => {
  const scope = createScope();
  await assert.rejects(
    createBilledAgentChatModel({
      modelAlias: "chat-default",
      context: scope.context,
      scope,
      billing,
      observationContext: {
        traceId: " ",
        teamId: "team_1",
        workspaceId: "ws_1",
      },
    }),
    /LLM_TRACE_CONTEXT_REQUIRED/,
  );
  assert.equal(rawMocks.createRawAgentChatModel.mock.calls.length, 0);
  assert.equal(scope.meteredCalls().length, 0);
});

test("invoke settles exactly once with the usage the sink reported", async () => {
  const scope = createScope();
  const model = (await buildModel(scope)) as unknown as {
    invoke: (i: unknown) => Promise<unknown>;
  };

  await model.invoke([{ role: "user", content: "hi" }]);

  assert.equal(scope.meteredCalls().length, 1);
  assert.deepEqual(scope.meteredCalls()[0]?.usage, USAGE);
});

test("billing survives bindTools composition", async () => {
  const scope = createScope();
  const model = (await buildModel(scope)) as unknown as {
    bindTools: (t: unknown[]) => { invoke: (i: unknown) => Promise<unknown> };
  };

  await model
    .bindTools([{ name: "t" }])
    .invoke([{ role: "user", content: "hi" }]);

  assert.equal(scope.meteredCalls().length, 1);
});

// The gap the old Object.create shim had: structured output bypassed billing.
test("billing survives withStructuredOutput composition", async () => {
  const scope = createScope();
  const model = (await buildModel(scope)) as unknown as {
    withStructuredOutput: (
      s: unknown,
      c: unknown,
    ) => { invoke: (i: unknown) => Promise<unknown> };
  };

  await model
    .withStructuredOutput({ type: "object" }, { includeRaw: true, name: "R" })
    .invoke([{ role: "user", content: "hi" }]);

  assert.equal(scope.meteredCalls().length, 1);
});

test("billing survives bindTools then withStructuredOutput", async () => {
  const scope = createScope();
  const model = (await buildModel(scope)) as unknown as {
    bindTools: (t: unknown[]) => {
      withStructuredOutput: (
        s: unknown,
        c: unknown,
      ) => { invoke: (i: unknown) => Promise<unknown> };
    };
  };

  await model
    .bindTools([{ name: "t" }])
    .withStructuredOutput({ type: "object" }, { includeRaw: true, name: "R" })
    .invoke([{ role: "user", content: "hi" }]);

  assert.equal(scope.meteredCalls().length, 1);
});

// Regression: withConfig and bind return a new runnable wrapping the model.
// langchain@1.5's agent runtime calls withConfig 34 times and deepagents calls
// bind 5 times, so treating either as an inert pass-through would let
// effectively every agent model call escape unbilled.
test("billing survives withConfig composition", async () => {
  const scope = createScope();
  rawMocks.createRawAgentChatModel.mockImplementation(
    async (input: { observeSink?: ObserveSink }) => {
      const model = createFakeModel(input.observeSink, USAGE);
      model.withConfig = () => model;
      model.bind = () => model;
      return model;
    },
  );
  const model = (await createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scope.context.scopeId,
      teamId: scope.context.teamId,
      workspaceId: scope.context.workspaceId!,
    },
    context: scope.context,
    scope,
    billing,
  })) as unknown as {
    withConfig: (c: unknown) => { invoke: (i: unknown) => Promise<unknown> };
  };

  await model.withConfig({ tags: ["x"] }).invoke([]);

  assert.equal(scope.meteredCalls().length, 1);
});

test("billing survives bind composition", async () => {
  const scope = createScope();
  rawMocks.createRawAgentChatModel.mockImplementation(
    async (input: { observeSink?: ObserveSink }) => {
      const model = createFakeModel(input.observeSink, USAGE);
      model.bind = () => model;
      return model;
    },
  );
  const model = (await createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scope.context.scopeId,
      teamId: scope.context.teamId,
      workspaceId: scope.context.workspaceId!,
    },
    context: scope.context,
    scope,
    billing,
  })) as unknown as {
    bind: (c: unknown) => { invoke: (i: unknown) => Promise<unknown> };
  };

  await model.bind({ stop: [] }).invoke([]);

  assert.equal(scope.meteredCalls().length, 1);
});

test("billing survives bindTools then withConfig", async () => {
  const scope = createScope();
  rawMocks.createRawAgentChatModel.mockImplementation(
    async (input: { observeSink?: ObserveSink }) => {
      const model = createFakeModel(input.observeSink, USAGE);
      model.withConfig = () => model;
      return model;
    },
  );
  const model = (await createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scope.context.scopeId,
      teamId: scope.context.teamId,
      workspaceId: scope.context.workspaceId!,
    },
    context: scope.context,
    scope,
    billing,
  })) as unknown as {
    bindTools: (t: unknown[]) => {
      withConfig: (c: unknown) => { invoke: (i: unknown) => Promise<unknown> };
    };
  };

  await model
    .bindTools([{ name: "t" }])
    .withConfig({})
    .invoke([]);

  assert.equal(scope.meteredCalls().length, 1);
});

test("a drained stream settles exactly once", async () => {
  const scope = createScope();
  const model = (await buildModel(scope)) as unknown as {
    stream: (i: unknown) => Promise<AsyncIterable<unknown>>;
  };

  const stream = await model.stream([{ role: "user", content: "hi" }]);
  for await (const _chunk of stream) {
    // drain
  }

  assert.equal(scope.meteredCalls().length, 1);
});

test("a stream abandoned early still settles once", async () => {
  const scope = createScope();
  const model = (await buildModel(scope)) as unknown as {
    stream: (i: unknown) => Promise<AsyncIterable<unknown>>;
  };

  const stream = await model.stream([{ role: "user", content: "hi" }]);
  for await (const _chunk of stream) {
    break;
  }

  assert.equal(scope.meteredCalls().length, 1);
});

test("two invocations settle separately rather than reusing stale usage", async () => {
  const scope = createScope();
  const model = (await buildModel(scope)) as unknown as {
    invoke: (i: unknown) => Promise<unknown>;
  };

  await model.invoke([{ role: "user", content: "one" }]);
  await model.invoke([{ role: "user", content: "two" }]);

  assert.equal(scope.meteredCalls().length, 2);
});

// The agent runtime can drive one model concurrently, so two in-flight calls
// must not read each other's usage out of a shared capture slot.
test("concurrent invocations on one model settle with their own usage", async () => {
  const scope = createScope();

  let call = 0;
  rawMocks.createRawAgentChatModel.mockImplementation(
    async (input: { observeSink?: ObserveSink }) => ({
      getName: () => "fake",
      invoke: async (messages: unknown) => {
        const tokens = (messages as { tokens: number }).tokens;
        // Usage is reported before the call finishes resolving, which is the
        // real shape: the gateway emits generation-end, then post-processing
        // runs. That leaves a window for a second call to report over it.
        await input.observeSink?.onGenerationEnd?.({
          usage: { inputTokens: tokens },
        } as never);
        await new Promise((resolve) =>
          setTimeout(resolve, tokens === 1 ? 20 : 1),
        );
        call += 1;
        return { content: "ok" };
      },
      stream: async () => (async function* () {})(),
      bindTools() {
        return this;
      },
    }),
  );

  const model = (await createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scope.context.scopeId,
      teamId: scope.context.teamId,
      workspaceId: scope.context.workspaceId!,
    },
    context: scope.context,
    scope,
    billing,
  })) as unknown as { invoke: (i: unknown) => Promise<unknown> };

  await Promise.all([model.invoke({ tokens: 1 }), model.invoke({ tokens: 2 })]);

  assert.equal(call, 2);
  const seen = scope
    .meteredCalls()
    .map((trace) => trace.usage?.inputTokens)
    .sort();
  assert.deepEqual(seen, [1, 2]);
});

// Directly targets the process-wide client cache hazard: usage captured for one
// team must never be attributed to another.
test("concurrent models for different teams do not cross usage", async () => {
  const scopeA = createScope("team_1");
  const scopeB = createScope("team_2");

  rawMocks.createRawAgentChatModel.mockImplementation(
    async (input: {
      observeSink?: ObserveSink;
      execution?: { metadata?: { teamId?: string } };
    }) =>
      createFakeModel(
        input.observeSink,
        input.execution?.metadata?.teamId === "team_2"
          ? { inputTokens: 999 }
          : { inputTokens: 1 },
      ),
  );

  const modelA = (await createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scopeA.context.scopeId,
      teamId: scopeA.context.teamId,
      workspaceId: scopeA.context.workspaceId!,
    },
    context: scopeA.context,
    scope: scopeA,
    billing,
  })) as unknown as { invoke: (i: unknown) => Promise<unknown> };
  const modelB = (await createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scopeB.context.scopeId,
      teamId: scopeB.context.teamId,
      workspaceId: scopeB.context.workspaceId!,
    },
    context: scopeB.context,
    scope: scopeB,
    billing,
  })) as unknown as { invoke: (i: unknown) => Promise<unknown> };

  await Promise.all([modelA.invoke([]), modelB.invoke([])]);

  assert.equal(scopeA.meteredCalls()[0]?.usage?.inputTokens, 1);
  assert.equal(scopeB.meteredCalls()[0]?.usage?.inputTokens, 999);
});
