// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { AdminOverview } from "./admin-overview";
import {
  AdminOverviewProvider,
  type AdminOverviewState,
} from "./admin-overview-context";
import { button, mountWithIntl, unmountAll } from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
});

async function render(state: Partial<AdminOverviewState>) {
  const value: AdminOverviewState = {
    overview: null,
    failed: false,
    refresh: () => {},
    ...state,
  };
  ({ container } = await mountWithIntl(
    <AdminOverviewProvider value={value}>
      <AdminOverview />
    </AdminOverviewProvider>,
  ));
}

const card = (key: string) =>
  container.querySelector(`[data-testid="admin-overview-${key}"]`);

test("each work queue shows how much is waiting and leads to its section", async () => {
  await render({
    overview: {
      pending: { mcpReview: 1, skillReview: 2, skillListing: 3, reports: 0 },
      blog: { drafts: 24, published: 1 },
    },
  });
  expect(container.textContent).toContain("6 items are waiting for a decision.");
  expect(card("mcpReview")?.getAttribute("href")).toBe("/dashboard/admin/market/mcp-review");
  expect(card("mcpReview")?.textContent).toContain("1");
  expect(card("skillReview")?.textContent).toContain("5");
  expect(card("skillReview")?.textContent).toContain("2 new submissions · 3 listing decisions");
  expect(card("reports")?.textContent).toContain("0");
  expect(card("blog")?.getAttribute("href")).toBe("/dashboard/admin/blog");
  expect(card("blog")?.textContent).toContain("24 draft versions");
  expect(card("blog")?.textContent).toContain("1 published version");
});

test("nothing waiting says so", async () => {
  await render({
    overview: {
      pending: { mcpReview: 0, skillReview: 0, skillListing: 0, reports: 0 },
      blog: { drafts: 0, published: 0 },
    },
  });
  expect(container.textContent).toContain("Nothing is waiting for you.");
});

test("while the numbers load it says so; a failure offers another try", async () => {
  await render({});
  expect(container.textContent).toContain("Loading the numbers");

  await unmountAll();
  const refresh = vi.fn();
  await render({ failed: true, refresh });
  expect(container.textContent).toContain("Could not load the numbers");
  await act(async () => button("Try again")!.click());
  expect(refresh).toHaveBeenCalledTimes(1);
});
