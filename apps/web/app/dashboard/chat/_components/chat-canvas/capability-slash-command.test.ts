import assert from "node:assert/strict";
import { test } from "vitest";
import type { CapabilityCatalogCommand } from "@sourceweft/sdk";
import type { ChatSkillItem } from "./types";
import {
  buildSkillSlashCommandFamilies,
  capabilityCommandDisplayLabel,
  isCapabilityCatalogSlashCommand,
} from "./capability-slash-command";

function command(
  overrides: Partial<CapabilityCatalogCommand> = {},
): CapabilityCatalogCommand {
  return {
    action: { kind: "tool", targetId: "web_search" },
    aliases: ["web"],
    capabilityId: "sourceweft/web-search",
    category: "Research",
    contributionId: "web_search",
    displayTitle: "Search Web",
    hasWorkflow: false,
    id: "cap:sourceweft/web-search:web_search",
    order: 0,
    parentKind: null,
    parentTitle: null,
    sourcePackageName: "@sourceweft/builtin-tool-web-search",
    title: "Search Web",
    visible: true,
    ...overrides,
  };
}

function skill(overrides: Partial<ChatSkillItem> = {}): ChatSkillItem {
  return {
    catalogId: "catalog-skill-1",
    description: "Skill description",
    displayName: "Feynman",
    hasReadme: true,
    id: "skill-1",
    name: "feynman",
    slug: "feynman",
    sourceType: "builtin",
    version: "1.0.0",
    ...overrides,
  };
}

test("hides visible tool commands without workflow from slash commands", () => {
  assert.equal(isCapabilityCatalogSlashCommand(command()), false);
});

test("shows visible tool commands with workflow as slash commands", () => {
  assert.equal(
    isCapabilityCatalogSlashCommand(command({ hasWorkflow: true })),
    true,
  );
});

test("shows visible skill capability workflows for slash handling", () => {
  assert.equal(
    isCapabilityCatalogSlashCommand(
      command({
        action: { kind: "skill", targetId: "feynman" },
        hasWorkflow: false,
      }),
    ),
    true,
  );
});

test("uses capability display title for slash labels", () => {
  assert.equal(
    capabilityCommandDisplayLabel(
      command({
        action: { kind: "skill", targetId: "feynman" },
        displayTitle: "Feynman / Explain Simply",
        parentKind: "skill",
        parentTitle: "Feynman",
        title: "Explain Simply",
      }),
    ),
    "Feynman / Explain Simply",
  );
});

test("builds skill slash command families in skill order", () => {
  const items = buildSkillSlashCommandFamilies({
    commands: [
      command({
        action: { kind: "skill", targetId: "feynman" },
        hasWorkflow: true,
        id: "cap:sourceweft/feynman:feynman",
        title: "Feynman",
      }),
    ],
    skills: [
      skill({
        displayName: "Feynman",
        id: "feynman-skill",
        name: "feynman",
        slug: "feynman",
      }),
      skill({
        displayName: "Meeting Summary",
        id: "meeting-skill",
        name: "meeting-summary",
        slug: "meeting-summary",
      }),
    ],
  });

  assert.deepEqual(
    items.map((item) => `${item.kind}:${item.skill.id}`),
    ["capability-skill-command:feynman-skill", "skill:meeting-skill"],
  );
});

test("does not add legacy skill activation when a capability command exists", () => {
  const items = buildSkillSlashCommandFamilies({
    commands: [
      command({
        action: { kind: "skill", targetId: "ppt-deck" },
        hasWorkflow: true,
        id: "cap:sourceweft/ppt-deck:ppt-deck",
        title: "PPT Deck",
      }),
    ],
    skills: [
      skill({
        displayName: "PPT Deck",
        id: "ppt-skill",
        name: "ppt-deck",
        slug: "ppt-deck",
      }),
    ],
  });

  assert.deepEqual(
    items.map((item) => item.kind),
    ["capability-skill-command"],
  );
});

test("only builds slash families for effective selected skills", () => {
  const items = buildSkillSlashCommandFamilies({
    commands: [
      command({
        action: { kind: "skill", targetId: "image-generate" },
        aliases: ["image", "generate-image", "picture"],
        hasWorkflow: true,
        id: "cap:sourceweft/image-generate:image-generate",
        title: "Image Generate",
      }),
    ],
    skills: [],
  });

  assert.deepEqual(items, []);
});

test("hides invisible and unsupported capability commands", () => {
  assert.equal(
    isCapabilityCatalogSlashCommand(command({ visible: false })),
    false,
  );
  assert.equal(
    isCapabilityCatalogSlashCommand(
      command({
        action: { kind: "retrieval", targetId: "workspace_search" },
        hasWorkflow: true,
      }),
    ),
    false,
  );
});
