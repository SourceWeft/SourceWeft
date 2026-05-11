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

test("generate_image tool is registered by default without forcing a call", async () => {
  const result = await runArtifactIntentPipeline({
    enabledSkills: [],
    threadModelSettings,
    resolveImageProfile,
  });

  assert.equal(result.decision.kind, "image");
  assert.equal(result.decision.shouldInjectTool, true);
  assert.equal(result.decision.source, "none");
});

test("artifact pipeline does not classify prompt text with keyword lists", async () => {
  const result = await runArtifactIntentPipeline({
    enabledSkills: [],
    threadModelSettings,
    resolveImageProfile,
  });

  assert.equal(result.decision.kind, "image");
  assert.equal(result.decision.shouldInjectTool, true);
  assert.equal(result.decision.source, "none");
  assert.equal(
    result.decision.reason,
    "generate_image is available for this turn when the model decides a visual artifact is needed.",
  );
});

test("generate_image tool config overrides skill defaults", async () => {
  const result = await runArtifactIntentPipeline({
    tools: {
      generate_image: {
        modelAlias: "requested-image-model",
        config: {
          aspectRatio: "1:1",
          quality: "standard",
          style: "cartoon",
        },
      },
    },
    enabledSkills: [],
    threadModelSettings,
    resolveImageProfile: async (input) => {
      assert.equal(input.requestedModelAlias, "requested-image-model");
      return imageProfile;
    },
  });

  assert.equal(result.decision.kind, "image");
  assert.equal(result.decision.shouldInjectTool, true);
  assert.equal(result.decision.source, "explicit_tool");
  assert.deepEqual(result.decision.config, {
    aspectRatio: "1:1",
    quality: "standard",
    style: "cartoon",
  });
});

test("generate_image tool can be disabled for a turn", async () => {
  const result = await runArtifactIntentPipeline({
    tools: {
      generate_image: {
        enabled: false,
      },
    },
    enabledSkills: [
      {
        workspaceSkillId: "skill-1",
        sourceType: "workspace_custom",
        name: "course-cover",
        version: "1.0.0",
        description: "Generate course cover images.",
        tools: ["generate_image"],
        files: [],
      },
    ],
    threadModelSettings,
    resolveImageProfile,
  });

  assert.equal(result.decision.kind, null);
  assert.equal(result.decision.shouldInjectTool, false);
  assert.equal(result.decision.source, "none");
});

test("selected skill generate_image tool injects image tool with default config", async () => {
  const result = await runArtifactIntentPipeline({
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

test("skills without generate_image do not provide image model defaults", async () => {
  const result = await runArtifactIntentPipeline({
    enabledSkills: [
      {
        workspaceSkillId: "skill-1",
        sourceType: "workspace_custom",
        name: "descriptive-image-skill",
        version: "1.0.0",
        description: "Generate image posters.",
        models: { image: "ignored-image-model" },
        defaultConfig: {
          generate_image: {
            aspectRatio: "1:1",
          },
        },
        files: [],
      },
    ],
    threadModelSettings,
    resolveImageProfile: async (input) => {
      assert.equal(input.requestedModelAlias, null);
      return imageProfile;
    },
  });

  assert.equal(result.decision.source, "none");
  assert.deepEqual(result.decision.config, {
    aspectRatio: "auto",
    quality: "auto",
    style: "auto",
  });
});
