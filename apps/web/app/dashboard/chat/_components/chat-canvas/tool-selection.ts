import {
  AGENT_TOOL_NAMES,
  isGeneratedImageArtifactToolName,
  isNotionToolName,
  isPresentationArtifactToolName,
  isVideoPresentationArtifactToolName,
  isSkillActivatedAgentTool,
} from "@sourceweft/sdk";
import type {
  ChatGeneratePptxToolSelection,
  ChatGenerateVideoPresentationToolSelection,
  ChatGenerateImageToolSelection,
  ChatImageArtifactConfig,
  ChatPptxArtifactConfig,
  ChatSkillItem,
  ChatToolsSelection,
  ImageAspectRatio,
  ImageModelCapabilities,
  ImageQuality,
  ImageStyle,
  PptxAspectRatio,
  PptxLanguage,
  PptxStylePreset,
  PromptThinkingSettings,
  ThinkingEffort,
} from "./types";

export const notionAgentToolNames = [
  AGENT_TOOL_NAMES.searchNotionPages,
  AGENT_TOOL_NAMES.readNotionPage,
  AGENT_TOOL_NAMES.createNotionPage,
  AGENT_TOOL_NAMES.appendNotionPage,
  AGENT_TOOL_NAMES.updateNotionPage,
  AGENT_TOOL_NAMES.deleteNotionPage,
  AGENT_TOOL_NAMES.saveArtifactToNotion,
  AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
] as const;

export function buildChatToolsRequest(input: {
  imageExecution?: Record<string, unknown> | null;
  invokedSkillIds?: string[];
  skillIds?: string[];
  searchEnabled?: boolean;
  tools?: ChatToolsSelection;
}) {
  const generateImage = input.tools?.[AGENT_TOOL_NAMES.generateImage];
  const generateImageWithExecution = input.imageExecution
    ? {
        ...(generateImage ?? {}),
        enabled: generateImage?.enabled ?? true,
        execution: input.imageExecution,
      }
    : generateImage;

  return {
    skillIds: input.skillIds ?? [],
    ...(input.invokedSkillIds?.length
      ? { invokedSkillIds: input.invokedSkillIds }
      : {}),
    [AGENT_TOOL_NAMES.webSearch]: {
      enabled: input.searchEnabled === true,
    },
    ...(generateImageWithExecution
      ? { [AGENT_TOOL_NAMES.generateImage]: generateImageWithExecution }
      : {}),
    ...(input.tools?.[AGENT_TOOL_NAMES.generatePptx]
      ? {
          [AGENT_TOOL_NAMES.generatePptx]:
            input.tools[AGENT_TOOL_NAMES.generatePptx],
        }
      : {}),
    ...(input.tools?.[AGENT_TOOL_NAMES.generateVideoPresentation]
      ? {
          [AGENT_TOOL_NAMES.generateVideoPresentation]:
            input.tools[AGENT_TOOL_NAMES.generateVideoPresentation],
        }
      : {}),
    ...Object.fromEntries(
      notionAgentToolNames.flatMap((toolName) => {
        const selection = input.tools?.[toolName];
        return selection ? [[toolName, selection] as const] : [];
      }),
    ),
    ...(input.tools?.mcp ? { mcp: input.tools.mcp } : {}),
  };
}

export const thinkingEffortOptions: Array<{
  value: ThinkingEffort;
  label: string;
}> = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Standard" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

export const imageAspectRatioOptions: Array<{
  value: ImageAspectRatio;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "1:1", label: "1:1" },
  { value: "2:3", label: "2:3" },
  { value: "3:2", label: "3:2" },
  { value: "3:4", label: "3:4" },
  { value: "4:3", label: "4:3" },
  { value: "4:5", label: "4:5" },
  { value: "5:4", label: "5:4" },
  { value: "9:16", label: "9:16" },
  { value: "16:9", label: "16:9" },
  { value: "21:9", label: "21:9" },
  { value: "1:4", label: "1:4" },
  { value: "4:1", label: "4:1" },
  { value: "1:8", label: "1:8" },
  { value: "8:1", label: "8:1" },
];

export const imageQualityOptions: Array<{
  value: ImageQuality;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "standard", label: "Standard" },
  { value: "higher", label: "Higher" },
  { value: "highest", label: "Highest" },
];

export const imageStyleOptions: Array<{ value: ImageStyle; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "ghibli", label: "Ghibli" },
  { value: "pixar", label: "Pixar" },
  { value: "cartoon", label: "Cartoon" },
  { value: "pixel", label: "Pixel" },
];

export const pptxStylePresetOptions: Array<{
  value: PptxStylePreset;
  label: string;
  description: string;
}> = [
  {
    value: "executive",
    label: "Executive",
    description: "Quiet strategy deck with crisp claims and restrained color.",
  },
  {
    value: "technical",
    label: "Technical",
    description: "System diagrams, dense labels, and precise structure.",
  },
  {
    value: "editorial",
    label: "Editorial",
    description: "Narrative pacing, bold typography, and image-led moments.",
  },
  {
    value: "data-heavy",
    label: "Data-heavy",
    description: "Tables, charts, KPI grids, and appendix-ready layouts.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Let the agent infer a bespoke visual direction.",
  },
];

export const pptxAspectRatioOptions: Array<{
  value: PptxAspectRatio;
  label: string;
}> = [
  { value: "16:9", label: "16:9" },
  { value: "16:10", label: "16:10" },
  { value: "4:3", label: "4:3" },
];

export const pptxLanguageOptions: Array<{
  value: PptxLanguage;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

function optionLabel<T extends string>(
  options: Array<{ value: T; label: string }>,
  value: T,
) {
  return options.find((option) => option.value === value)?.label ?? value;
}

export function imageConfigSummary(config: ChatImageArtifactConfig) {
  const parts = [
    config.aspectRatio !== "auto"
      ? optionLabel(imageAspectRatioOptions, config.aspectRatio)
      : null,
    config.quality !== "auto"
      ? optionLabel(imageQualityOptions, config.quality)
      : null,
    config.style !== "auto"
      ? optionLabel(imageStyleOptions, config.style)
      : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" · ") : "Auto";
}

export function pptxConfigSummary(config: ChatPptxArtifactConfig) {
  const mode =
    config.generationMode === "editable_native"
      ? "Editable PowerPoint"
      : "Visual deck";
  const style =
    pptxStylePresetOptions.find(
      (option) => option.value === config.design.stylePreset,
    )?.label ?? config.design.stylePreset;
  return [
    mode,
    style,
    config.design.aspectRatio,
    config.design.language !== "auto"
      ? optionLabel(pptxLanguageOptions, config.design.language)
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

export const DEFAULT_PROMPT_THINKING_SETTINGS: PromptThinkingSettings = {
  mode: "auto",
  effort: "medium",
};

export const DEFAULT_IMAGE_ARTIFACT_CONFIG: ChatImageArtifactConfig = {
  aspectRatio: "auto",
  quality: "auto",
  style: "auto",
};

export const DEFAULT_PPTX_ARTIFACT_CONFIG: ChatPptxArtifactConfig = {
  generationMode: "visual_html",
  design: {
    aspectRatio: "16:9",
    language: "auto",
    stylePreset: "custom",
  },
  output: {
    includeSourceJson: false,
  },
  rendering: {
    preferHtmlTables: true,
  },
};

export function skillSupportsImageGeneration(skill: ChatSkillItem) {
  return (
    skill.tools?.some(
      (toolName) =>
        isSkillActivatedAgentTool(toolName) &&
        isGeneratedImageArtifactToolName(toolName),
    ) === true
  );
}

export function skillSupportsPptxGeneration(skill: ChatSkillItem) {
  return (
    skill.tools?.some(
      (toolName) =>
        isSkillActivatedAgentTool(toolName) &&
        isPresentationArtifactToolName(toolName),
    ) === true
  );
}

export function skillSupportsVideoPresentationGeneration(skill: ChatSkillItem) {
  return (
    skill.tools?.some(
      (toolName) =>
        isSkillActivatedAgentTool(toolName) &&
        isVideoPresentationArtifactToolName(toolName),
    ) === true
  );
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function skillImageDefaultConfig(skill: ChatSkillItem) {
  const defaultConfig = readRecord(skill.defaultConfig);
  if (!defaultConfig) {
    return null;
  }
  return readRecord(defaultConfig[AGENT_TOOL_NAMES.generateImage]);
}

function normalizeSkillImageConfig(input: unknown) {
  const record = readRecord(input);
  if (!record) {
    return null;
  }
  const config: Partial<ChatImageArtifactConfig> = {};
  if (
    typeof record.aspectRatio === "string" &&
    imageAspectRatioOptions.some(
      (option) => option.value === record.aspectRatio,
    )
  ) {
    config.aspectRatio = record.aspectRatio as ImageAspectRatio;
  }
  if (
    typeof record.quality === "string" &&
    imageQualityOptions.some((option) => option.value === record.quality)
  ) {
    config.quality = record.quality as ImageQuality;
  }
  if (
    typeof record.style === "string" &&
    imageStyleOptions.some((option) => option.value === record.style)
  ) {
    config.style = record.style as ImageStyle;
  }
  return Object.keys(config).length > 0 ? config : null;
}

export function imageConfigFromSkills(skills: ChatSkillItem[]) {
  let skillConfig: Partial<ChatImageArtifactConfig> | null = null;
  for (const skill of skills) {
    if (!skillSupportsImageGeneration(skill)) {
      continue;
    }
    const config = normalizeSkillImageConfig(skillImageDefaultConfig(skill));
    if (config) {
      skillConfig = {
        ...config,
        ...(skillConfig ?? {}),
      };
    }
  }
  return {
    ...DEFAULT_IMAGE_ARTIFACT_CONFIG,
    ...(skillConfig ?? {}),
  };
}

export function imageModelAliasFromSkills(skills: ChatSkillItem[]) {
  return (
    skills.find(
      (skill) => skillSupportsImageGeneration(skill) && skill.models?.image,
    )?.models?.image ?? null
  );
}

export function clampImageConfigToCapabilities(input: {
  config: ChatImageArtifactConfig;
  capabilities?: ImageModelCapabilities;
}): ChatImageArtifactConfig {
  const aspectRatios =
    input.capabilities?.controls?.aspectRatio?.values ??
    imageAspectRatioOptions.map((option) => option.value);
  const qualities =
    input.capabilities?.controls?.quality?.values ??
    imageQualityOptions.map((option) => option.value);
  const styles =
    input.capabilities?.controls?.style?.values ??
    imageStyleOptions.map((option) => option.value);

  return {
    aspectRatio: aspectRatios.includes(input.config.aspectRatio)
      ? input.config.aspectRatio
      : "auto",
    quality: qualities.includes(input.config.quality)
      ? input.config.quality
      : "auto",
    style: styles.includes(input.config.style) ? input.config.style : "auto",
  };
}

function buildGenerateImageToolSelection(input: {
  available: boolean;
  selectedSkills: ChatSkillItem[];
  config: ChatImageArtifactConfig;
  modelAlias?: string | null;
  enabled: boolean;
}): ChatGenerateImageToolSelection | undefined {
  if (!input.enabled) {
    return { enabled: false };
  }

  if (!input.available) {
    return undefined;
  }

  const hasConfig =
    input.config.aspectRatio !== "auto" ||
    input.config.quality !== "auto" ||
    input.config.style !== "auto";

  const skillTriggered = input.selectedSkills.some(
    skillSupportsImageGeneration,
  );
  if (!hasConfig && !input.modelAlias && !skillTriggered) {
    return undefined;
  }

  return {
    ...(input.modelAlias ? { modelAlias: input.modelAlias } : {}),
    ...(hasConfig ? { config: input.config } : {}),
  };
}

function buildGeneratePptxToolSelection(input: {
  config: ChatPptxArtifactConfig;
  enabled: boolean;
  selectedSkills: ChatSkillItem[];
}): ChatGeneratePptxToolSelection | undefined {
  if (!input.enabled) {
    return { enabled: false };
  }

  const skillTriggered = input.selectedSkills.some(skillSupportsPptxGeneration);
  const hasCustomGenerationMode =
    input.config.generationMode !== DEFAULT_PPTX_ARTIFACT_CONFIG.generationMode;
  const hasCustomDesign =
    input.config.design.aspectRatio !==
      DEFAULT_PPTX_ARTIFACT_CONFIG.design.aspectRatio ||
    input.config.design.language !==
      DEFAULT_PPTX_ARTIFACT_CONFIG.design.language ||
    input.config.design.stylePreset !==
      DEFAULT_PPTX_ARTIFACT_CONFIG.design.stylePreset;
  const supportedOutput: ChatPptxArtifactConfig["output"] = {
    includeSourceJson: input.config.output.includeSourceJson,
  };
  const hasCustomOutput =
    supportedOutput.includeSourceJson !==
    DEFAULT_PPTX_ARTIFACT_CONFIG.output.includeSourceJson;
  const hasCustomRendering =
    input.config.rendering.preferHtmlTables !==
    DEFAULT_PPTX_ARTIFACT_CONFIG.rendering.preferHtmlTables;

  if (
    !skillTriggered &&
    !hasCustomGenerationMode &&
    !hasCustomDesign &&
    !hasCustomOutput &&
    !hasCustomRendering
  ) {
    return undefined;
  }

  return {
    enabled: true,
    ...(hasCustomGenerationMode || skillTriggered
      ? { generationMode: input.config.generationMode }
      : {}),
    ...(hasCustomDesign || skillTriggered
      ? { design: input.config.design }
      : {}),
    ...(hasCustomOutput ? { output: supportedOutput } : {}),
    ...(hasCustomRendering || skillTriggered
      ? { rendering: input.config.rendering }
      : {}),
  };
}

function buildGenerateVideoPresentationToolSelection(input: {
  enabled: boolean;
  narrationEnabled: boolean;
  selectedSkills: ChatSkillItem[];
  userConfigured?: boolean;
}): ChatGenerateVideoPresentationToolSelection | undefined {
  if (!input.enabled) {
    return { enabled: false };
  }

  const hasCustomNarration = input.narrationEnabled !== true;
  return input.userConfigured ||
    hasCustomNarration ||
    input.selectedSkills.some(skillSupportsVideoPresentationGeneration)
    ? {
        enabled: true,
        ...(hasCustomNarration
          ? { narration: { enabled: input.narrationEnabled } }
          : {}),
      }
    : undefined;
}

export function buildComposerToolsSelection(input: {
  imageGenerationEnabled: boolean;
  imageSupported: boolean;
  pptxConfig: ChatPptxArtifactConfig;
  pptxGenerationEnabled?: boolean;
  videoPresentationGenerationEnabled?: boolean;
  videoPresentationNarrationEnabled?: boolean;
  videoPresentationUserConfigured?: boolean;
  notionConnectorId?: string | null;
  notionToolsEnabled?: boolean;
  selectedSkills: ChatSkillItem[];
  imageConfig: ChatImageArtifactConfig;
  imageModelAlias?: string | null;
}): ChatToolsSelection | undefined {
  const tools: ChatToolsSelection = {};
  const generateImage = buildGenerateImageToolSelection({
    available: input.imageSupported,
    selectedSkills: input.selectedSkills,
    config: input.imageConfig,
    modelAlias: input.imageModelAlias,
    enabled: input.imageGenerationEnabled,
  });

  if (generateImage) {
    tools[AGENT_TOOL_NAMES.generateImage] = generateImage;
  }

  if (input.pptxGenerationEnabled !== undefined) {
    const generatePptx = buildGeneratePptxToolSelection({
      config: input.pptxConfig,
      enabled: input.pptxGenerationEnabled,
      selectedSkills: input.selectedSkills,
    });
    if (generatePptx) {
      tools[AGENT_TOOL_NAMES.generatePptx] = generatePptx;
    }
  }

  if (input.videoPresentationGenerationEnabled !== undefined) {
    const generateVideoPresentation =
      buildGenerateVideoPresentationToolSelection({
        enabled: input.videoPresentationGenerationEnabled,
        narrationEnabled: input.videoPresentationNarrationEnabled ?? true,
        selectedSkills: input.selectedSkills,
        userConfigured: input.videoPresentationUserConfigured,
      });
    if (generateVideoPresentation) {
      tools[AGENT_TOOL_NAMES.generateVideoPresentation] =
        generateVideoPresentation;
    }
  }

  if (input.notionConnectorId && input.notionToolsEnabled !== undefined) {
    for (const toolName of notionAgentToolNames) {
      tools[toolName] = {
        connectorId: input.notionConnectorId,
        enabled: input.notionToolsEnabled,
      };
    }
  }

  return Object.keys(tools).length > 0 ? tools : undefined;
}

export function skillSupportsNotion(skill: ChatSkillItem) {
  return (
    skill.tools?.some(
      (toolName) =>
        isSkillActivatedAgentTool(toolName) && isNotionToolName(toolName),
    ) === true
  );
}
