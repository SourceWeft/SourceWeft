import assert from "node:assert/strict";
import { test } from "vitest";
import { AGENT_TOOL_NAMES } from "@sourceweft/agent-tool-registry";
import { resolveSelectedSkillRuntimeContract } from "./active-skill-runtime";
import type { EnabledSkillDescriptor } from "../../skills/types";
import type { CapabilityCommandWorkflow } from "@sourceweft/capability-runtime";

function pptDeckSkill(
  input: Partial<EnabledSkillDescriptor> = {},
): EnabledSkillDescriptor {
  return {
    workspaceSkillId: "builtin:ppt-deck",
    selectionId: "builtin:ppt-deck",
    sourceType: "builtin",
    name: "ppt-deck",
    displayName: "PPT Deck",
    version: "1.0.0",
    description: "Create PPT decks.",
    files: [],
    ...input,
  };
}

test("ppt-deck selected skill enables sandbox tools without requiring slides output", () => {
  const pptWorkflow: CapabilityCommandWorkflow = {
    execution: "agent",
    defaultTools: [
      AGENT_TOOL_NAMES.prepareSandboxWorkspace,
      AGENT_TOOL_NAMES.execute,
      AGENT_TOOL_NAMES.publishArtifact,
    ],
    permissionOverrides: {},
    additionalPromptLines: [],
    successCriteria: {
      kind: "artifact",
      artifactType: "slides",
      toolName: AGENT_TOOL_NAMES.publishArtifact,
    },
  };
  const runtime = resolveSelectedSkillRuntimeContract({
    selectedSkills: [pptDeckSkill()],
    command: null,
    skillRuntimeWorkflows: new Map([["ppt-deck", pptWorkflow]]),
  });

  assert.deepEqual(runtime.defaultTools, [
    AGENT_TOOL_NAMES.prepareSandboxWorkspace,
    AGENT_TOOL_NAMES.execute,
    AGENT_TOOL_NAMES.publishArtifact,
  ]);
  assert.deepEqual(runtime.permissionOverrides, {});
});

test("non-ppt custom skills only activate declared skill tools", () => {
  const runtime = resolveSelectedSkillRuntimeContract({
    selectedSkills: [
      pptDeckSkill({
        workspaceSkillId: "skill-search",
        selectionId: "skill-search",
        sourceType: "workspace_custom",
        name: "search",
        tools: [AGENT_TOOL_NAMES.webSearch],
      }),
    ],
    command: null,
  });

  assert.deepEqual(runtime.defaultTools, [AGENT_TOOL_NAMES.webSearch]);
});
