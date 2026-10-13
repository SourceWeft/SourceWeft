import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../logger", () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.info,
    warn: mocks.warn,
    error: vi.fn(),
  },
}));

import { metrics } from "../../metrics";
import type { ContentBillingPort } from "../../../modules/content/billing-port";
import { settleModelCall, type MeterUsageFn } from "./settle";

const TEAM_ID = "team_0199cd4f7b1e7c3a9f0e";

function billingPort(): ContentBillingPort {
  return {
    async getExecutionState() {
      return {
        kind: "metered",
        mode: "enforced",
        availableCredits: 10_000,
        consumedThisCycle: 0,
        ingestionPages: { enforced: true, remaining: null },
      };
    },
  } as unknown as ContentBillingPort;
}

function meterUsage(consumedCredits: number): MeterUsageFn {
  return (async () => ({
    billedBy: "provider_cost" as const,
    skipReason: null,
    cost: {
      providerCostUsd: 0.001,
      pricingSnapshot: null,
      costSource: "provider_actual" as const,
      missingPriceComponents: [],
    },
    billing: {
      teamId: TEAM_ID,
      consumedCredits,
      availableCredits: 10_000 - consumedCredits,
      consumedThisCycle: consumedCredits,
      idempotencyReplayed: false,
    },
  })) as unknown as MeterUsageFn;
}

function settle(input: { consumedCredits: number; modelAlias: string }) {
  return settleModelCall({
    context: {
      teamId: TEAM_ID,
      actorUserId: "user_1",
      feature: "chat",
      intent: { mode: "billed" },
      scopeKind: "thread-turn",
      scopeId: "trace_1",
    },
    billing: billingPort(),
    options: {
      operation: "chat",
      modelKind: "chat",
      profileAlias: "chat-default",
      modelAlias: input.modelAlias,
      gatewayConfigId: "gateway_1",
    },
    usage: { inputTokens: 100, outputTokens: 50 },
    idempotencyKey: "key_1",
    referenceId: "ref_1",
    meterUsage: meterUsage(input.consumedCredits),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("a settled model call is counted per model instead of logged per call", async () => {
  const before = metrics.snapshot();
  const counterKey = "billing.settled{billedBy=provider_cost,model=settle-test-model}";
  const creditsKey = "billing.settled_credits{model=settle-test-model}";
  const countBefore = before.counters[counterKey] ?? 0;
  const creditsBefore = before.observations[creditsKey]?.sum ?? 0;

  const first = await settle({ consumedCredits: 7, modelAlias: "settle-test-model" });
  const second = await settle({ consumedCredits: 5, modelAlias: "settle-test-model" });

  assert.equal(first?.billingStatus, "metered");
  assert.equal(second?.consumedCredits, 5);
  const after = metrics.snapshot();
  assert.equal(after.counters[counterKey], countBefore + 2);
  assert.equal(after.observations[creditsKey]?.sum, creditsBefore + 12);
  assert.equal(after.observations[creditsKey]?.max, Math.max(7, 5));

  // No per-call line: the success path is silent and the keys hold no ids.
  assert.equal(mocks.info.mock.calls.length, 0);
  assert.equal(mocks.warn.mock.calls.length, 0);
  for (const key of [...Object.keys(after.counters), ...Object.keys(after.observations)]) {
    assert.ok(!key.includes(TEAM_ID), `team id leaked into metric key ${key}`);
  }
});
