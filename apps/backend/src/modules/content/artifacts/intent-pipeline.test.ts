import assert from "node:assert/strict";
import test from "node:test";
import { runArtifactIntentPipeline } from "./intent-pipeline";
import type { ResolvedArtifactImageProfile } from "./intent-pipeline";

const threadModelSettings = {
  llmProfileAlias: null,
  imageProfileAlias: "image-default",
  visionProfileAlias: null,
  llmModelAlias: null,
  imageModelAlias: null,
  visionModelAlias: null,
};

const imageProfile: ResolvedArtifactImageProfile = {
  profile: {
    id: "image-profile",
    kind: "image",
    gatewayConfigId: "gateway",
    profileAlias: "image-default",
    modelAlias: "image-default",
    requestedDimensions: null,
    vectorStrategy: "disabled",
    isDefault: true,
    isActive: true,
    configJson: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  capabilities: {
    supported: true,
    controls: {
      aspectRatio: { values: ["auto", "1:1"] },
      quality: { values: ["auto", "standard"] },
      style: { values: ["auto", "cartoon"] },
    },
  },
};

async function resolveImageProfile() {
  return imageProfile;
}

test("artifact auto selection registers image tool without forcing a call", async () => {
  const result = await runArtifactIntentPipeline({
    content: "解释费曼学习法",
    tools: {
      artifact: {
        kind: "image",
        mode: "auto",
      },
    },
    enabledSkills: [],
    threadModelSettings,
    resolveImageProfile,
  });

  assert.equal(result.decision.kind, "image");
  assert.equal(result.decision.shouldInjectTool, true);
  assert.equal(result.decision.requireToolCall, false);
  assert.equal(result.decision.source, "explicit_tool");
});

test("artifact generate selection registers image tool and requires a call", async () => {
  const result = await runArtifactIntentPipeline({
    content: "解释费曼学习法",
    tools: {
      artifact: {
        kind: "image",
        mode: "generate",
      },
    },
    enabledSkills: [],
    threadModelSettings,
    resolveImageProfile,
  });

  assert.equal(result.decision.kind, "image");
  assert.equal(result.decision.shouldInjectTool, true);
  assert.equal(result.decision.requireToolCall, true);
  assert.equal(result.decision.source, "explicit_tool");
});

test("selected skill generate_image tool injects image tool with default config", async () => {
  const result = await runArtifactIntentPipeline({
    content: "做一个课程封面",
    enabledSkills: [
      {
        workspaceSkillId: "skill-1",
        sourceType: "workspace_custom",
        name: "course-cover",
        version: "1.0.0",
        description: "Generate course cover images.",
        tools: ["generate_image"],
        models: { image: "image-creative" },
        defaultConfig: {
          generate_image: {
            aspectRatio: "1:1",
            quality: "standard",
            style: "cartoon",
          },
        },
        files: [],
      },
    ],
    threadModelSettings,
    resolveImageProfile: async (input) => {
      assert.equal(input.requestedModelAlias, "image-creative");
      return imageProfile;
    },
  });

  assert.equal(result.decision.kind, "image");
  assert.equal(result.decision.shouldInjectTool, true);
  assert.equal(result.decision.source, "skill");
  assert.deepEqual(result.decision.config, {
    aspectRatio: "1:1",
    quality: "standard",
    style: "cartoon",
  });
});

test("selected skill config keeps first selected skill precedence and fills gaps", async () => {
  const result = await runArtifactIntentPipeline({
    content: "生成图片",
    enabledSkills: [
      {
        workspaceSkillId: "skill-1",
        sourceType: "workspace_custom",
        name: "first",
        version: "1.0.0",
        description: "First image skill.",
        tools: ["generate_image"],
        defaultConfig: {
          generate_image: {
            aspectRatio: "1:1",
          },
        },
        files: [],
      },
      {
        workspaceSkillId: "skill-2",
        sourceType: "workspace_custom",
        name: "second",
        version: "1.0.0",
        description: "Second image skill.",
        tools: ["generate_image"],
        defaultConfig: {
          generate_image: {
            aspectRatio: "auto",
            quality: "standard",
            style: "cartoon",
          },
        },
        files: [],
      },
    ],
    threadModelSettings,
    resolveImageProfile,
  });

  assert.deepEqual(result.decision.config, {
    aspectRatio: "1:1",
    quality: "standard",
    style: "cartoon",
  });
});
