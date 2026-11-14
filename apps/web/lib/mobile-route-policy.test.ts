import { describe, expect, it } from "vitest";

import {
  isPurchaseRoute,
  resolveMobileRouteAction,
} from "./mobile-route-policy";

const currentUrl = "https://sourceweft.com/dashboard/chat";
const click = (href: string) => ({ href, currentUrl });

describe("isPurchaseRoute", () => {
  it("names the pricing pages in every language", () => {
    for (const path of [
      "/pricing",
      "/pricing/teams",
      "/zh-CN/pricing",
      "/zh-TW/pricing",
      "/en/pricing",
    ]) {
      expect(isPurchaseRoute(path), path).toBe(true);
    }
  });

  it("names nothing else", () => {
    for (const path of [
      "/",
      "/privacy",
      "/pricingx",
      "/blog/pricing",
      "/dashboard/billing",
      "/zh-CN/mcp",
    ]) {
      expect(isPurchaseRoute(path), path).toBe(false);
    }
  });
});

describe("resolveMobileRouteAction", () => {
  it("does not follow a pricing link where nothing may be sold", () => {
    for (const href of [
      "/pricing",
      "/zh-CN/pricing",
      `${currentUrl}/../../pricing`,
    ]) {
      expect(
        resolveMobileRouteAction(click(href), { purchasesAllowed: false }),
        href,
      ).toEqual({ type: "blocked" });
    }
  });

  it("opens the pricing page in a sheet where purchases are allowed, as before", () => {
    for (const options of [undefined, {}, { purchasesAllowed: true }]) {
      expect(resolveMobileRouteAction(click("/pricing"), options).type).toBe(
        "sheet",
      );
    }
  });

  it("leaves every other decision alone where nothing may be sold", () => {
    const options = { purchasesAllowed: false };
    expect(
      resolveMobileRouteAction(click("/dashboard/chat/abc"), options),
    ).toEqual({ type: "allow" });
    expect(resolveMobileRouteAction(click("/privacy"), options).type).toBe(
      "sheet",
    );
    expect(
      resolveMobileRouteAction(click("https://example.com/pricing"), options)
        .type,
    ).toBe("external");
    expect(resolveMobileRouteAction(click("#pricing"), options)).toEqual({
      type: "ignore",
    });
  });
});
