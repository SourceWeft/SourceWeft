import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeInvokedSkillIds } from "./invoked-skills";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { shouldApplyLegacySlashSkillSelection } from "./skill-selection-policy";

function skill(input: Partial<EnabledSkillDescriptor>): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "skill-1",
    sourceType: "builtin",
    name: "skill",
    version: "1.0.0",
    description: "Skill",
    files: [],
    ...input,
  };
}

test("normalizeInvokedSkillIds only keeps explicitly invoked enabled skills", () => {
  assert.deepEqual(
    normalizeInvokedSkillIds({
      enabledSkills: [
        skill({ workspaceSkillId: "builtin:ppt-deck", name: "ppt-deck" }),
        skill({
          workspaceSkillId: "builtin:image-generate",
          name: "image-generate",
        }),
      ],
      requestedSkillIds: [
        "builtin:image-generate",
        "missing-skill",
        "builtin:image-generate",
        42,
      ],
    }),
    ["builtin:image-generate"],
  );
});

test("normalizeInvokedSkillIds does not treat selected skills as invoked", () => {
  assert.deepEqual(
    normalizeInvokedSkillIds({
      enabledSkills: [
        skill({ workspaceSkillId: "builtin:ppt-deck", name: "ppt-deck" }),
        skill({
          workspaceSkillId: "builtin:image-generate",
          name: "image-generate",
        }),
      ],
      requestedSkillIds: undefined,
    }),
    [],
  );
});

test("slash skill selection is only auto-applied for legacy clients without skillIds", () => {
  assert.equal(
    shouldApplyLegacySlashSkillSelection(undefined),
    true,
  );
  assert.equal(shouldApplyLegacySlashSkillSelection({}), true);
  assert.equal(shouldApplyLegacySlashSkillSelection({ skillIds: [] }), false);
  assert.equal(
    shouldApplyLegacySlashSkillSelection({
      skillIds: ["builtin:ppt-deck"],
    }),
    false,
  );
});
