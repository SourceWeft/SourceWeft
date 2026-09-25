// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const audit = vi.hoisted(() => ({ getSkillMarketAdminMe: vi.fn() }));
const nav = vi.hoisted(() => ({ pathname: "/dashboard" }));
vi.mock("../../../lib/skill-market-audit", () => audit);
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import {
  MarketAdminNavLink,
  resetMarketAdminCheck,
} from "./market-admin-nav-link";
import { mountWithIntl, unmountAll } from "@/test/react";

let container: HTMLDivElement;
beforeEach(() => {
  resetMarketAdminCheck();
  nav.pathname = "/dashboard";
});
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

async function render() {
  ({ container } = await mountWithIntl(<MarketAdminNavLink />));
}

test("a market admin gets the link, marked current on the admin page", async () => {
  audit.getSkillMarketAdminMe.mockResolvedValue({ isMarketAdmin: true });
  nav.pathname = "/dashboard/admin/market";
  await render();
  const link = container.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("/dashboard/admin/market");
  expect(link.textContent).toBe("Market admin");
  expect(link.getAttribute("aria-current")).toBe("page");
});

test("everyone else, or a failed check, gets nothing", async () => {
  audit.getSkillMarketAdminMe.mockResolvedValue({ isMarketAdmin: false });
  await render();
  expect(container.innerHTML).toBe("");
  await unmountAll();

  resetMarketAdminCheck();
  audit.getSkillMarketAdminMe.mockRejectedValue(new Error("offline"));
  await render();
  expect(container.innerHTML).toBe("");
});

test("the question is asked once however many links render", async () => {
  audit.getSkillMarketAdminMe.mockResolvedValue({ isMarketAdmin: true });
  await render();
  await unmountAll();
  await render();
  expect(audit.getSkillMarketAdminMe).toHaveBeenCalledTimes(1);
  expect(container.querySelector("a")).not.toBeNull();
});
