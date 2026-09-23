// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { PricingToggle } from "../src/ui/pricing-toggle";
import { BillingUiProvider, type BillingUiHost } from "../src/ui/context";
import { getPricingConfig } from "../src/catalog/pricing";
import { getBillingMessages } from "../src/messages";
vi.mock("../src/ui/team-checkout-dialog", () => ({
  TeamCheckoutDialog: () => null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
test.each(["en", "zh-CN", "zh-TW", "unknown"])(
  "pricing controls and CTAs use %s with English default",
  async (locale) => {
    const copy = getBillingMessages(locale);
    const plans = getPricingConfig({}).map((plan) => ({
      ...plan,
      ...copy.plans[plan.id],
    }));
    const host = document.createElement("div");
    const root = createRoot(host);
    const billingHost = {
      locale,
      authClient: {},
      billingClient: {},
    } as BillingUiHost;
    try {
      await act(async () =>
        root.render(
          <BillingUiProvider value={billingHost}>
            <PricingToggle
              authState={{ isPending: false, isSignedIn: false, user: null }}
              plans={plans}
            />
          </BillingUiProvider>,
        ),
      );
      expect(host.textContent).toContain(copy.plans.pro.cta);
      expect(host.textContent).toContain(copy.plans.team.cta);
      const yearly = host.querySelector(
        `button[aria-label="${copy.controls.yearly}"]`,
      ) as HTMLButtonElement;
      expect(yearly).not.toBeNull();
      await act(async () => yearly.click());
      expect(yearly.getAttribute("aria-pressed")).toBe("true");
      expect(host.textContent).toContain(copy.controls.yearlySavings);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
