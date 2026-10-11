// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import type { SkillClaimRepository } from "@sourceweft/contracts";

import { mountWithIntl, unmountAll } from "@/test/react";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: unknown; href: string }) => (
    <a href={href}>{children as never}</a>
  ),
}));

import { ClaimRepositoryCard } from "./claim-repository-card";
import type { ClaimRepositoryPlan } from "./claim-view";

const repository: SkillClaimRepository = {
  accountMethod: { available: true, reason: null },
  claimedBy: null,
  ownerType: "User",
  repo: "ada/skills",
  skillCount: 2,
  viewerClaim: null,
};

const HINT =
  "Next: add a “Listed on SourceWeft” badge to your README. Copy it from the page of any of your listed skills.";

afterEach(unmountAll);

async function render(plan: ClaimRepositoryPlan) {
  const { container } = await mountWithIntl(
    <ClaimRepositoryCard
      busy={false}
      error={null}
      onClaim={() => {}}
      plan={plan}
      repository={repository}
    />,
  );
  return container;
}

test("points a fresh claimant at the README badge", async () => {
  const container = await render({ kind: "claimedByYou" });
  expect(container.textContent).toContain("You have claimed this repository.");
  expect(container.textContent).toContain(HINT);
});

test("says nothing about the badge to anyone who has not claimed the repository", async () => {
  for (const plan of [
    { kind: "claimedBySomeone" },
    { kind: "organization" },
    { account: repository.accountMethod, kind: "open" },
  ] satisfies ClaimRepositoryPlan[]) {
    const container = await render(plan);
    expect(container.textContent).not.toContain("Listed on SourceWeft");
    await unmountAll();
  }
});
