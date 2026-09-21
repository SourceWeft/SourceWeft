import assert from "node:assert/strict";
import { test } from "vitest";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { normalizeInvokedSkillIds } from "./invoked-skills";

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

test("only explicitly invoked, enabled skills are invoked", () => {
  const enabledSkills = [
    skill({ id: "image-generate", defaultEnabled: true }),
    skill({ id: "video-presentation", defaultEnabled: false }),
  ];

  assert.deepEqual(
    normalizeInvokedSkillIds({
      enabledSkills,
      requestedSkillIds: ["image-generate", "missing-skill"],
    }),
    ["image-generate"],
  );
});

test("a checked non-default skill is not invoked by being selected", () => {
  assert.deepEqual(
    normalizeInvokedSkillIds({
      enabledSkills: [skill({ id: "video-presentation", defaultEnabled: false })],
      requestedSkillIds: undefined,
    }),
    [],
  );
});
