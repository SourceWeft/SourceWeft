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
    defaultEnabled: true,
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
  assert.equal(runtime.successCriteria, undefined);
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

function videoWorkflow(): CapabilityCommandWorkflow {
  return {
    execution: "agent",
    initialToolPolicy: "auto",
    toolPolicy: {
      allow: ["write_todos", "publish_video_presentation"],
      deny: ["task", "execute"],
    },
    defaultTools: ["publish_video_presentation"],
    permissionOverrides: { publish_video_presentation: "allow" },
    additionalPromptLines: [],
    successCriteria: {
      kind: "artifact",
      artifactType: "video_presentation",
      toolName: "publish_video_presentation",
    },
  };
}

test("default-enabled skill contributes tools and permissions without imposing workflow policy", () => {
  const workflow = videoWorkflow();
  const runtime = resolveSelectedSkillRuntimeContract({
    selectedSkills: [
      pptDeckSkill({
        name: "default-studio",
        displayName: "Default Studio",
        defaultEnabled: true,
      }),
    ],
    command: null,
    skillRuntimeWorkflows: new Map([["default-studio", workflow]]),
  });

  assert.deepEqual(runtime.defaultTools, ["publish_video_presentation"]);
  assert.deepEqual(runtime.permissionOverrides, {
    publish_video_presentation: "allow",
  });
  assert.equal(runtime.toolPolicy, undefined);
  assert.equal(runtime.successCriteria, undefined);
});

test("explicit non-default skill carries its strict tool surface without a slash command", () => {
  const workflow = videoWorkflow();
  const runtime = resolveSelectedSkillRuntimeContract({
    selectedSkills: [
      pptDeckSkill({
        name: "video-presentation",
        displayName: "Video",
        defaultEnabled: false,
      }),
    ],
    command: null,
    skillRuntimeWorkflows: new Map([["video-presentation", workflow]]),
  });

  assert.deepEqual(runtime.toolPolicy, workflow.toolPolicy);
  assert.deepEqual(runtime.successCriteria, workflow.successCriteria);
});

test("explicit non-default policy is not diluted by default-enabled skills", () => {
  const strictWorkflow = videoWorkflow();
  const passiveWorkflow: CapabilityCommandWorkflow = {
    ...videoWorkflow(),
    defaultTools: ["generate_image"],
    permissionOverrides: { generate_image: "allow" },
    toolPolicy: {
      allow: ["generate_image"],
      deny: ["publish_video_presentation"],
    },
  };
  const runtime = resolveSelectedSkillRuntimeContract({
    selectedSkills: [
      pptDeckSkill({
        name: "image-generate",
        displayName: "Image",
        defaultEnabled: true,
      }),
      pptDeckSkill({
        name: "video-presentation",
        displayName: "Video",
        defaultEnabled: false,
      }),
    ],
    command: null,
    skillRuntimeWorkflows: new Map([
      ["image-generate", passiveWorkflow],
      ["video-presentation", strictWorkflow],
    ]),
  });

  assert.deepEqual(runtime.defaultTools, [
    "generate_image",
    "publish_video_presentation",
  ]);
  assert.deepEqual(runtime.permissionOverrides, {
    generate_image: "allow",
    publish_video_presentation: "allow",
  });
  assert.deepEqual(runtime.toolPolicy, strictWorkflow.toolPolicy);
  assert.deepEqual(runtime.successCriteria, strictWorkflow.successCriteria);
});

test("command workflow replaces selected-skill policy and success criteria", () => {
  const skillWorkflow = videoWorkflow();
  const commandWorkflow: CapabilityCommandWorkflow = {
    execution: "agent",
    defaultTools: ["web_search"],
    permissionOverrides: { web_search: "allow" },
    additionalPromptLines: [],
    successCriteria: {
      kind: "tool_call",
      toolName: "web_search",
    },
  };
  const runtime = resolveSelectedSkillRuntimeContract({
    selectedSkills: [
      pptDeckSkill({
        name: "video-presentation",
        displayName: "Video",
        defaultEnabled: false,
      }),
    ],
    command: {
      name: "web-search",
      canonicalName: "/web-search",
      arguments: "query",
      kind: "tool",
      displayName: "Web Search",
      description: "Search the web.",
      workflow: {
        ...commandWorkflow,
        name: "/web-search",
        arguments: "query",
        kind: "tool_workflow",
        renderedPrompt: "Search the web for query.",
      },
    },
    skillRuntimeWorkflows: new Map([["video-presentation", skillWorkflow]]),
  });

  assert.equal(runtime.toolPolicy, undefined);
  assert.deepEqual(runtime.successCriteria, commandWorkflow.successCriteria);
});

test("two explicit strict workflows fail instead of dropping success criteria", () => {
  const workflow = videoWorkflow();
  assert.throws(
    () =>
      resolveSelectedSkillRuntimeContract({
        selectedSkills: [
          pptDeckSkill({
            name: "video-presentation",
            displayName: "Video",
            defaultEnabled: false,
          }),
          pptDeckSkill({
            name: "another-studio",
            displayName: "Another Studio",
            defaultEnabled: false,
          }),
        ],
        command: null,
        skillRuntimeWorkflows: new Map([
          ["video-presentation", workflow],
          ["another-studio", workflow],
        ]),
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "MULTIPLE_STRICT_SKILL_WORKFLOWS",
  );
});
