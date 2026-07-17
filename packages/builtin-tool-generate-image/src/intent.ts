import {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  GENERATE_IMAGE_TOOL_ID,
  type ArtifactImageConfig,
  type ArtifactIntentDecision,
  type GenerateImageToolSelection,
  type ImageModelCapabilities,
} from "./image-types";
import {
  mergeImageArtifactConfig,
  normalizeArtifactImageConfig,
  normalizeGenerateImageToolSelection,
  normalizePartialArtifactImageConfig,
} from "./image-config";

export type GenerateImageEnabledSkillDescriptor = {
  readonly tools?: readonly string[];
  readonly models?: {
    readonly image?: string | null;
  };
  readonly defaultConfig?: Readonly<Record<string, unknown>>;
};

export type ResolvedGenerateImageProfile<TProfile> = {
  readonly profile: TProfile;
  readonly capabilities: ImageModelCapabilities;
};

export type GenerateImageProfileRequest<TContext> = {
  readonly context?: TContext;
  readonly explicit: boolean;
  readonly hasByokExecution?: boolean;
  readonly byokExecution?: GenerateImageToolSelection["execution"];
  readonly requestedModelAlias?: string | null;
};

export type GenerateImageIntentDecisionResult<TProfile> = {
  readonly decision: ArtifactIntentDecision;
  readonly imageProfile: ResolvedGenerateImageProfile<TProfile> | null;
};

export type GenerateImageIntentDecisionInput<TContext, TProfile> = {
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly enabledSkills: readonly GenerateImageEnabledSkillDescriptor[];
  readonly profileContext?: TContext;
  readonly defaultToolEnabled?: boolean;
  readonly toolName?: string;
  readonly resolveImageProfile?: (
    request: GenerateImageProfileRequest<TContext>,
  ) => Promise<ResolvedGenerateImageProfile<TProfile> | null>;
};

function skillHasImageCapability(
  skill: GenerateImageEnabledSkillDescriptor,
  toolName: string,
) {
  return skill.tools?.includes(toolName) === true;
}

function defaultConfigFromSkills(
  skills: readonly GenerateImageEnabledSkillDescriptor[],
  toolName: string,
) {
  return skills.reduce<Partial<ArtifactImageConfig> | undefined>(
    (current, skill) => {
      if (!skillHasImageCapability(skill, toolName)) {
        return current;
      }
      const normalized = normalizePartialArtifactImageConfig(
        skill.defaultConfig?.[toolName],
      );
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

function modelAliasFromSkills(
  skills: readonly GenerateImageEnabledSkillDescriptor[],
  toolName: string,
) {
  return (
    skills.find((skill) => skillHasImageCapability(skill, toolName))?.models
      ?.image ?? null
  );
}

function clampConfigToCapabilities(input: {
  readonly config: ArtifactImageConfig;
  readonly capabilities?: ImageModelCapabilities | null;
}): ArtifactImageConfig {
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

export async function resolveGenerateImageIntentDecision<TContext = unknown, TProfile = unknown>(
  input: GenerateImageIntentDecisionInput<TContext, TProfile>,
): Promise<GenerateImageIntentDecisionResult<TProfile>> {
  const toolName = input.toolName ?? GENERATE_IMAGE_TOOL_ID;
  const generateImageSelection = normalizeGenerateImageToolSelection(
    input.tools?.[toolName],
  );
  const explicit = Boolean(generateImageSelection);
  const disabled = generateImageSelection?.enabled === false;
  const requestedImageModelAlias =
    generateImageSelection?.modelAlias ??
    modelAliasFromSkills(input.enabledSkills, toolName);
  const skillTriggered = input.enabledSkills.some((skill) =>
    skillHasImageCapability(skill, toolName),
  );
  const shouldInjectTool =
    !disabled &&
    (explicit || skillTriggered || input.defaultToolEnabled === true);
  const source = disabled
    ? "none"
    : explicit
      ? "explicit_tool"
      : skillTriggered
        ? "skill"
        : "none";
  const imageProfile =
    shouldInjectTool && input.resolveImageProfile
      ? await input.resolveImageProfile({
          context: input.profileContext,
          explicit,
          hasByokExecution: Boolean(generateImageSelection?.execution),
          byokExecution: generateImageSelection?.execution,
          requestedModelAlias: requestedImageModelAlias,
        })
      : null;
  const skillConfig = defaultConfigFromSkills(input.enabledSkills, toolName);
  const requestedConfig = generateImageSelection?.config;
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
      confidence: disabled ? 0 : explicit ? 0.55 : skillTriggered ? 0.82 : 0,
      reason: disabled
        ? `The ${toolName} tool is disabled for this turn.`
        : source === "explicit_tool"
          ? `User-facing image generation controls configured ${toolName}.`
          : source === "skill"
            ? `A selected skill declares ${toolName}.`
            : `${toolName} is available for this turn when the model decides a visual artifact is needed.`,
      config,
      warnings,
    },
    imageProfile,
  };
}
