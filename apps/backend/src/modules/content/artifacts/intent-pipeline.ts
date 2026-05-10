import type { EnabledSkillDescriptor } from "../skills/types";
import type { ThreadModelSettings } from "../threads/model-settings";
import { resolveModelGatewayProfile } from "../../../shared/model-gateway/client";
import type { RuntimeModelGatewayProfile } from "../../../shared/model-gateway/types";
import { resolveImageModelCapabilities } from "./image-capabilities";
import {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  mergeImageArtifactConfig,
  normalizeArtifactToolSelection,
  normalizePartialArtifactImageConfig,
  type ArtifactImageConfig,
  type ArtifactIntentDecision,
  type ArtifactToolSelection,
  type ImageModelCapabilities,
} from "./types";

const IMAGE_INTENT_PATTERNS = [
  /\b(generate|create|make|draw|render|design)\s+(an?\s+)?(image|picture|illustration|poster|logo|icon|thumbnail|cover|banner)\b/i,
  /\b(image|picture|illustration|poster|logo|icon|thumbnail|cover|banner)\s+(generation|生成|创作|制作)\b/i,
  /(生成|创建|画|绘制|做)(一张|一个|图片|图像|插画|海报|logo|封面|缩略图)/i,
  /(生图|出图|文生图|生成图片|生成图像)/i,
];

const IMAGE_CAPABILITIES = new Set([
  "artifacts.image.generate",
  "image.generate",
  "generate_image",
]);

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
  requestedModelAlias?: string | null;
}) => Promise<ResolvedArtifactImageProfile | null>;

function skillHasImageCapability(skill: EnabledSkillDescriptor) {
  if (skill.tools?.includes("generate_image")) {
    return true;
  }
  const capabilities = [
    ...(skill.capabilities?.required ?? []),
    ...(skill.capabilities?.optional ?? []),
  ];
  if (capabilities.some((capability) => IMAGE_CAPABILITIES.has(capability))) {
    return true;
  }

  const searchable = `${skill.name} ${skill.description}`.toLowerCase();
  return (
    /\b(image generation|generate image|image generator|picture generation)\b/.test(
      searchable,
    ) || /\b(illustration|poster|logo|thumbnail|cover|banner)\b/.test(searchable)
  );
}

function defaultConfigFromSkills(skills: EnabledSkillDescriptor[]) {
  return skills.reduce<Partial<ArtifactImageConfig> | undefined>(
    (current, skill) => {
      if (!skillHasImageCapability(skill)) {
        return current;
      }
      const toolConfig =
        skill.defaultConfig?.generate_image &&
        typeof skill.defaultConfig.generate_image === "object" &&
        !Array.isArray(skill.defaultConfig.generate_image)
          ? skill.defaultConfig.generate_image
          : undefined;
      const artifactConfig =
        skill.defaultConfig?.artifact &&
        typeof skill.defaultConfig.artifact === "object" &&
        !Array.isArray(skill.defaultConfig.artifact)
          ? (skill.defaultConfig.artifact as Record<string, unknown>)
          : null;
      const imageConfig =
        toolConfig ??
        artifactConfig?.image ??
        skill.defaultConfig?.image ??
        undefined;
      const normalized = normalizePartialArtifactImageConfig(imageConfig);
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
  return skills.find((skill) => skill.models?.image)?.models?.image ?? null;
}

function detectImageIntent(content: string) {
  const normalized = content.trim();
  if (!normalized) {
    return false;
  }
  return IMAGE_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
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
  requestedModelAlias?: string | null;
}): Promise<ResolvedArtifactImageProfile | null> {
  const profile = await resolveModelGatewayProfile({
    kind: "image",
    requestedProfileAlias: input.requestedModelAlias
      ? undefined
      : input.threadModelSettings.imageProfileAlias,
    requestedModelAlias: input.requestedModelAlias,
    defaultRequired: input.explicit,
  });
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
  content: string;
  tools?: { artifact?: ArtifactToolSelection };
  enabledSkills: EnabledSkillDescriptor[];
  threadModelSettings: ThreadModelSettings;
  resolveImageProfile?: ResolveImageProfile;
}): Promise<ArtifactIntentPipelineResult> {
  const explicitSelection = normalizeArtifactToolSelection(input.tools?.artifact);
  const explicit = explicitSelection?.kind === "image";
  const forceGenerate = explicit && explicitSelection.mode === "generate";
  const requestedImageModelAlias =
    explicitSelection?.modelAlias ?? modelAliasFromSkills(input.enabledSkills);
  const skillTriggered = input.enabledSkills.some(skillHasImageCapability);
  const intentTriggered = detectImageIntent(input.content);
  const shouldInjectTool = explicit || skillTriggered || intentTriggered;
  const source = explicit
    ? "explicit_tool"
    : skillTriggered
      ? "skill"
      : intentTriggered
        ? "intent"
        : "none";

  const imageProfile = shouldInjectTool
    ? await (input.resolveImageProfile ?? resolveImageProfile)({
        threadModelSettings: input.threadModelSettings,
        explicit,
        requestedModelAlias: requestedImageModelAlias,
      })
    : null;
  const skillConfig = defaultConfigFromSkills(input.enabledSkills);
  const requestedConfig = explicitSelection?.image;
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
      requireToolCall: forceGenerate,
      confidence: forceGenerate
        ? 1
        : explicit
          ? 0.55
          : skillTriggered
            ? 0.82
            : intentTriggered
              ? 0.72
              : 0,
      reason:
        source === "explicit_tool" && forceGenerate
          ? "User-facing artifact controls requested image generation."
          : source === "explicit_tool"
            ? "User-facing artifact controls enabled image generation tool auto mode."
          : source === "skill"
            ? "A selected skill declares or implies image generation."
            : source === "intent"
              ? "The prompt matches image generation intent."
              : "No artifact generation intent detected.",
      config,
      warnings,
    },
    imageProfile,
  };
}
