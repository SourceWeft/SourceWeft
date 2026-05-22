import {
  AGENT_TOOL_NAMES,
  isGeneratedImageArtifactToolName,
  isNotionToolName,
  isSkillActivatedAgentTool,
} from "@sourceweft/sdk";
import type {
  ChatGenerateImageToolSelection,
  ChatImageArtifactConfig,
  ChatSkillItem,
  ChatToolsSelection,
  ImageAspectRatio,
  ImageModelCapabilities,
  ImageQuality,
  ImageStyle,
  PromptThinkingSettings,
  ThinkingEffort,
} from "./types";

export const notionAgentToolNames = [
  AGENT_TOOL_NAMES.searchNotionPages,
  AGENT_TOOL_NAMES.createNotionPage,
  AGENT_TOOL_NAMES.appendNotionPage,
  AGENT_TOOL_NAMES.updateNotionPageByTitle,
  AGENT_TOOL_NAMES.deleteNotionPageByTitle,
  AGENT_TOOL_NAMES.saveArtifactToNotion,
  AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
] as const;

export function buildChatToolsRequest(input: {
  imageExecution?: Record<string, unknown> | null;
  invokedSkillIds?: string[];
  skillIds?: string[];
  searchEnabled?: boolean;
  tools?: ChatToolsSelection;
  forceImageGenerate?: boolean;
}) {
  const generateImage = input.tools?.[AGENT_TOOL_NAMES.generateImage];
  const generateImageWithMode = input.forceImageGenerate
    ? {
        ...(generateImage ?? {}),
        enabled: generateImage?.enabled ?? true,
        mode: "generate" as const,
      }
    : generateImage;
  const generateImageWithExecution = input.imageExecution
    ? {
        ...(generateImageWithMode ?? {}),
        enabled: generateImageWithMode?.enabled ?? true,
        execution: input.imageExecution,
      }
    : generateImageWithMode;

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
    ...Object.fromEntries(
      notionAgentToolNames.flatMap((toolName) => {
        const selection = input.tools?.[toolName];
        return selection ? [[toolName, selection] as const] : [];
      }),
    ),
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

export const DEFAULT_PROMPT_THINKING_SETTINGS: PromptThinkingSettings = {
  mode: "auto",
  effort: "medium",
};

export const DEFAULT_IMAGE_ARTIFACT_CONFIG: ChatImageArtifactConfig = {
  aspectRatio: "auto",
  quality: "auto",
  style: "auto",
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

export function buildComposerToolsSelection(input: {
  imageGenerationEnabled: boolean;
  imageSupported: boolean;
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
