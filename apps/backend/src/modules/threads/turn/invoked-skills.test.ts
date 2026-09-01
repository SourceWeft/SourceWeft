import assert from "node:assert/strict";
import { test } from "vitest";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { resolveActiveSkillPromptIds } from "./invoked-skills";

function skill(input: {
  id: string;
  defaultEnabled?: boolean;
}): EnabledSkillDescriptor {
  return {
    workspaceSkillId: input.id,
    selectionId: input.id,
    sourceType: "builtin",
    name: input.id,
    version: "1.0.0",
    description: input.id,
    defaultEnabled: input.defaultEnabled,
    files: [],
  };
}

test("selected non-default skills contribute prompt while default skills stay passive", () => {
  const enabledSkills = [
    skill({ id: "image-generate", defaultEnabled: true }),
    skill({ id: "ppt-deck", defaultEnabled: true }),
    skill({ id: "video-presentation", defaultEnabled: false }),
  ];

  assert.deepEqual(
    resolveActiveSkillPromptIds({
      enabledSkills,
      invokedSkillIds: [],
      selectedSkillIds: ["image-generate", "ppt-deck", "video-presentation"],
    }),
    ["video-presentation"],
  );
});

test("an explicitly invoked default skill remains prompt-active", () => {
  const enabledSkills = [
    skill({ id: "image-generate", defaultEnabled: true }),
    skill({ id: "video-presentation", defaultEnabled: false }),
  ];

  assert.deepEqual(
    resolveActiveSkillPromptIds({
      enabledSkills,
      invokedSkillIds: ["image-generate", "missing-skill"],
      selectedSkillIds: ["image-generate", "video-presentation"],
    }),
    ["video-presentation", "image-generate"],
  );
});
