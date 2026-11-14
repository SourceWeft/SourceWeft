import { expect, test } from "vitest";
import type { DeploymentCapabilities } from "@sourceweft/contracts/deployment-capabilities";

import { withoutPurchases } from "./purchase-policy";

const commercial = {
  edition: "commercial",
  billingRuntimeApiVersion: 1,
  billing: {
    available: true,
    mode: "subscription",
    checkout: true,
    teamSubscriptions: true,
    topup: true,
    catalog: {},
  },
} as unknown as DeploymentCapabilities;

const core = {
  edition: "core",
  billingRuntimeApiVersion: 1,
  billing: {
    available: false,
    mode: null,
    checkout: false,
    teamSubscriptions: false,
    topup: false,
  },
} as DeploymentCapabilities;

test("checkout and top-ups are turned off, and nothing else", () => {
  const state = {
    status: "ready" as const,
    capabilities: commercial,
    error: null,
  };
  const restricted = withoutPurchases(state);
  expect(restricted.capabilities.billing).toEqual({
    ...commercial.billing,
    checkout: false,
    topup: false,
  });
  // Usage and the current plan stay visible; paid teams stay paid, so team
  // creation never falls through to the free flow.
  expect(restricted.capabilities.billing.available).toBe(true);
  expect(restricted.capabilities.billing.teamSubscriptions).toBe(true);
  // The API's answer itself is not modified.
  expect(commercial.billing.checkout).toBe(true);
});

test("states with nothing for sale are returned as they are", () => {
  const coreState = {
    status: "ready" as const,
    capabilities: core,
    error: null,
  };
  expect(withoutPurchases(coreState)).toBe(coreState);

  const loading = {
    status: "loading" as const,
    capabilities: null,
    error: null,
  };
  expect(withoutPurchases(loading)).toBe(loading);

  const failed = {
    status: "error" as const,
    capabilities: null,
    error: "down",
  };
  expect(withoutPurchases(failed)).toBe(failed);

  const alreadyOff = {
    status: "ready" as const,
    capabilities: {
      ...commercial,
      billing: { ...commercial.billing, checkout: false, topup: false },
    } as DeploymentCapabilities,
    error: null,
  };
  expect(withoutPurchases(alreadyOff)).toBe(alreadyOff);
});
