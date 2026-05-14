import type { EnabledSkillDescriptor } from "../skills/types";
import type { ThreadModelSettings } from "../threads/model-settings";
import { resolveModelGatewayProfile } from "../../../shared/model-gateway/client";
import type { RuntimeModelGatewayProfile } from "../../../shared/model-gateway/types";
import {
  AGENT_TOOL_NAMES,
  isAgentToolEnabledByDefault,
  isGeneratedImageArtifactToolName,
  isSkillActivatedAgentTool,
} from "../agent/tool-registry";
import { resolveImageModelCapabilities } from "./image-capabilities";
import {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  mergeImageArtifactConfig,
  normalizeArtifactToolSelection,
  normalizeGenerateImageToolSelection,
  normalizePartialArtifactImageConfig,
  type ArtifactImageConfig,
  type ArtifactIntentDecision,
  type ArtifactToolSelection,
  type GenerateImageToolSelection,
  type ImageModelCapabilities,
} from "./types";

export type ResolvedArtifactImageProfile = {
  profile: RuntimeModelGatewayProfile;
  capabilities: ImageModelCapabilities;
};

export type ArtifactIntentPipelineResult = {
  decision: ArtifactIntentDecision;
  imageProfile: ResolvedArtifactImageProfile | null;
};

type ResolveImageProfile = (input: {
  threadModelSettings: ThreadModelSettings;
  explicit: boolean;
  hasByokExecution?: boolean;
  byokExecution?: GenerateImageToolSelection["execution"];
  requestedModelAlias?: string | null;
}) => Promise<ResolvedArtifactImageProfile | null>;

function skillHasImageCapability(skill: EnabledSkillDescriptor) {
  return skill.tools?.some(
    (toolName) =>
      isSkillActivatedAgentTool(toolName) &&
      isGeneratedImageArtifactToolName(toolName),
  ) === true;
}

function defaultConfigFromSkills(skills: EnabledSkillDescriptor[]) {
  return skills.reduce<Partial<ArtifactImageConfig> | undefined>(
    (current, skill) => {
      if (!skillHasImageCapability(skill)) {
        return current;
      }
      const toolConfig =
        skill.defaultConfig?.[AGENT_TOOL_NAMES.generateImage] &&
        typeof skill.defaultConfig[AGENT_TOOL_NAMES.generateImage] === "object" &&
        !Array.isArray(skill.defaultConfig[AGENT_TOOL_NAMES.generateImage])
          ? skill.defaultConfig[AGENT_TOOL_NAMES.generateImage]
          : undefined;
      const normalized = normalizePartialArtifactImageConfig(toolConfig);
      if (!normalized) {
        return current;
      }
      return {
        ...normalized,
        ...(current ?? {}),
      };
    },
    undefined,
  );
}

function modelAliasFromSkills(skills: EnabledSkillDescriptor[]) {
  return (
    skills.find(
      (skill) => skillHasImageCapability(skill) && skill.models?.image,
    )?.models?.image ?? null
  );
}

function clampConfigToCapabilities(input: {
  config: ArtifactImageConfig;
  capabilities?: ImageModelCapabilities | null;
}) {
  const { capabilities, config } = input;
  if (!capabilities?.supported) {
    return {
      ...DEFAULT_IMAGE_ARTIFACT_CONFIG,
      style: config.style,
    };
  }

  const aspectRatioValues = capabilities.controls.aspectRatio?.values ?? ["auto"];
  const qualityValues = capabilities.controls.quality?.values ?? ["auto"];
  const styleValues = capabilities.controls.style?.values ?? ["auto"];

  return {
    aspectRatio: aspectRatioValues.includes(config.aspectRatio)
      ? config.aspectRatio
      : "auto",
    quality: qualityValues.includes(config.quality) ? config.quality : "auto",
    style: styleValues.includes(config.style) ? config.style : "auto",
  };
}

async function resolveImageProfile(input: {
  threadModelSettings: ThreadModelSettings;
  explicit: boolean;
  hasByokExecution?: boolean;
  byokExecution?: GenerateImageToolSelection["execution"];
  requestedModelAlias?: string | null;
}): Promise<ResolvedArtifactImageProfile | null> {
  let profile = await resolveModelGatewayProfile({
    kind: "image",
    requestedProfileAlias:
      input.requestedModelAlias || input.hasByokExecution
        ? undefined
        : input.threadModelSettings.imageProfileAlias,
    requestedModelAlias: input.hasByokExecution
      ? undefined
      : input.requestedModelAlias,
    defaultRequired: input.explicit && !input.hasByokExecution,
  });
  if (!profile && input.hasByokExecution) {
    profile = await resolveModelGatewayProfile({
      kind: "image",
      requestedProfileAlias: input.threadModelSettings.imageProfileAlias,
      defaultRequired: false,
    });
  }
  if (!profile && input.hasByokExecution && input.byokExecution) {
    const now = new Date().toISOString();
    const modelAlias =
      input.byokExecution.modelAlias ??
      input.byokExecution.providerModel ??
      input.byokExecution.byokModelId ??
      "byok-image";
    const profileAlias = `byok:image:${input.byokExecution.byokModelId ?? modelAlias}`;
    const providerKind = input.byokExecution.providerHint ?? undefined;
    profile = {
      id: `byok:image:${profileAlias}`,
      kind: "image",
      gatewayConfigId: "",
      profileAlias,
      modelAlias,
      requestedDimensions: null,
      vectorStrategy: "auto",
      isDefault: false,
      isActive: true,
      configJson: {
        ...(providerKind ? { providerKind } : {}),
        targetModel: modelAlias,
      },
      createdAt: now,
      updatedAt: now,
    };
  }
  if (!profile) {
    return null;
  }

  return {
    profile,
    capabilities: resolveImageModelCapabilities({
      profile,
      modelId: profile.modelAlias,
    }),
  };
}

export async function runArtifactIntentPipeline(input: {
  tools?: {
    artifact?: ArtifactToolSelection;
    [AGENT_TOOL_NAMES.generateImage]?: GenerateImageToolSelection;
  };
  enabledSkills: EnabledSkillDescriptor[];
  threadModelSettings: ThreadModelSettings;
  resolveImageProfile?: ResolveImageProfile;
}): Promise<ArtifactIntentPipelineResult> {
  const legacySelection = normalizeArtifactToolSelection(input.tools?.artifact);
  const generateImageSelection = normalizeGenerateImageToolSelection(
    input.tools?.[AGENT_TOOL_NAMES.generateImage],
  );
  const explicit =
    Boolean(generateImageSelection) || legacySelection?.kind === "image";
  const disabled = generateImageSelection?.enabled === false;
  const requestedImageModelAlias =
    generateImageSelection?.modelAlias ??
    legacySelection?.modelAlias ??
    modelAliasFromSkills(input.enabledSkills);
  const skillTriggered = input.enabledSkills.some(skillHasImageCapability);
  const shouldInjectTool =
    !disabled &&
    (explicit ||
      skillTriggered ||
      isAgentToolEnabledByDefault(AGENT_TOOL_NAMES.generateImage));
  const source = disabled
    ? "none"
    : explicit
      ? "explicit_tool"
      : skillTriggered
        ? "skill"
        : "none";

  const imageProfile = shouldInjectTool
    ? await (input.resolveImageProfile ?? resolveImageProfile)({
        threadModelSettings: input.threadModelSettings,
        explicit,
        hasByokExecution: Boolean(generateImageSelection?.execution),
        byokExecution: generateImageSelection?.execution,
        requestedModelAlias: requestedImageModelAlias,
      })
    : null;
  const skillConfig = defaultConfigFromSkills(input.enabledSkills);
  const requestedConfig =
    generateImageSelection?.config ?? legacySelection?.image;
  const rawConfig = mergeImageArtifactConfig(skillConfig, requestedConfig);
  const config = clampConfigToCapabilities({
    config: rawConfig,
    capabilities: imageProfile?.capabilities,
  });

  const warnings: string[] = [];
  if (shouldInjectTool && !imageProfile) {
    warnings.push("image_model_unavailable");
  } else if (imageProfile && !imageProfile.capabilities.supported) {
    warnings.push("image_provider_unsupported");
  }
  if (rawConfig.aspectRatio !== config.aspectRatio) {
    warnings.push("image_aspect_ratio_unsupported");
  }
  if (rawConfig.quality !== config.quality) {
    warnings.push("image_quality_unsupported");
  }
  if (rawConfig.style !== config.style) {
    warnings.push("image_style_unsupported");
  }

  const enabled =
    shouldInjectTool &&
    Boolean(imageProfile) &&
    imageProfile?.capabilities.supported !== false;

  return {
    decision: {
      kind: enabled ? "image" : shouldInjectTool ? "image" : null,
      shouldInjectTool: enabled,
      source,
      confidence: disabled
        ? 0
        : explicit
          ? 0.55
          : skillTriggered
            ? 0.82
            : 0,
      reason:
        disabled
          ? `The ${AGENT_TOOL_NAMES.generateImage} tool is disabled for this turn.`
          : source === "explicit_tool"
            ? `User-facing image generation controls configured ${AGENT_TOOL_NAMES.generateImage}.`
          : source === "skill"
            ? `A selected skill declares ${AGENT_TOOL_NAMES.generateImage}.`
            : `${AGENT_TOOL_NAMES.generateImage} is available for this turn when the model decides a visual artifact is needed.`,
      config,
      warnings,
    },
    imageProfile,
  };
}
