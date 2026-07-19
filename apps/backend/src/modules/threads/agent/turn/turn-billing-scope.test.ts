import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { BillingSummaryResponse } from "@sourceweft/contracts";
import type { ContentBillingPort } from "../../../content/billing-port";
import type { PreparedThreadTurn } from "../..";
import { createTurnRuntime } from "./turn-runtime";

const gatewayMocks = vi.hoisted(() => ({
  openBilledModelGateway: vi.fn(),
}));

vi.mock("../../../../shared/model-gateway/index", () => gatewayMocks);

const { openTurnBillingScope } = await import("./turn-billing-scope");

function createBilling(): ContentBillingPort {
  return {
    getSummary: vi.fn(
      async (teamId: string) =>
        ({
          teamId,
          billingMode: "enforced",
          credits: { available: 500, consumedThisCycle: 0 },
        }) as unknown as BillingSummaryResponse,
    ),
    meterConsume: vi.fn(),
    meterIngestion: vi.fn(),
  } as unknown as ContentBillingPort;
}

function createPrepared(): PreparedThreadTurn {
  return {
    workspace: { id: "ws_1", organizationId: "team_1" },
    userId: "user_1",
    thread: { id: "thread_1" },
    userMessage: { id: "msg_1" },
    runTraceId: "run_1",
    profileAlias: "default-chat",
    modelAlias: "gpt-4o",
    providerModel: "gpt-4o",
    chatProfile: { gatewayConfigId: "gw_1" },
    llmIdempotencyKey: "base_key",
  } as unknown as PreparedThreadTurn;
}

function stubGateway() {
  const scope = {
    billingMode: "enforced",
    meteredCalls: () => [],
    remainingCredits: () => 500,
    settle: vi.fn(),
    context: {},
  };
  gatewayMocks.openBilledModelGateway.mockResolvedValue({
    scope,
    gateway: { agentChatModel: vi.fn(async () => ({ fake: "model" })) },
  });
  return scope;
}

beforeEach(() => {
  gatewayMocks.openBilledModelGateway.mockReset();
});

test("opening a turn scope yields a model bound to it", async () => {
  stubGateway();
  const runtime = createTurnRuntime({ prepared: createPrepared() });

  const model = await openTurnBillingScope({
    prepared: createPrepared(),
    billing: createBilling(),
    runtime,
  });

  assert.ok(model);
  assert.ok(runtime.billingScope);
  const context = gatewayMocks.openBilledModelGateway.mock.calls[0]?.[0]
    ?.context as Record<string, unknown>;
  assert.equal(context.teamId, "team_1");
  assert.equal(context.scopeKind, "thread-turn");
  assert.deepEqual(context.intent, { mode: "billed" });
});

// A customer-supplied key means no provider cost to pass on, but the call is
// still traced.
test("a BYOK turn opens a covered scope rather than a billed one", async () => {
  stubGateway();
  const runtime = createTurnRuntime({ prepared: createPrepared() });

  await openTurnBillingScope({
    prepared: createPrepared(),
    billing: createBilling(),
    llm: { executionMode: "BYOK" },
    runtime,
  });

  const context = gatewayMocks.openBilledModelGateway.mock.calls[0]?.[0]
    ?.context as Record<string, unknown>;
  assert.deepEqual(context.intent, { mode: "covered", coveredBy: "byok" });
});
