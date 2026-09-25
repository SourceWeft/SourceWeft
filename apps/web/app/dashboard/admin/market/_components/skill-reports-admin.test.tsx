// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  listSkillReports: vi.fn(),
  resolveSkillReport: vi.fn(),
}));
vi.mock("../../../../../lib/skill-reports", () => api);

import { reportActions, SkillReportsAdmin } from "./skill-reports-admin";
import { button, mountWithIntl, typeInto, unmountAll } from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

const report = (overrides: Record<string, unknown> = {}) => ({
  id: "rep_1",
  reason: "copyright",
  details: "Copied from acme/pdf",
  status: "open",
  createdAt: "2026-09-22T00:00:00.000Z",
  resolution: null,
  resolvedBy: null,
  resolvedAt: null,
  skill: {
    id: "skill_1",
    slug: "gh-acme-skills-pdf",
    displayName: "PDF tools",
    visibility: "public",
    listingHold: false,
  },
  review: null,
  reporter: {
    userId: null,
    displayName: "anonymous",
    contactEmail: "owner@example.com",
    accountEmail: null,
  },
  otherOpenReports: 2,
  ...overrides,
});

async function render() {
  ({ container } = await mountWithIntl(<SkillReportsAdmin />));
}

async function click(label: string) {
  await act(async () => {
    button(label)!.click();
  });
}

test("an open report shows the skill, reason, details, reporter and other open reports", async () => {
  api.listSkillReports.mockResolvedValue({
    items: [report()],
    nextCursor: null,
  });
  await render();
  expect(api.listSkillReports).toHaveBeenCalledWith({
    status: "open",
    limit: 25,
  });
  const item = container.querySelector('[data-testid="skill-report-item"]')!;
  expect(item.querySelector("a")?.getAttribute("href")).toBe(
    "/dashboard/skills/gh-acme-skills-pdf",
  );
  expect(item.textContent).toContain("PDF tools");
  expect(item.textContent).toContain("Copyright or license violation");
  expect(item.textContent).toContain("Copied from acme/pdf");
  expect(item.textContent).toContain("anonymous");
  expect(item.textContent).toContain("owner@example.com");
  expect(item.textContent).toContain("2 other open reports on this skill");
  // A report about the skill cannot hide a review.
  expect(button("Hide review")).toBeUndefined();
  expect(button("Dismiss")).toBeDefined();
});

test("a review report shows the excerpt and offers hiding it", async () => {
  api.listSkillReports.mockResolvedValue({
    items: [
      report({
        review: {
          id: "rev_1",
          rating: 1,
          excerpt: "Scam, do not use",
          status: "visible",
        },
        reporter: {
          userId: "user_1",
          displayName: "Ada",
          contactEmail: null,
          accountEmail: "ada@example.com",
        },
      }),
    ],
    nextCursor: null,
  });
  await render();
  expect(
    container.querySelector('[data-testid="skill-report-review"]')?.textContent,
  ).toContain("Scam, do not use");
  expect(container.textContent).toContain("Ada");
  expect(container.textContent).toContain("ada@example.com");
  expect(button("Hide review")).toBeDefined();
});

test("dismiss resolves at once with the note and same-target option, then reloads", async () => {
  api.listSkillReports
    .mockResolvedValueOnce({ items: [report()], nextCursor: null })
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  api.resolveSkillReport.mockResolvedValue({
    reportId: "rep_1",
    status: "dismissed",
    action: "dismiss",
    resolvedReportIds: ["rep_1", "rep_2"],
  });
  await render();
  const note = container.querySelector("textarea")!;
  const checkbox = container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  await act(async () => {
    typeInto(note, "Not a copy");
    checkbox.click();
  });
  await click("Dismiss");
  expect(api.resolveSkillReport).toHaveBeenCalledWith("rep_1", {
    action: "dismiss",
    resolution: "Not a copy",
    alsoResolveSameTarget: true,
  });
  expect(api.listSkillReports).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Resolved 2 reports.");
  expect(container.textContent).toContain("No open reports.");
});

test("a destructive action asks first, and can be cancelled", async () => {
  api.listSkillReports.mockResolvedValue({
    items: [report()],
    nextCursor: null,
  });
  api.resolveSkillReport.mockResolvedValue({
    reportId: "rep_1",
    status: "actioned",
    action: "withdraw_skill",
    resolvedReportIds: ["rep_1"],
  });
  await render();
  await click("Withdraw skill");
  expect(api.resolveSkillReport).not.toHaveBeenCalled();
  expect(
    container.querySelector('[role="alertdialog"]')?.textContent,
  ).toContain("Withdraw this skill from the public market?");
  await click("Cancel");
  expect(container.querySelector('[role="alertdialog"]')).toBeNull();

  await click("Revoke current version");
  await click("Confirm");
  expect(api.resolveSkillReport).toHaveBeenCalledWith("rep_1", {
    action: "revoke_version",
    resolution: "",
    alsoResolveSameTarget: false,
  });
});

test("a failed resolution stays on the report with the error", async () => {
  api.listSkillReports.mockResolvedValue({
    items: [report()],
    nextCursor: null,
  });
  api.resolveSkillReport.mockRejectedValue(new Error("Skill is gone"));
  await render();
  await click("Mark handled");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Skill is gone",
  );
  expect(api.listSkillReports).toHaveBeenCalledTimes(1);
});

test("the status filter reloads, and load more appends the next page", async () => {
  api.listSkillReports
    .mockResolvedValueOnce({ items: [report()], nextCursor: "c1" })
    .mockResolvedValueOnce({
      items: [report({ id: "rep_2", details: "Second page" })],
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      items: [
        report({
          id: "rep_3",
          status: "dismissed",
          resolution: "Fine",
          resolvedBy: "admin_1",
        }),
      ],
      nextCursor: null,
    });
  await render();
  await click("Load more");
  expect(api.listSkillReports).toHaveBeenLastCalledWith({
    status: "open",
    cursor: "c1",
    limit: 25,
  });
  expect(
    container.querySelectorAll('[data-testid="skill-report-item"]'),
  ).toHaveLength(2);
  expect(button("Load more")).toBeUndefined();

  await click("Dismissed");
  expect(api.listSkillReports).toHaveBeenLastCalledWith({
    status: "dismissed",
    limit: 25,
  });
  expect(container.textContent).toContain("Fine");
  // A closed report offers no actions.
  expect(button("Dismiss")).toBeUndefined();
});

test("a load failure offers a retry", async () => {
  api.listSkillReports
    .mockRejectedValueOnce(new Error("down"))
    .mockResolvedValueOnce({ items: [], nextCursor: null });
  await render();
  expect(container.textContent).toContain("Reports could not be loaded.");
  await click("Retry");
  expect(container.textContent).toContain("No open reports.");
});

test("hiding a review is offered only for a review report", () => {
  expect(reportActions(report() as never)).not.toContain("hide_review");
  expect(
    reportActions(
      report({
        review: { id: "r", rating: 1, excerpt: "", status: "visible" },
      }) as never,
    ),
  ).toContain("hide_review");
});
