import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  teamCreationAvailable: true,
}));
vi.mock("./capabilities", () => ({
  useDeploymentCapabilities: () => state.value,
  useTeamCreationAvailable: () => state.teamCreationAvailable,
}));
vi.mock("./commercial-client", () => {
  throw new Error("Disabled/error UI must not load commercial components");
});
import {
  BillingCheckoutClient,
  BillingPanel,
  TeamCheckoutDialog,
  SidebarUsageSummary,
} from "./client";
import { withIntl } from "@/test/react";
const props = {
  open: true,
  onOpenChange() {},
  billingInterval: "monthly" as const,
  perSeatPrice: 5,
  source: "dashboard" as const,
};
beforeEach(() => {
  state.teamCreationAvailable = true;
  state.value = {
    status: "ready",
    capabilities: { billing: { available: false, teamSubscriptions: false } },
  };
});
test("direct billing view is gated while module is off", () => {
  expect(renderToStaticMarkup(withIntl(createElement(BillingPanel)))).toContain(
    "Commercial features are disabled",
  );
  expect(
    renderToStaticMarkup(withIntl(createElement(SidebarUsageSummary, {}))),
  ).toBe("");
});
test("failed capability loading cannot offer a free team creation path", () => {
  state.value = {
    status: "error",
    capabilities: null,
    error: "Deployment capabilities unavailable",
  };
  const html = renderToStaticMarkup(
    withIntl(createElement(TeamCheckoutDialog, props)),
  );
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("Create team");
});
test("pending capabilities do not offer team creation or load commercial UI", () => {
  state.value = { status: "loading", capabilities: null, error: null };
  const html = renderToStaticMarkup(
    withIntl(createElement(TeamCheckoutDialog, props)),
  );
  expect(html).toContain("Loading available features");
  expect(html).not.toContain("Create team");
});
test("the checkout page does not mount where checkout is unavailable", () => {
  state.value = {
    status: "ready",
    capabilities: {
      billing: { available: true, checkout: false, teamSubscriptions: true },
    },
  };
  // Mounting it would load the commercial client, which the mock above forbids.
  expect(
    renderToStaticMarkup(
      withIntl(createElement(BillingCheckoutClient, {} as never)),
    ),
  ).toContain("Commercial features are disabled");
});
test("a paid team cannot be started, nor replaced by the free dialog, where teams cannot be created", () => {
  state.teamCreationAvailable = false;
  state.value = {
    status: "ready",
    capabilities: { billing: { available: true, teamSubscriptions: true } },
  };
  expect(
    renderToStaticMarkup(withIntl(createElement(TeamCheckoutDialog, props))),
  ).toBe("");
});
