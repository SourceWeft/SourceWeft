// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SkillReviewQueue queue="listing" />));
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );

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
    { ...entry, reason: "new-version-flags", visibility: "public", changes: null },
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
