// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const audit = vi.hoisted(() => ({
  listSkillMarketAdminSkills: vi.fn(),
  listSkillMarketEvents: vi.fn(),
  reinferAllSkillCategories: vi.fn(),
}));
vi.mock("../../../../../lib/skill-market-audit", async (original) => ({
  ...(await original<typeof import("../../../../../lib/skill-market-audit")>()),
  ...audit,
}));

import { SkillAllAdmin, toSkillFilters } from "./skill-all-admin";

let root: Root;
let container: HTMLDivElement;

const skill = {
  id: "skill_1",
  slug: "gh-acme-skills-pdf",
  displayName: "PDF",
  repo: "acme/skills",
  visibility: "restricted" as const,
  listingHold: true,
  listingHoldBy: "admin" as const,
  featured: true,
  verified: false,
  claimed: true,
  flagCount: 2,
  openReportCount: 1,
  installCount: 7,
  ratingAvg: 4.5,
  ratingCount: 2,
  updatedAt: "2026-09-22T00:00:00.000Z",
};
const event = {
  id: "e1",
  skillId: "skill_1",
  skillSlug: "gh-acme-skills-pdf",
  skillDisplayName: "PDF",
  repo: null,
  actorKind: "admin" as const,
  actorUserId: "admin_1",
  actorName: "Ada",
  action: "listing.withdrawn",
  detail: { visibility: { from: "public", to: "restricted" } },
  createdAt: "2026-09-22T00:00:00.000Z",
};

beforeEach(async () => {
  audit.listSkillMarketAdminSkills.mockResolvedValue({
    items: [skill],
    nextCursor: "next",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SkillAllAdmin />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(label),
  );

async function choose(label: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`,
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

test("rows show standing and marks and link to the dashboard skill page", () => {
  expect(audit.listSkillMarketAdminSkills).toHaveBeenCalledWith(
    {},
    { cursor: null, limit: 50 },
  );
  const row = container.querySelector('[data-testid="admin-skill-row"]')!;
  expect(row.querySelector("a")?.getAttribute("href")).toBe(
    "/dashboard/skills/gh-acme-skills-pdf",
  );
  for (const text of [
    "Withdrawn",
    "Featured",
    "Claimed",
    "2 flags",
    "1 open report",
    "4.5 (2)",
    "acme/skills",
  ])
    expect(row.textContent).toContain(text);
  expect(row.textContent).not.toContain("Verified");
});

test("filters go to the API; load more appends the next page", async () => {
  await choose("Standing", "held");
  expect(audit.listSkillMarketAdminSkills).toHaveBeenLastCalledWith(
    { standing: "held" },
    { cursor: null, limit: 50 },
  );
  await choose("Has open reports", "yes");
  await choose("Verified", "no");
  expect(audit.listSkillMarketAdminSkills).toHaveBeenLastCalledWith(
    { standing: "held", reported: true, verified: false },
    { cursor: null, limit: 50 },
  );

  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search skills"]',
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, " pdf ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(audit.listSkillMarketAdminSkills).toHaveBeenLastCalledWith(
    { q: "pdf", standing: "held", reported: true, verified: false },
    { cursor: null, limit: 50 },
  );

  audit.listSkillMarketAdminSkills.mockResolvedValueOnce({
    items: [{ ...skill, id: "skill_2", slug: "gh-acme-skills-xlsx" }],
    nextCursor: null,
  });
  await act(async () => button("Load more")!.click());
  expect(audit.listSkillMarketAdminSkills).toHaveBeenLastCalledWith(
    { q: "pdf", standing: "held", reported: true, verified: false },
    { cursor: "next", limit: 50 },
  );
  expect(
    container.querySelectorAll('[data-testid="admin-skill-row"]'),
  ).toHaveLength(2);
  expect(button("Load more")).toBeUndefined();
});

test("toSkillFilters leaves out what is set to any", () => {
  expect(
    toSkillFilters({
      q: "  ",
      standing: "any",
      flags: {
        featured: "any",
        verified: "yes",
        claimed: "no",
        flagged: "any",
        reported: "any",
      },
    }),
  ).toEqual({ verified: true, claimed: false });
});

test("bulk re-inference asks first, then shows the counts", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
  await act(async () => button("Re-infer categories (auto only)")!.click());
  expect(audit.reinferAllSkillCategories).not.toHaveBeenCalled();

  confirm.mockReturnValueOnce(true);
  audit.reinferAllSkillCategories.mockResolvedValue({
    considered: 12,
    changed: 3,
  });
  await act(async () => button("Re-infer categories (auto only)")!.click());
  expect(audit.reinferAllSkillCategories).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Re-inferred 12 skills; 3 changed.");
});

test("the events feed loads when opened, labels actions and loads more", async () => {
  audit.listSkillMarketEvents.mockResolvedValueOnce({
    items: [event],
    nextCursor: "c2",
  });
  expect(audit.listSkillMarketEvents).not.toHaveBeenCalled();
  await act(async () => button("Recent market events")!.click());
  expect(audit.listSkillMarketEvents).toHaveBeenCalledWith({
    cursor: null,
    limit: 25,
  });
  const feed = container.querySelector('[data-testid="market-events"]')!;
  expect(feed.textContent).toContain("Withdrawn from the market");
  expect(feed.textContent).toContain("Ada (admin)");
  expect(feed.textContent).toContain("visibility: public → restricted");

  audit.listSkillMarketEvents.mockResolvedValueOnce({
    items: [
      {
        ...event,
        id: "e2",
        action: "listing.auto_listed",
        actorKind: "system",
        actorUserId: "system:auto-list",
        actorName: null,
        detail: {},
      },
    ],
    nextCursor: null,
  });
  const loadMore = [...container.querySelectorAll("button")].filter((node) =>
    node.textContent?.includes("Load more"),
  );
  await act(async () => loadMore.at(-1)!.click());
  expect(audit.listSkillMarketEvents).toHaveBeenLastCalledWith({
    cursor: "c2",
    limit: 25,
  });
  expect(feed.querySelectorAll("li")).toHaveLength(2);
  expect(feed.textContent).toContain("Listed automatically");
  expect(feed.textContent).toContain("SourceWeft");
});
