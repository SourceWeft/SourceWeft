import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createSourceweftAuth } from "./auth-config";

// Checkout, subscription management and provider webhooks go through the
// billing routes, which apply seat, per-member billing and idempotency policy.
// A payment-provider Auth plugin would add a second set of routes that bypass
// it, and its webhook route acknowledges processing failures.

// The oauth-provider plugin seeds its resources into PostgreSQL as a side
// effect of construction. Stub it so this stays a unit test.
vi.mock("@better-auth/oauth-provider", () => ({
  oauthProvider: () => ({ id: "oauth-provider" }),
}));

const paymentRoute =
  /checkout|subscription|billing|portal|webhook|creem|stripe|waffo/i;

test.each(["runtime", "migration"] as const)(
  "%s Auth exposes no payment-provider routes",
  (mode) => {
    const auth = createSourceweftAuth({ mode });
    const paths = Object.values(auth.api as Record<string, { path?: string }>)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === "string");

    assert.ok(paths.includes("/sign-in/email"));
    assert.deepEqual(
      paths.filter((path) => paymentRoute.test(path)),
      [],
    );
  },
);
