// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { button, click, flush, mountWithIntl, unmountAll } from "@/test/react";

const api = vi.hoisted(() => ({
  getOwnerSkillListing: vi.fn(),
  setOwnerSkillListing: vi.fn(),
}));
vi.mock("../../../../lib/sdk", () => ({ contentClient: api }));
const analytics = vi.hoisted(() => ({ trackBadgeSnippetCopied: vi.fn() }));
vi.mock("../../../../lib/analytics-events", () => analytics);
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { SkillOwnerListing } from "./skill-owner-listing";

const writeText = vi.fn();

beforeEach(() => {
  window.__SOURCEWEFT_CONFIG__ = {
    analytics: {},
    apiBaseUrl: "https://api.sourceweft.test",
    googleOneTapClientId: "",
    googleOneTapEnabled: false,
    googleOneTapFedCmEnabled: false,
    webBaseUrl: "https://sourceweft.test",
  };
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(async () => {
  await unmountAll();
  vi.resetAllMocks();
  delete window.__SOURCEWEFT_CONFIG__;
});

async function render(listing: {
  listed: boolean;
  heldBy: "admin" | "owner" | null;
}) {
  api.getOwnerSkillListing.mockResolvedValue({
    skillId: "skill-1",
    ...listing,
  });
  const view = await mountWithIntl(
    <SkillOwnerListing
      catalogId="skill-1:v1"
      slug="gh-ada-skills-pdf"
      workspaceId="ws-1"
    />,
  );
  await flush();
  return view.container;
}

test("hands the author of a listed skill its README badge, open, linking to the public page", async () => {
  const container = await render({ heldBy: null, listed: true });
  expect(api.getOwnerSkillListing).toHaveBeenCalledWith("ws-1", "skill-1:v1");

  const badge = container.querySelector('[data-testid="catalog-badge"]')!;
  expect(badge.tagName).toBe("DIV");
  expect(badge.textContent).toContain(
    "Your skill is listed. Add this badge to your repository's README",
  );
  expect(badge.querySelector("img")?.getAttribute("src")).toBe(
    "https://sourceweft.test/badge/skills/gh-ada-skills-pdf.svg",
  );
  expect(badge.querySelector("code")?.textContent).toBe(
    "[![Listed on SourceWeft](https://sourceweft.test/badge/skills/gh-ada-skills-pdf.svg)](https://sourceweft.test/skills/gh-ada-skills-pdf?utm_source=readme&utm_medium=badge)",
  );

  await click(button("Copy", badge));
  await flush();
  expect(analytics.trackBadgeSnippetCopied).toHaveBeenCalledWith({
    kind: "skill",
    method: "markdown",
    surface: "skill_owner",
  });
});

test("offers no badge for a skill that is not on the market", async () => {
  for (const listing of [
    { heldBy: null, listed: false }, // pending
    { heldBy: "owner" as const, listed: false }, // kept private
    { heldBy: "admin" as const, listed: false }, // withdrawn by an admin
  ]) {
    const container = await render(listing);
    expect(
      container.querySelector('[data-testid="skill-owner-listing"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="catalog-badge"]')).toBeNull();
    await unmountAll();
  }
});
