import { describe, it, expect, vi } from "vitest";
import { BillingError } from "./errors";
import type { BillingRuntimeConfig } from "./types";

const mockCreemInstance = { __brand: "CreemBillingProvider" } as const;
const mockNoopInstance = { __brand: "NoopBillingProvider" } as const;

vi.mock("./providers/creem-provider", () => {
  class MockCreemBillingProvider {
    constructor(_config: unknown) {
      return mockCreemInstance;
    }
  }
  return { CreemBillingProvider: MockCreemBillingProvider };
});

vi.mock("./providers/noop-provider", () => {
  class MockNoopBillingProvider {
    constructor() {
      return mockNoopInstance;
    }
  }
  return { NoopBillingProvider: MockNoopBillingProvider };
});

import { createBillingProvider } from "./provider";

function makeConfig(provider: BillingRuntimeConfig["provider"]) {
  return {
    saasEnabled: false,
    // These tests only exercise provider dispatch; mode is inert filler.
    mode: "disabled" as const,
    scope: "team_enabled" as const,
    provider,
    creditsEnabled: false,
    pagesEnabled: false,
    enforceLimits: false,
    teamBillingEnabled: false,
    creditUnitUsd: 0,
    defaultMarkupRate: 0,
    defaultPlanFamily: "individual_pro" as const,
    defaultMonthlyPages: 0,
    defaultMonthlyCredits: 0,
    reconcileEnabled: false,
    creem: {
      apiKey: "",
      webhookSecret: "",
      testMode: true,
      individualProMonthlyProductId: "",
      individualProYearlyProductId: "",
      teamStandardMonthlyProductId: "",
      teamStandardYearlyProductId: "",
      creditTopupProductId: "",
      pageTopupProductId: "",
    },
    catalog: {
      individualProMonthlyAmountCents: 0,
      individualProYearlyAmountCents: 0,
      teamStandardMonthlyAmountCents: 0,
      teamStandardYearlyAmountCents: 0,
      creditTopupUnitAmount: 0,
      creditTopupAmountCents: 0,
      pageTopupUnitAmount: 0,
      pageTopupAmountCents: 0,
    },
    defaultSuccessUrl: "",
  };
}

describe("createBillingProvider", () => {
  it('returns CreemBillingProvider for "creem"', () => {
    const provider = createBillingProvider(makeConfig("creem"));
    expect(provider).toBe(mockCreemInstance);
  });

  it('returns NoopBillingProvider for "none"', () => {
    const provider = createBillingProvider(makeConfig("none"));
    expect(provider).toBe(mockNoopInstance);
  });

  it('returns NoopBillingProvider for "manual"', () => {
    const provider = createBillingProvider(makeConfig("manual"));
    expect(provider).toBe(mockNoopInstance);
  });

  it('throws BillingError with BILLING_PROVIDER_UNSUPPORTED for unknown provider', () => {
    try {
      createBillingProvider(makeConfig("stripe" as never));
      expect.unreachable("Expected BillingError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BillingError);
      if (error instanceof BillingError) {
        expect(error.code).toBe("BILLING_PROVIDER_UNSUPPORTED");
        expect(error.statusCode).toBe(400);
        expect(error.message).toContain("stripe");
      }
    }
  });
});
