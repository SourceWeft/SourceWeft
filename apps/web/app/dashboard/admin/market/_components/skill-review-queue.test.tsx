// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

const admin = vi.hoisted(() => ({
  listSkillListingQueue: vi.fn(),
  listSkillReviewQueue: vi.fn(),
  listSkillPublicly: vi.fn(),
  delistSkill: vi.fn(),
  acknowledgeSkillVersion: vi.fn(),
  publishSkillSubmission: vi.fn(),
  rejectSkillSubmission: vi.fn(),
  getSkillReviewVersion: vi.fn(),
}));
vi.mock("../../../../../lib/skill-market-admin", () => admin);

import { SkillReviewQueue } from "./skill-review-queue";
import { parseCollectionSlugs } from "./skill-collections-admin";
import { button, flush, mountWithIntl, unmountAll } from "@/test/react";

let container: HTMLDivElement;
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
});

const entry = {
  skillId: "skill_1",
  skillVersionId: "ver_1",
  slug: "gh-acme-skills-pdf",
  displayName: "PDF",
  description: "PDFs",
  submittedBy: "user_1",
  capability: "executable" as const,
  license: "MIT",
  sourceUrl: null,
  flags: ["egress:fetch"],
  createdAt: "2026-09-21T00:00:00.000Z",
};

async function renderListing(items: unknown[]) {
  admin.listSkillListingQueue.mockResolvedValue({ items });
  admin.getSkillReviewVersion.mockResolvedValue({ skillContent: "# PDF" });
  ({ container } = await mountWithIntl(<SkillReviewQueue queue="listing" />));
  await flush(2);
}

async function renderReview(items: unknown[]) {
  admin.listSkillReviewQueue.mockResolvedValue({ items });
  ({ container } = await mountWithIntl(<SkillReviewQueue />));
  await flush(2);
}

const rows = () => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-testid="review-row"]'),
];
const detail = () => container.querySelector('[data-testid="review-detail"]');

test("the first skill in the queue is open with its SKILL.md; choosing another opens that one", async () => {
  admin.getSkillReviewVersion.mockImplementation(async (_skillId: string, versionId: string) => ({
    skillContent: `# source of ${versionId}`,
  }));
  await renderReview([
    entry,
    {
      ...entry,
      skillId: "skill_2",
      skillVersionId: "ver_2",
      slug: "gh-acme-skills-xlsx",
      displayName: "XLSX",
      flags: ["egress:fetch", "scripts:shell"],
    },
  ]);

  expect(rows().map((row) => row.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  expect(rows()[1]?.textContent).toContain("2 flags");
  expect(detail()?.textContent).toContain("gh-acme-skills-pdf");
  expect(detail()?.textContent).toContain("# source of ver_1");
  expect(admin.getSkillReviewVersion).toHaveBeenCalledWith("skill_1", "ver_1");

  await act(async () => rows()[1]!.click());
  await flush(2);
  expect(detail()?.textContent).toContain("gh-acme-skills-xlsx");
  expect(detail()?.textContent).toContain("# source of ver_2");
  expect(detail()?.textContent).not.toContain("gh-acme-skills-pdf");
});

test("deciding the open skill removes it and opens the next; the last one leaves an empty queue", async () => {
  admin.getSkillReviewVersion.mockResolvedValue({ skillContent: null });
  admin.publishSkillSubmission.mockResolvedValue({});
  admin.rejectSkillSubmission.mockResolvedValue({});
  await renderReview([
    entry,
    { ...entry, skillId: "skill_2", skillVersionId: "ver_2", slug: "gh-acme-skills-xlsx", displayName: "XLSX" },
  ]);

  await act(async () => button("Approve and publish")!.click());
  expect(admin.publishSkillSubmission).toHaveBeenCalledWith("ver_1", undefined);
  expect(rows()).toHaveLength(1);
  expect(detail()?.textContent).toContain("gh-acme-skills-xlsx");

  await act(async () => button("Reject")!.click());
  expect(admin.rejectSkillSubmission).toHaveBeenCalledWith("ver_2", undefined);
  expect(detail()).toBeNull();
  expect(container.textContent).toContain("No skill submissions need review.");
});

test("a SKILL.md that fails to load says so and leaves the decision available", async () => {
  admin.getSkillReviewVersion.mockRejectedValue(new Error("offline"));
  await renderReview([entry]);
  expect(detail()?.textContent).toContain("Failed to load SKILL.md.");
  expect(button("Approve and publish")).toBeDefined();
});

test("a public skill's new version shows why it is here and what changed; keeping it acknowledges the version", async () => {
  admin.acknowledgeSkillVersion.mockResolvedValue({});
  await renderListing([
    {
      ...entry,
      reason: "new-version-scripts",
      visibility: "public",
      changes: {
        added: ["scripts/run.sh"],
        removed: [],
        modified: ["SKILL.md"],
        newScripts: ["scripts/run.sh"],
        newFlags: [],
        compareUrl: "https://github.com/acme/skills/compare/a...b",
      },
    },
  ]);
  expect(container.textContent).toContain("Public · new version adds scripts");
  const changes = container.querySelector(
    '[data-testid="listing-queue-changes"]',
  );
  expect(changes?.textContent).toContain("New scripts: scripts/run.sh");
  expect(changes?.textContent).toContain("Modified: SKILL.md");
  expect(changes?.querySelector("a")?.href).toBe(
    "https://github.com/acme/skills/compare/a...b",
  );
  expect(button("List publicly")).toBeUndefined();

  await act(async () => button("Keep public")!.click());
  expect(admin.acknowledgeSkillVersion).toHaveBeenCalledWith("ver_1");
  expect(admin.listSkillPublicly).not.toHaveBeenCalled();
  // Decided: it leaves the list.
  expect(container.textContent).not.toContain("gh-acme-skills-pdf");
});

test("withdrawing a public skill's new version delists it", async () => {
  admin.delistSkill.mockResolvedValue({});
  await renderListing([
    {
      ...entry,
      reason: "new-version-flags",
      visibility: "public",
      changes: null,
    },
  ]);
  await act(async () => button("Withdraw")!.click());
  expect(admin.delistSkill).toHaveBeenCalledWith("skill_1");
  expect(admin.acknowledgeSkillVersion).not.toHaveBeenCalled();
});

test("a flagged skill that is not public yet is still listed or kept private", async () => {
  admin.listSkillPublicly.mockResolvedValue({});
  // As an older API sends it: no reason at all.
  await renderListing([entry]);
  expect(button("Keep public")).toBeUndefined();
  await act(async () => button("List publicly")!.click());
  expect(admin.listSkillPublicly).toHaveBeenCalledWith("skill_1");
});

test("collection slugs are read one per line or comma-separated, in order, once each", () => {
  expect(parseCollectionSlugs(" pdf \n\nxlsx, docx\npdf\n")).toEqual([
    "pdf",
    "xlsx",
    "docx",
  ]);
  expect(parseCollectionSlugs("  \n ")).toEqual([]);
});
