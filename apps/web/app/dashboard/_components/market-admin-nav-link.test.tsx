// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const audit = vi.hoisted(() => ({ getSkillMarketAdminMe: vi.fn() }));
const nav = vi.hoisted(() => ({ pathname: "/dashboard" }));
vi.mock("../../../lib/skill-market-audit", () => audit);
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import {
  MarketAdminNavLink,
  resetMarketAdminCheck,
} from "./market-admin-nav-link";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  resetMarketAdminCheck();
  nav.pathname = "/dashboard";
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MarketAdminNavLink />));
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
  act(() => root.unmount());
  container.remove();

  resetMarketAdminCheck();
  audit.getSkillMarketAdminMe.mockRejectedValue(new Error("offline"));
  await render();
  expect(container.innerHTML).toBe("");
});

test("the question is asked once however many links render", async () => {
  audit.getSkillMarketAdminMe.mockResolvedValue({ isMarketAdmin: true });
  await render();
  act(() => root.unmount());
  container.remove();
  await render();
  expect(audit.getSkillMarketAdminMe).toHaveBeenCalledTimes(1);
  expect(container.querySelector("a")).not.toBeNull();
});
