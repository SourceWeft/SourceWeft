import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeInvokedSkillIds } from "./invoked-skills";
import type { EnabledSkillDescriptor } from "../../skills/types";
import { resolveRequestedThreadProfileAlias } from "./requested-profile-alias";

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

test("resolveRequestedThreadProfileAlias prefers execution config over legacy stream modelSettings", () => {
  assert.deepEqual(
    resolveRequestedThreadProfileAlias({
      execution: { profileAlias: "global-image-profile" },
      legacyProfileAlias: "legacy-image-profile",
      kind: "image",
    }),
    { provided: true, profileAlias: "global-image-profile" },
  );
});

test("resolveRequestedThreadProfileAlias normalizes default aliases to inherited defaults", () => {
  assert.deepEqual(
    resolveRequestedThreadProfileAlias({
      execution: { profileAlias: "vision-default" },
      kind: "vision",
    }),
    { provided: true, profileAlias: null },
  );
});

test("resolveRequestedThreadProfileAlias ignores BYOK execution profile aliases", () => {
  assert.deepEqual(
    resolveRequestedThreadProfileAlias({
      execution: {
        executionMode: "BYOK",
        byokModelId: "byok-image-model",
        profileAlias: "global-image-profile",
      },
      kind: "image",
    }),
    { provided: false, profileAlias: undefined },
  );
});
