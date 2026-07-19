import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../content/billing-port";

const gatewayMocks = vi.hoisted(() => ({
  getRawModelGatewayClient: vi.fn(),
  createRawAgentChatModel: vi.fn(),
}));

vi.mock("../../../shared/model-gateway/internal/raw", () => gatewayMocks);

const modelBillingMocks = vi.hoisted(() => ({
  meterBillableModelUsage: vi.fn(),
}));

vi.mock("../../content/model-billing", () => modelBillingMocks);

const { generateThreadTitle } = await import("./title-generation");

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

const input = {
  teamId: "team_1",
  workspaceId: "ws_1",
  threadId: "thread_1",
  userId: "user_1",
  userMessageId: "msg_1",
  messageContent: "hello there",
  profileAlias: "default-chat",
  modelAlias: "gpt-4o-mini",
  gatewayConfigId: "gw_1",
};

beforeEach(() => {
  modelBillingMocks.meterBillableModelUsage.mockReset();
  modelBillingMocks.meterBillableModelUsage.mockResolvedValue({
    billing: {
      teamId: "team_1",
      consumedCredits: 1,
      availableCredits: 499,
      consumedThisCycle: 1,
      idempotencyReplayed: false,
    },
    cost: {
      providerCostUsd: 0.001,
      pricingSnapshot: null,
      costSource: "price_book",
      missingPriceComponents: [],
    },
    billedBy: "provider_cost",
    skipReason: null,
  });
  gatewayMocks.getRawModelGatewayClient.mockReset();
  gatewayMocks.getRawModelGatewayClient.mockResolvedValue({
    chat: {
      complete: vi.fn(async () => ({
        model: "gpt-4o-mini",
        usage: { inputTokens: 20, outputTokens: 5 },
        raw: { content: "A Friendly Greeting" },
      })),
      stream: vi.fn(),
    },
    embeddings: { embed: vi.fn(), embedBatch: vi.fn() },
    rerank: { rank: vi.fn() },
    asr: { transcribe: vi.fn() },
    tts: { speech: vi.fn() },
    images: { generate: vi.fn() },
  });
});

// Regression: title generation used to take an optional billing port, and the
// worker path never supplied one — so every background-generated title was free
// while the in-process path charged for the same operation.
test("generating a thread title bills the team", async () => {
  const billing = createBilling();

  await generateThreadTitle({ ...input, billing });

  assert.equal(modelBillingMocks.meterBillableModelUsage.mock.calls.length, 1);
  const metered = modelBillingMocks.meterBillableModelUsage.mock.calls[0]?.[0];
  assert.equal(metered.teamId, "team_1");
  assert.equal(metered.operation, "chat.title");
  assert.equal(metered.modelKind, "chat");
  assert.deepEqual(metered.usage, { inputTokens: 20, outputTokens: 5 });
});

// Changing this key on an already-metered reference would double-charge every
// title that had been billed under the old one.
test("the idempotency key is unchanged from before the migration", async () => {
  const billing = createBilling();

  await generateThreadTitle({ ...input, billing });

  const metered = modelBillingMocks.meterBillableModelUsage.mock.calls[0]?.[0];
  assert.equal(metered.idempotencyKey, "thread-title:msg_1");
  assert.equal(metered.referenceId, "thread:thread_1:title:msg_1");
});

test("a team with no credits is refused before any model call", async () => {
  const billing = createBilling("enforced", 0);

  const error = await generateThreadTitle({ ...input, billing })
    .then(() => null)
    .catch((thrown: unknown) => thrown);

  assert.ok(error instanceof Error);
  assert.equal((error as { code?: string }).code, "BILLING_ADMISSION_DENIED");
  assert.equal(modelBillingMocks.meterBillableModelUsage.mock.calls.length, 0);
});
