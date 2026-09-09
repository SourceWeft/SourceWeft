import { vi } from "vitest";
import type { BillingRuntime } from "@sourceweft/contracts/billing-runtime";
import type {
  BillingSummaryResponse,
  MeterConsumeRequest,
  MeterConsumeResponse,
  MeterIngestionRequest,
  MeterIngestionResponse,
} from "@sourceweft/contracts";
type Legacy = {
  getSummary(teamId: string, userId: string): Promise<BillingSummaryResponse>;
  meterConsume(
    teamId: string,
    input: MeterConsumeRequest,
    actorUserId: string,
  ): Promise<MeterConsumeResponse>;
  meterIngestion(
    teamId: string,
    input: MeterIngestionRequest,
    actorUserId: string,
  ): Promise<MeterIngestionResponse>;
};
export type LegacyBillingTestPort = BillingRuntime &
  Pick<Legacy, "getSummary" | "meterConsume">;
/** Keeps the existing recording mocks while testing the host's new port. No production fallback. */
export function adaptBillingTestPort<T extends object>(
  fixture: T,
): T & LegacyBillingTestPort {
  const legacy = fixture as unknown as Legacy;
  const ingestion = legacy.meterIngestion;
  const runtime: BillingRuntime = {
    async getExecutionState(teamId, userId) {
      const summary = await legacy.getSummary(teamId, userId);
      return {
        kind: "metered",
        mode: summary.billingMode ?? "enforced",
        availableCredits: summary.credits.available,
        consumedThisCycle: summary.credits.consumedThisCycle,
      };
    },
    async settleModelUsage(input) {
      const cost =
        typeof input.cost === "function" ? await input.cost() : input.cost;
      return {
        status: "settled",
        billedBy: "provider_cost",
        billing: await legacy.meterConsume(
          input.teamId,
          {
            feature: input.feature,
            idempotencyKey: input.idempotencyKey,
            providerCostUsd: cost.providerCostUsd ?? undefined,
            metadata: input.metadata,
          },
          input.actorUserId,
        ),
      };
    },
    meterIngestion: vi.fn(
      async (...args: Parameters<BillingRuntime["meterIngestion"]>) => ({
        status: "settled" as const,
        billing: await ingestion(...args),
      }),
    ),
    async reconcileProviderCost() {
      throw new Error("Cost reconciliation was not configured for this test");
    },
  };
  return Object.assign(fixture, runtime) as T & LegacyBillingTestPort;
}
