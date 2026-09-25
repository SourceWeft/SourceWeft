// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, expect, test } from "vitest";

import { SkillRow } from "./skill-row";
import type { HubSkillItem } from "./use-skills";
import { mountWithIntl, unmountAll } from "@/test/react";

afterEach(unmountAll);

async function render(skill: HubSkillItem, selected: boolean): Promise<string> {
  const { container } = await mountWithIntl(
    createElement(SkillRow, {
      onOpenSkill: () => {},
      onToggle: () => {},
      selected,
      skill,
    }),
  );
  return container.textContent ?? "";
}

function registrySkill(overrides: Partial<HubSkillItem> = {}): HubSkillItem {
  return {
    catalogId: "def-1:ver-1",
    description: "Builds slide decks.",
    displayName: "Deck Builder",
    hasReadme: false,
    id: "ws-skill-1",
    name: "Deck Builder",
    slug: "gh-acme-skills-deck-builder",
    sourceType: "registry_github",
    version: "abc123",
    workspaceSkillId: "ws-skill-1",
    ...overrides,
  };
}

// A switched-off skill that ships scripts says so on its row, so whoever turns
// it back on knows that doing so makes code runnable, not just instructions.
test("an off executable registry skill says why it is off", async () => {
  const text = await render(
    registrySkill({ registryCapability: "executable" }),
    false,
  );
  expect(text).toContain("Ships scripts");
});

test("the same skill switched on drops the notice", async () => {
  const text = await render(
    registrySkill({ registryCapability: "executable" }),
    true,
  );
  expect(text).not.toContain("Ships scripts");
});

test("a prompt-only skill never shows it, on or off", async () => {
  expect(
    await render(registrySkill({ registryCapability: "prompt-only" }), false),
  ).not.toContain("Ships scripts");
  // Builtins and custom skills carry no registry capability at all.
  expect(await render(registrySkill(), false)).not.toContain("Ships scripts");
});

// The agent installs as the user, so the row is the only place this shows.
test("a skill the agent installed says so; one a person installed does not", async () => {
  expect(
    await render(registrySkill({ installedVia: "agent" }), true),
  ).toContain("Added by agent");
  expect(await render(registrySkill(), true)).not.toContain("Added by agent");
});

// An install stays on the version it was made with; the row only points at the
// skill's page, where updating asks first. Nothing updates from the hub.
test("a community skill behind its current version links to its versions; clicking the link does not toggle the row", async () => {
  let toggled = 0;
  const { container } = await mountWithIntl(
    createElement(SkillRow, {
      onOpenSkill: () => {},
      onToggle: () => {
        toggled += 1;
      },
      selected: true,
      skill: registrySkill({ updateAvailable: true }),
    }),
  );
  const link = container.querySelector("a")!;
  expect(link.textContent).toContain("Update available");
  expect(link.getAttribute("href")).toBe(
    "/dashboard/skills/gh-acme-skills-deck-builder#versions",
  );
  // jsdom does not navigate, but it still bubbles the click to the row.
  link.addEventListener("click", (event) => event.preventDefault());
  act(() => link.click());
  expect(toggled).toBe(0);
});

test("an up-to-date skill, and a skill with no version switch, show no update badge", async () => {
  expect(await render(registrySkill(), true)).not.toContain("Update available");
  expect(
    await render(
      registrySkill({ sourceType: "workspace_custom", updateAvailable: true }),
      true,
    ),
  ).not.toContain("Update available");
});
