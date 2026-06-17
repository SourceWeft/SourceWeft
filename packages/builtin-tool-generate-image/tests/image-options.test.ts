import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  generateImageToolOptions,
  normalizeGenerateImageToolSelection,
  resolveGenerateImageIntentDecision,
  resolveImageModelCapabilities,
} from "../src/index";

test("generate-image package owns option metadata and defaults", () => {
  const optionIds = generateImageToolOptions.map((option) => option.id);

  assert.deepEqual(optionIds, ["aspectRatio", "quality", "style"]);
  assert.deepEqual(DEFAULT_IMAGE_ARTIFACT_CONFIG, {
    aspectRatio: "auto",
    quality: "auto",
    style: "auto",
  });
  assert.equal(
    generateImageToolOptions.every(
      (option) => option.target.toolId === "generate_image",
    ),
    true,
  );
});

test("generate-image package normalizes malformed selection config", () => {
  const selection = normalizeGenerateImageToolSelection({
    enabled: true,
    mode: "generate",
    modelAlias: " image-creative ",
    config: {
      aspectRatio: "bad",
      quality: "highest",
      style: "bad",
    },
  });

  assert.deepEqual(selection, {
    enabled: true,
    mode: "generate",
    modelAlias: "image-creative",
    config: {
      quality: "highest",
    },
  });
});

test("generate-image package resolves provider model capabilities", () => {
  const openrouter = resolveImageModelCapabilities({
    providerKind: "openrouter",
    modelId: "google/gemini-3.1-flash-image-preview",
  });
  const unsupported = resolveImageModelCapabilities({
    providerKind: "unknown-provider",
    modelId: "unknown/model",
  });

  assert.equal(openrouter.supported, true);
  assert.equal(openrouter.controls.aspectRatio?.values.includes("1:8"), true);
  assert.equal(openrouter.controls.quality?.values.includes("highest"), true);
  assert.equal(unsupported.supported, false);
  assert.deepEqual(unsupported.controls.aspectRatio?.values, ["auto"]);
});

test("generate-image package resolves pure intent decisions", async () => {
  const result = await resolveGenerateImageIntentDecision({
    defaultToolEnabled: true,
    enabledSkills: [],
    tools: {
      generate_image: {
        config: {
          aspectRatio: "1:1",
          quality: "highest",
          style: "cartoon",
        },
      },
    },
    resolveImageProfile: async (request) => {
      assert.equal(request.explicit, true);
      return {
        capabilities: {
          supported: true,
          controls: {
            aspectRatio: { values: ["auto", "1:1"] },
            quality: { values: ["auto", "standard"] },
            style: { values: ["auto", "cartoon"] },
          },
        },
        profile: { profileAlias: "image-default" },
      };
    },
  });

  assert.equal(result.decision.shouldInjectTool, true);
  assert.deepEqual(result.decision.config, {
    aspectRatio: "1:1",
    quality: "auto",
    style: "cartoon",
  });
  assert.deepEqual(result.decision.warnings, ["image_quality_unsupported"]);
});
