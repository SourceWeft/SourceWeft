// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";

import { SkillRow } from "./skill-row";
import type { HubSkillItem } from "./use-skills";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(skill: HubSkillItem, selected: boolean): string {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(SkillRow, {
        onOpenSkill: () => {},
        onToggle: () => {},
        selected,
        skill,
      }),
    );
  });
  return container.textContent ?? "";
}

function registrySkill(
  overrides: Partial<HubSkillItem> = {},
): HubSkillItem {
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

// A skill that ships scripts is installed switched OFF on purpose. Without a
// reason on the row, the user sees a skill they just asked for sitting inert
// and reads it as a failed install.
test("an off executable registry skill says why it is off", () => {
  const text = render(
    registrySkill({ registryCapability: "executable" }),
    false,
  );
  expect(text).toContain("Ships scripts");
});

test("the same skill switched on drops the notice", () => {
  const text = render(registrySkill({ registryCapability: "executable" }), true);
  expect(text).not.toContain("Ships scripts");
});

test("a prompt-only skill never shows it, on or off", () => {
  expect(
    render(registrySkill({ registryCapability: "prompt-only" }), false),
  ).not.toContain("Ships scripts");
  // Builtins and custom skills carry no registry capability at all.
  expect(render(registrySkill(), false)).not.toContain("Ships scripts");
});
