import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../modules/content/billing-port";
import type { ModelUsageContext } from "./billing/context";

const rawMocks = vi.hoisted(() => ({
  getRawModelGatewayClient: vi.fn(),
  createRawAgentChatModel: vi.fn(),
}));

vi.mock("./internal/raw", () => rawMocks);

const { withBilledModelGateway } = await import("./billed-client");

const USAGE = { inputTokens: 10, outputTokens: 4 };

function createBilling(billingMode = "enforced", available = 500): ContentBillingPort {
  return {
    getSummary: vi.fn(
      async (teamId: string) =>
        ({
          teamId,
          billingMode,
          credits: { available, consumedThisCycle: 0 },
        }) as unknown as BillingSummaryResponse,
    ),
    meterConsume: vi.fn(),
    meterIngestion: vi.fn(),
  } as unknown as ContentBillingPort;
}

function meterUsageStub() {
  return vi.fn(async () => ({
    billing: {
      teamId: "team_1",
      consumedCredits: 2,
      availableCredits: 498,
      consumedThisCycle: 2,
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

const context: ModelUsageContext = {
  teamId: "team_1",
  workspaceId: "ws_1",
  actorUserId: "user_1",
  feature: "chat",
  intent: { mode: "billed" },
  scopeKind: "thread-turn",
  scopeId: "trace_1",
};

const chatOptions = {
  operation: "chat.complete",
  modelKind: "chat" as const,
  profileAlias: "default-chat",
  gatewayConfigId: "gw_1",
};

function fakeGateway(overrides: Record<string, unknown> = {}) {
  return {
    chat: {
      complete: vi.fn(async () => ({ model: "m", usage: USAGE, raw: {} })),
      stream: vi.fn(),
    },
    embeddings: {
      embed: vi.fn(async () => ({ model: "m", embedding: [1], usage: USAGE, raw: {} })),
      embedBatch: vi.fn(),
    },
    rerank: { rank: vi.fn(async () => ({ model: "m", results: [], usage: USAGE, raw: {} })) },
    asr: { transcribe: vi.fn() },
    tts: { speech: vi.fn(async () => ({ model: "m", audio: new Blob([]), usage: USAGE })) },
    images: { generate: vi.fn() },
    ...overrides,
  };
}

function streamOf(events: unknown[]) {
  return async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

beforeEach(() => {
  rawMocks.getRawModelGatewayClient.mockReset();
  rawMocks.createRawAgentChatModel.mockReset();
});

test("a non-streaming call settles exactly once with the returned usage", async () => {
  const gateway = fakeGateway();
  rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);
  const meterUsage = meterUsageStub();

  const traces = await withBilledModelGateway(
    { billing: createBilling(), context, meterUsage: meterUsage as never },
    async (gw, scope) => {
      await gw.chat.complete({ model: "m", messages: [] } as never, chatOptions);
      return scope.meteredCalls();
    },
  );

  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.billingStatus, "metered");
  assert.equal(meterUsage.mock.calls.length, 1);
});

test("the caller cannot override the billing identity in request metadata", async () => {
  const gateway = fakeGateway();
  rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);

  await withBilledModelGateway(
    { billing: createBilling(), context, meterUsage: meterUsageStub() as never },
    async (gw) => {
      await gw.chat.complete({ model: "m", messages: [] } as never, chatOptions);
    },
  );

  const passedOptions = (
    gateway.chat.complete.mock.calls as unknown as unknown[][]
  )[0]?.[1] as { metadata?: Record<string, unknown> };
  assert.equal(passedOptions.metadata?.teamId, "team_1");
  assert.equal(passedOptions.metadata?.gatewayConfigId, "gw_1");
  assert.equal(passedOptions.metadata?.profileAlias, "default-chat");
});

test("a fully drained stream settles once with last-wins usage", async () => {
  const gateway = fakeGateway({
    chat: {
      complete: vi.fn(),
      stream: vi.fn(
        streamOf([
          { type: "chunk", chunk: {} },
          { type: "metadata", metadata: { usage: { inputTokens: 1 } } },
          { type: "metadata", metadata: { usage: USAGE } },
        ]),
      ),
    },
  });
  rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);
  const meterUsage = meterUsageStub();

  const traces = await withBilledModelGateway(
    { billing: createBilling(), context, meterUsage: meterUsage as never },
    async (gw, scope) => {
      for await (const _event of gw.chat.stream({ model: "m", messages: [] } as never, chatOptions)) {
        // drain
      }
      return scope.meteredCalls();
    },
  );

  assert.equal(traces.length, 1);
  assert.deepEqual(traces[0]?.usage, USAGE);
});

// Regression: abandoning a stream early used to lose its usage entirely,
// because the terminal metadata event was never reached.
test("a stream abandoned early still settles once", async () => {
  const gateway = fakeGateway({
    chat: {
      complete: vi.fn(),
      stream: vi.fn(
        streamOf([
          { type: "metadata", metadata: { usage: USAGE } },
          { type: "chunk", chunk: {} },
          { type: "chunk", chunk: {} },
        ]),
      ),
    },
  });
  rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);
  const meterUsage = meterUsageStub();

  const traces = await withBilledModelGateway(
    { billing: createBilling(), context, meterUsage: meterUsage as never },
    async (gw, scope) => {
      for await (const _event of gw.chat.stream({ model: "m", messages: [] } as never, chatOptions)) {
        break;
      }
      return scope.meteredCalls();
    },
  );

  assert.equal(traces.length, 1);
  assert.equal(meterUsage.mock.calls.length, 1);
  assert.deepEqual(traces[0]?.usage, USAGE);
});

test("a stream that throws mid-flight still settles once and propagates the original error", async () => {
  const gateway = fakeGateway({
    chat: {
      complete: vi.fn(),
      stream: vi.fn(async function* () {
        yield { type: "metadata", metadata: { usage: USAGE } };
        throw new Error("provider exploded");
      }),
    },
  });
  rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);
  const meterUsage = meterUsageStub();

  const captured: { error?: unknown; traces?: unknown } = {};
  await withBilledModelGateway(
    { billing: createBilling(), context, meterUsage: meterUsage as never },
    async (gw, scope) => {
      try {
        for await (const _event of gw.chat.stream({ model: "m", messages: [] } as never, chatOptions)) {
          // consume until it throws
        }
      } catch (error) {
        captured.error = error;
      }
      captured.traces = scope.meteredCalls();
    },
  );

  assert.equal((captured.error as Error).message, "provider exploded");
  assert.equal((captured.traces as unknown[]).length, 1);
  assert.equal(meterUsage.mock.calls.length, 1);
});

// Admission is the point of pre-flight: no model call should be attempted at all.
test("admission denial throws before any model call is made", async () => {
  const gateway = fakeGateway();
  rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);

  const error = await withBilledModelGateway(
    { billing: createBilling("enforced", 0), context },
    async (gw) => {
      await gw.chat.complete({ model: "m", messages: [] } as never, chatOptions);
    },
  )
    .then(() => null)
    .catch((thrown: unknown) => thrown);

  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, "BILLING_ADMISSION_DENIED");
  assert.equal(gateway.chat.complete.mock.calls.length, 0);
});

test("each scope gets a freshly wrapped gateway rather than a shared cached one", async () => {
  rawMocks.getRawModelGatewayClient.mockResolvedValue(fakeGateway());

  const first = await withBilledModelGateway(
    { billing: createBilling(), context, meterUsage: meterUsageStub() as never },
    async (gw) => gw,
  );
  const second = await withBilledModelGateway(
    {
      billing: createBilling(),
      context: { ...context, teamId: "team_2" },
      meterUsage: meterUsageStub() as never,
    },
    async (gw) => gw,
  );

  assert.notEqual(first, second);
});

// Admission gates spending. Covered work deducts nothing, so refusing it at
// zero credits would withhold work the team is not being charged for — e.g.
// ingestion vision extraction, which is paid for per page, not per token.
test("a covered scope is admitted even at zero credits", async () => {
  const gateway = fakeGateway();
  rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);

  const traces = await withBilledModelGateway(
    {
      billing: createBilling("enforced", 0),
      context: {
        ...context,
        feature: "source_ingestion",
        intent: { mode: "covered", coveredBy: "covered_by_ingestion_page" },
      },
      meterUsage: meterUsageStub() as never,
    },
    async (gw, scope) => {
      await gw.chat.complete({ model: "m", messages: [] } as never, chatOptions);
      return scope.meteredCalls();
    },
  );

  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.billingStatus, "covered");
  assert.equal(traces[0]?.consumedCredits, 0);
});

test("a billed scope is still refused at zero credits", async () => {
  const gateway = fakeGateway();
  rawMocks.getRawModelGatewayClient.mockResolvedValue(gateway);

  const error = await withBilledModelGateway(
    { billing: createBilling("enforced", 0), context },
    async (gw) => {
      await gw.chat.complete({ model: "m", messages: [] } as never, chatOptions);
    },
  )
    .then(() => null)
    .catch((thrown: unknown) => thrown);

  assert.equal((error as { code?: string }).code, "BILLING_ADMISSION_DENIED");
  assert.equal(gateway.chat.complete.mock.calls.length, 0);
});
