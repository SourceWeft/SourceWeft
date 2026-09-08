import { adaptBillingTestPort } from "../../../test/billing-runtime";
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ObserveSink, UsageInfo } from "@sourceweft/model-gateway";
import type { LegacyBillingTestPort as ContentBillingPort } from "../../../test/billing-runtime";
import type { ModelUsageContext } from "./context";
import type { MeterUsageFn } from "./settle";
import { openBillingScope } from "./scope";
import { captureGenerationUsage } from "./usage-capture";

const rawMocks = vi.hoisted(() => ({
  getRawModelGatewayClient: vi.fn(),
  createRawAgentChatModel: vi.fn(),
}));
vi.mock("../internal/raw", () => rawMocks);
vi.mock("../thinking-defaults", () => ({
  resolveChatThinkingWithDefaults: async (input: { thinking?: unknown }) =>
    input.thinking,
}));

const { createBilledAgentChatModel } = await import("./langchain-proxy");
const { openBilledModelGateway } = await import("../billed-client");

const PARTIAL_USAGE: UsageInfo = { inputTokens: 19, outputTokens: 3 };
const billingOptions = {
  modelKind: "chat" as const,
  profileAlias: "default-chat",
  gatewayConfigId: "gw_test",
};
const streamOptions = { ...billingOptions, operation: "chat.stream" };

function context(teamId: string): ModelUsageContext {
  return {
    teamId,
    workspaceId: `workspace_${teamId}`,
    actorUserId: "actor_test",
    feature: "chat",
    intent: { mode: "billed" },
    scopeKind: "thread-turn",
    scopeId: `trace_${teamId}`,
  };
}

function billingPort(): ContentBillingPort {
  return adaptBillingTestPort({
    getSummary: vi.fn(async (teamId: string) => ({
      teamId,
      billingMode: "enforced",
      credits: { available: 500, consumedThisCycle: 0 },
    })),
    meterConsume: vi.fn(),
    meterIngestion: vi.fn(),
  }) as unknown as ContentBillingPort;
}

function meterStub() {
  return vi.fn(async (input: Parameters<MeterUsageFn>[0]) => ({
    billing: {
      teamId: input.teamId,
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

function scopeHarness(teamId = "native_team") {
  const meterUsage = meterStub();
  const scope = openBillingScope({
    context: context(teamId),
    billing: billingPort(),
    billingMode: "enforced",
    availableCredits: 500,
    meterUsage: meterUsage as never,
  });
  return { scope, meterUsage, settle: vi.spyOn(scope, "settle") };
}

type TestModel = {
  invoke(input: unknown): Promise<unknown>;
  stream(input: unknown): Promise<AsyncIterable<unknown>>;
};

async function billedModel(scope: ReturnType<typeof scopeHarness>["scope"]) {
  return (await createBilledAgentChatModel({
    modelAlias: "chat-default",
    observationContext: {
      traceId: scope.context.scopeId,
      teamId: scope.context.teamId,
      workspaceId: scope.context.workspaceId!,
    },
    context: scope.context,
    scope,
    billing: billingOptions,
  })) as unknown as TestModel;
}

// Deliberately report only from return(), after an await. This models the
// gateway's onGenerationError callback during aborted-stream cleanup, where
// partial usage arrives after the consumer has stopped receiving chunks.
function closeReportingIterator(
  report: () => Promise<void>,
  errors: { next?: Error; close?: Error } = {},
) {
  let count = 0;
  const iterator: AsyncIterableIterator<unknown> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: vi.fn(async () => {
      if (count++ === 0)
        return {
          done: false as const,
          value: { type: "chunk", chunk: { content: "partial" } },
        };
      if (errors.next) throw errors.next;
      return { done: true as const, value: undefined };
    }),
    return: vi.fn(async () => {
      await Promise.resolve();
      await report();
      if (errors.close) throw errors.close;
      return { done: true as const, value: undefined };
    }),
  };
  return iterator;
}

beforeEach(() => {
  rawMocks.getRawModelGatewayClient.mockReset();
  rawMocks.createRawAgentChatModel.mockReset();
});

test("native stream.return captures late onGenerationError partial usage and settles exactly once", async () => {
  const { scope, meterUsage, settle } = scopeHarness();
  let rawIterator: AsyncIterableIterator<unknown>;
  rawMocks.createRawAgentChatModel.mockImplementation(
    async ({ observeSink }: { observeSink: ObserveSink }) => ({
      stream: async () => {
        rawIterator = closeReportingIterator(async () => {
          await observeSink.onGenerationError?.({
            usage: PARTIAL_USAGE,
          } as never);
        });
        return rawIterator;
      },
    }),
  );
  const model = await billedModel(scope);
  const stream = (await model.stream([]))[Symbol.asyncIterator]();
  await stream.next();
  assert.equal(settle.mock.calls.length, 0);

  await stream.return!();
  await stream.return!();

  assert.equal(settle.mock.calls.length, 1);
  assert.equal(vi.mocked(rawIterator!.return!).mock.calls.length, 1);
  assert.equal(meterUsage.mock.calls.length, 1);
  assert.deepEqual(meterUsage.mock.calls[0]?.[0].usage, PARTIAL_USAGE);
  assert.deepEqual(scope.meteredCalls()[0]?.usage, PARTIAL_USAGE);
});

test("native return failure still settles partial usage and preserves close error over settlement failure", async () => {
  const { scope, meterUsage, settle } = scopeHarness();
  const closeError = new Error("reader close failed");
  meterUsage.mockRejectedValueOnce(new Error("meter unavailable"));
  rawMocks.createRawAgentChatModel.mockImplementation(
    async ({ observeSink }: { observeSink: ObserveSink }) => ({
      stream: async () =>
        closeReportingIterator(
          async () => {
            await observeSink.onGenerationError?.({
              usage: PARTIAL_USAGE,
            } as never);
          },
          { close: closeError },
        ),
    }),
  );
  const stream = (await (await billedModel(scope)).stream([]))[
    Symbol.asyncIterator
  ]();
  await stream.next();
  await assert.rejects(
    async () => stream.return!(),
    (error) => error === closeError,
  );
  assert.equal(settle.mock.calls.length, 1);
  assert.equal(meterUsage.mock.calls.length, 1);
  assert.deepEqual(meterUsage.mock.calls[0]?.[0].usage, PARTIAL_USAGE);
});

test("an opened native stream closed before its first next still releases and settles", async () => {
  const { scope, meterUsage, settle } = scopeHarness();
  let rawIterator: AsyncIterableIterator<unknown>;
  rawMocks.createRawAgentChatModel.mockImplementation(
    async ({ observeSink }: { observeSink: ObserveSink }) => ({
      stream: async () => {
        rawIterator = closeReportingIterator(async () => {
          await observeSink.onGenerationError?.({
            usage: PARTIAL_USAGE,
          } as never);
        });
        return rawIterator;
      },
    }),
  );
  const stream = (await (await billedModel(scope)).stream([]))[
    Symbol.asyncIterator
  ]();
  await stream.return!();
  assert.equal(vi.mocked(rawIterator!.return!).mock.calls.length, 1);
  assert.equal(settle.mock.calls.length, 1);
  assert.equal(meterUsage.mock.calls.length, 1);
  assert.deepEqual(scope.meteredCalls()[0]?.usage, PARTIAL_USAGE);
});

test("native next failure is not replaced by close or settlement errors", async () => {
  const { scope, meterUsage, settle } = scopeHarness();
  const upstreamError = new Error("provider failed after partial output");
  meterUsage.mockRejectedValueOnce(new Error("meter unavailable"));
  rawMocks.createRawAgentChatModel.mockImplementation(
    async ({ observeSink }: { observeSink: ObserveSink }) => ({
      stream: async () =>
        closeReportingIterator(
          async () => {
            await observeSink.onGenerationError?.({
              usage: PARTIAL_USAGE,
            } as never);
          },
          { next: upstreamError, close: new Error("close also failed") },
        ),
    }),
  );
  const stream = (await (await billedModel(scope)).stream([]))[
    Symbol.asyncIterator
  ]();
  await stream.next();
  await assert.rejects(
    async () => stream.next(),
    (error) => error === upstreamError,
  );
  assert.equal(settle.mock.calls.length, 1);
  assert.equal(meterUsage.mock.calls.length, 1);
  assert.deepEqual(meterUsage.mock.calls[0]?.[0].usage, PARTIAL_USAGE);
});

test.each(["invoke", "stream"] as const)(
  "native %s creation failure reports partial usage and still settles",
  async (method) => {
    const { scope, meterUsage, settle } = scopeHarness();
    const upstreamError = new Error(`${method} failed during creation`);
    rawMocks.createRawAgentChatModel.mockImplementation(
      async ({ observeSink }: { observeSink: ObserveSink }) => ({
        [method]: async () => {
          await observeSink.onGenerationError?.({
            usage: PARTIAL_USAGE,
          } as never);
          throw upstreamError;
        },
      }),
    );
    const model = await billedModel(scope);
    await assert.rejects(
      async () => model[method]([]),
      (error) => error === upstreamError,
    );
    assert.equal(settle.mock.calls.length, 1);
    assert.equal(meterUsage.mock.calls.length, 1);
    assert.deepEqual(scope.meteredCalls()[0]?.usage, PARTIAL_USAGE);
  },
);

test("raw billedStream captures return-time usage without a terminal metadata event", async () => {
  const rawIterator = closeReportingIterator(async () => {
    captureGenerationUsage({ usage: PARTIAL_USAGE });
  });
  rawMocks.getRawModelGatewayClient.mockResolvedValue({
    chat: { stream: () => rawIterator },
  });
  const meterUsage = meterStub();
  const { gateway, scope } = await openBilledModelGateway({
    billing: billingPort(),
    context: context("raw_team"),
    meterUsage: meterUsage as never,
  });
  const settle = vi.spyOn(scope, "settle");
  const stream = gateway.chat
    .stream({ model: "test", messages: [] }, streamOptions)
    [Symbol.asyncIterator]();
  const event = await stream.next();
  assert.equal(event.value.type, "chunk");
  assert.equal(meterUsage.mock.calls.length, 0);
  await stream.return!();
  await stream.return!();
  assert.equal(settle.mock.calls.length, 1);
  assert.equal(meterUsage.mock.calls.length, 1);
  assert.deepEqual(scope.meteredCalls()[0]?.usage, PARTIAL_USAGE);
  assert.equal(vi.mocked(rawIterator.return!).mock.calls.length, 1);
});

test("concurrent native and raw stream cleanup keeps each call's usage isolated", async () => {
  const { scope: nativeScope, meterUsage: nativeMeter } = scopeHarness();
  const rawMeter = meterStub();
  let reports = 0;
  let release: () => void;
  const allReported = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitForOtherReports = async () => {
    reports += 1;
    if (reports === 3) release();
    await allReported;
  };
  rawMocks.createRawAgentChatModel.mockImplementation(
    async ({ observeSink }: { observeSink: ObserveSink }) => ({
      stream: async ({ tokens }: { tokens: number }) =>
        closeReportingIterator(async () => {
          await observeSink.onGenerationError?.({
            usage: { inputTokens: tokens },
          } as never);
          await waitForOtherReports();
        }),
    }),
  );
  rawMocks.getRawModelGatewayClient.mockResolvedValue({
    chat: {
      stream: ({ model }: { model: string }) =>
        closeReportingIterator(async () => {
          if (model === "unknown") return;
          captureGenerationUsage({ usage: { inputTokens: 33 } });
          await waitForOtherReports();
        }),
    },
  });
  const native = await billedModel(nativeScope);
  const { gateway, scope: rawScope } = await openBilledModelGateway({
    billing: billingPort(),
    context: context("raw_team"),
    meterUsage: rawMeter as never,
  });
  const a = (await native.stream({ tokens: 11 }))[Symbol.asyncIterator]();
  const b = (await native.stream({ tokens: 22 }))[Symbol.asyncIterator]();
  const c = gateway.chat
    .stream({ model: "known", messages: [] }, streamOptions)
    [Symbol.asyncIterator]();
  await Promise.all([a.next(), b.next(), c.next()]);
  await Promise.all([a.return!(), b.return!(), c.return!()]);
  assert.deepEqual(
    nativeScope
      .meteredCalls()
      .map((call) => call.usage?.inputTokens)
      .sort(),
    [11, 22],
  );
  assert.deepEqual(
    rawScope.meteredCalls().map((call) => call.usage?.inputTokens),
    [33],
  );
  assert.equal(nativeMeter.mock.calls.length, 2);
  assert.equal(rawMeter.mock.calls.length, 1);
  assert.ok(
    nativeMeter.mock.calls.every(([input]) => input.teamId === "native_team"),
  );
  assert.equal(rawMeter.mock.calls[0]?.[0].teamId, "raw_team");

  const unknown = gateway.chat
    .stream({ model: "unknown", messages: [] }, streamOptions)
    [Symbol.asyncIterator]();
  await unknown.next();
  await unknown.return!();
  assert.equal(
    rawScope.meteredCalls().length,
    1,
    "unknown usage must not borrow a previous call's usage",
  );
  assert.equal(
    rawMeter.mock.calls.length,
    1,
    "unknown usage must never reach metering",
  );
});

test("raw stream creation errors with observed usage still settle and retain the original error", async () => {
  const upstreamError = new Error("raw stream creation failed");
  rawMocks.getRawModelGatewayClient.mockResolvedValue({
    chat: {
      stream: () => {
        captureGenerationUsage({ usage: PARTIAL_USAGE });
        throw upstreamError;
      },
    },
  });
  const meterUsage = meterStub();
  const { gateway, scope } = await openBilledModelGateway({
    billing: billingPort(),
    context: context("raw_team"),
    meterUsage: meterUsage as never,
  });
  const settle = vi.spyOn(scope, "settle");
  const stream = gateway.chat
    .stream({ model: "test", messages: [] }, streamOptions)
    [Symbol.asyncIterator]();
  await assert.rejects(
    async () => stream.next(),
    (error) => error === upstreamError,
  );
  assert.equal(settle.mock.calls.length, 1);
  assert.equal(meterUsage.mock.calls.length, 1);
  assert.deepEqual(scope.meteredCalls()[0]?.usage, PARTIAL_USAGE);
});

test.each([false, true])(
  "raw stream cleanup settles when return fails (upstream already failed: %s)",
  async (nextFailed) => {
    const upstreamError = new Error("raw upstream interrupted");
    const closeError = new Error("raw cleanup failed");
    const rawIterator = closeReportingIterator(
      async () => {
        captureGenerationUsage({ usage: PARTIAL_USAGE });
      },
      { next: nextFailed ? upstreamError : undefined, close: closeError },
    );
    rawMocks.getRawModelGatewayClient.mockResolvedValue({
      chat: { stream: () => rawIterator },
    });
    const meterUsage = meterStub();
    meterUsage.mockRejectedValueOnce(new Error("meter unavailable"));
    const { gateway, scope } = await openBilledModelGateway({
      billing: billingPort(),
      context: context("raw_team"),
      meterUsage: meterUsage as never,
    });
    const settle = vi.spyOn(scope, "settle");
    const stream = gateway.chat
      .stream({ model: "test", messages: [] }, streamOptions)
      [Symbol.asyncIterator]();
    await stream.next();
    await assert.rejects(
      async () => (nextFailed ? stream.next() : stream.return!()),
      (error) => error === (nextFailed ? upstreamError : closeError),
    );
    assert.equal(settle.mock.calls.length, 1);
    assert.equal(meterUsage.mock.calls.length, 1);
    assert.deepEqual(meterUsage.mock.calls[0]?.[0].usage, PARTIAL_USAGE);
    assert.equal(vi.mocked(rawIterator.return!).mock.calls.length, 1);
  },
);

test("unknown native usage does not reach the meter after a previous billed call", async () => {
  const { scope, meterUsage, settle } = scopeHarness();
  rawMocks.createRawAgentChatModel.mockImplementation(
    async ({ observeSink }: { observeSink: ObserveSink }) => ({
      stream: async ({ known }: { known: boolean }) =>
        closeReportingIterator(async () => {
          await observeSink.onGenerationError?.({
            usage: known ? PARTIAL_USAGE : undefined,
          } as never);
        }),
    }),
  );
  const model = await billedModel(scope);
  for (const known of [true, false]) {
    const stream = (await model.stream({ known }))[Symbol.asyncIterator]();
    await stream.next();
    await stream.return!();
  }
  assert.equal(settle.mock.calls.length, 2);
  assert.equal(settle.mock.calls[1]?.[0].usage, undefined);
  assert.equal(meterUsage.mock.calls.length, 1);
  assert.equal(scope.meteredCalls().length, 1);
});
