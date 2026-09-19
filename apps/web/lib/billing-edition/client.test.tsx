import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./capabilities", () => ({
  useDeploymentCapabilities: () => state.value,
}));
vi.mock("./commercial-client", () => {
  throw new Error("Disabled/error UI must not load commercial components");
});
import {
  BillingPanel,
  TeamCheckoutDialog,
  SidebarUsageSummary,
} from "./client";
const props = {
  open: true,
  onOpenChange() {},
  billingInterval: "monthly" as const,
  perSeatPrice: 5,
  source: "dashboard" as const,
};
beforeEach(() => {
  state.value = {
    status: "ready",
    capabilities: { billing: { available: false, teamSubscriptions: false } },
  };
});
test("direct billing view is gated while module is off", () => {
  expect(renderToStaticMarkup(createElement(BillingPanel))).toContain(
    "Commercial features are disabled",
  );
  expect(renderToStaticMarkup(createElement(SidebarUsageSummary, {}))).toBe("");
});
test("failed capability loading cannot offer a free team creation path", () => {
  state.value = {
    status: "error",
    capabilities: null,
    error: "Deployment capabilities unavailable",
  };
  const html = renderToStaticMarkup(createElement(TeamCheckoutDialog, props));
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("Create team");
});
test("pending capabilities do not offer team creation or load commercial UI", () => {
  state.value = { status: "loading", capabilities: null, error: null };
  const html = renderToStaticMarkup(createElement(TeamCheckoutDialog, props));
  expect(html).toContain("Loading available features");
  expect(html).not.toContain("Create team");
});
