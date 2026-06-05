import assert from "node:assert/strict";
import { test } from "vitest";
import { AGENT_TOOL_NAMES } from "@sourceweft/sdk";
import {
  buildComposerToolsSelection,
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  DEFAULT_PPTX_ARTIFACT_CONFIG,
} from "./tool-selection";

test("buildComposerToolsSelection includes custom pptx design settings", () => {
  const tools = buildComposerToolsSelection({
    imageGenerationEnabled: true,
    imageSupported: false,
    imageConfig: DEFAULT_IMAGE_ARTIFACT_CONFIG,
    pptxConfig: {
      design: {
        ...DEFAULT_PPTX_ARTIFACT_CONFIG.design,
        aspectRatio: "16:10",
        stylePreset: "technical",
      },
      generationMode: DEFAULT_PPTX_ARTIFACT_CONFIG.generationMode,
      output: {
        ...DEFAULT_PPTX_ARTIFACT_CONFIG.output,
        includeSourceJson: true,
      },
      rendering: DEFAULT_PPTX_ARTIFACT_CONFIG.rendering,
    },
    pptxGenerationEnabled: true,
    selectedSkills: [],
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generatePptx], {
    enabled: true,
    design: {
      aspectRatio: "16:10",
      language: "auto",
      stylePreset: "technical",
    },
    output: {
      includeSourceJson: true,
    },
  });
});

test("buildComposerToolsSelection sends only supported pptx output settings", () => {
  const tools = buildComposerToolsSelection({
    imageGenerationEnabled: true,
    imageSupported: false,
    imageConfig: DEFAULT_IMAGE_ARTIFACT_CONFIG,
    pptxConfig: {
      design: DEFAULT_PPTX_ARTIFACT_CONFIG.design,
      generationMode: DEFAULT_PPTX_ARTIFACT_CONFIG.generationMode,
      output: {
        ...DEFAULT_PPTX_ARTIFACT_CONFIG.output,
        includeSourceJson: true,
      },
      rendering: DEFAULT_PPTX_ARTIFACT_CONFIG.rendering,
    },
    pptxGenerationEnabled: true,
    selectedSkills: [],
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generatePptx], {
    enabled: true,
    output: {
      includeSourceJson: true,
    },
  });
});

test("buildComposerToolsSelection maps editable pptx switch to native mode", () => {
  const tools = buildComposerToolsSelection({
    imageGenerationEnabled: true,
    imageSupported: false,
    imageConfig: DEFAULT_IMAGE_ARTIFACT_CONFIG,
    pptxConfig: {
      ...DEFAULT_PPTX_ARTIFACT_CONFIG,
      generationMode: "editable_native",
    },
    pptxGenerationEnabled: true,
    selectedSkills: [],
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generatePptx], {
    enabled: true,
    generationMode: "editable_native",
  });
});

test("buildComposerToolsSelection enables video presentation for supporting skills", () => {
  const tools = buildComposerToolsSelection({
    imageGenerationEnabled: true,
    imageSupported: false,
    imageConfig: DEFAULT_IMAGE_ARTIFACT_CONFIG,
    pptxConfig: DEFAULT_PPTX_ARTIFACT_CONFIG,
    pptxGenerationEnabled: true,
    videoPresentationGenerationEnabled: true,
    selectedSkills: [
      {
        id: "skill-1",
        catalogId: "catalog-1",
        slug: "video-presentation",
        name: "video-presentation",
        displayName: "Video presentation",
        description: "Creates video presentations",
        sourceType: "builtin",
        version: "1.0.0",
        hasReadme: false,
        tools: [AGENT_TOOL_NAMES.generateVideoPresentation],
      },
    ],
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generateVideoPresentation], {
    enabled: true,
  });
});

test("buildComposerToolsSelection sends explicit video presentation switch", () => {
  const tools = buildComposerToolsSelection({
    imageGenerationEnabled: true,
    imageSupported: false,
    imageConfig: DEFAULT_IMAGE_ARTIFACT_CONFIG,
    pptxConfig: DEFAULT_PPTX_ARTIFACT_CONFIG,
    pptxGenerationEnabled: true,
    videoPresentationGenerationEnabled: true,
    videoPresentationUserConfigured: true,
    selectedSkills: [],
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generateVideoPresentation], {
    enabled: true,
  });
});

test("buildComposerToolsSelection sends disabled video narration config", () => {
  const tools = buildComposerToolsSelection({
    imageGenerationEnabled: true,
    imageSupported: false,
    imageConfig: DEFAULT_IMAGE_ARTIFACT_CONFIG,
    pptxConfig: DEFAULT_PPTX_ARTIFACT_CONFIG,
    pptxGenerationEnabled: true,
    videoPresentationGenerationEnabled: true,
    videoPresentationNarrationEnabled: false,
    selectedSkills: [],
  });

  assert.deepEqual(tools?.[AGENT_TOOL_NAMES.generateVideoPresentation], {
    enabled: true,
    narration: {
      enabled: false,
    },
  });
});
