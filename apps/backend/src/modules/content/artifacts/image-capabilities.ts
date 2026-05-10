import type {
  ImageAspectRatio,
  ImageQuality,
  ImageStyle,
} from "@sourceweft/model-gateway";
import type { RuntimeModelGatewayProfile } from "../../../shared/model-gateway/types";
import type { ImageModelCapabilities } from "./types";

const ASPECT_RATIOS = [
  "auto",
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;
const QUALITIES = ["auto", "low", "standard", "higher", "highest"] as const;
const GEMINI_31_EXTENDED_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
  "1:4",
  "4:1",
  "1:8",
  "8:1",
] as const;
const STYLES = ["auto", "ghibli", "pixar", "cartoon", "pixel"] as const;
const GENERIC_IMAGE_PROVIDER_KINDS = new Set([
  "openai",
  "openai-compatible",
  "azure-openai",
  "siliconflow-cn",
]);

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function readProviderKind(configJson: Record<string, unknown>) {
  const direct = configJson.providerKind ?? configJson.provider_kind;
  return typeof direct === "string" ? direct.trim().toLowerCase() : null;
}

function normalizeModelId(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function isGemini31FlashImagePreview(modelId: string | null | undefined) {
  return normalizeModelId(modelId) === "google/gemini-3.1-flash-image-preview";
}

function isGeminiImageModel(modelId: string | null | undefined) {
  return normalizeModelId(modelId).startsWith("google/gemini-");
}

function resolveQualityValues(input: {
  modelId: string | null | undefined;
}) {
  if (isGemini31FlashImagePreview(input.modelId)) {
    return [...QUALITIES];
  }
  if (isGeminiImageModel(input.modelId)) {
    return ["auto", "standard", "higher", "highest"] as const;
  }
  return ["auto"] as const;
}

function resolveProviderModelId(input: {
  modelId?: string | null;
  profile?: RuntimeModelGatewayProfile | null;
  configJson: Record<string, unknown>;
}) {
  const direct = normalizeModelId(input.modelId);
  if (direct && !direct.endsWith("-default")) {
    return direct;
  }

  const configuredTargetModel =
    typeof input.configJson.targetModel === "string"
      ? input.configJson.targetModel
      : null;
  const target = normalizeModelId(configuredTargetModel);
  if (target) {
    return target;
  }

  return normalizeModelId(input.profile?.modelAlias);
}

export function resolveImageModelCapabilities(input: {
  profile?: RuntimeModelGatewayProfile | null;
  configJson?: Record<string, unknown>;
  providerKind?: string | null;
  modelId?: string | null;
}): ImageModelCapabilities {
  const configJson =
    input.configJson ??
    (input.profile?.configJson && typeof input.profile.configJson === "object"
      ? input.profile.configJson
      : {});
  const provider =
    input.providerKind?.trim().toLowerCase() ||
    readProviderKind(configJson) ||
    undefined;
  const supportedParameters = toStringArray(configJson.supportedParameters);
  const configured = configJson.imageGeneration;
  const providerModelId = resolveProviderModelId({
    modelId: input.modelId,
    profile: input.profile,
    configJson,
  });
  const gemini31 = isGemini31FlashImagePreview(providerModelId);
  const aspectRatioValues = gemini31
    ? [...GEMINI_31_EXTENDED_ASPECT_RATIOS]
    : [...ASPECT_RATIOS];
  const qualityValues = resolveQualityValues({
    modelId: providerModelId,
  });

  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    const record = configured as Partial<ImageModelCapabilities>;
    if (record.controls) {
      return {
        supported: record.supported ?? true,
        provider,
        supportedParameters,
        controls: {
          aspectRatio: record.controls.aspectRatio
            ? {
                values: record.controls.aspectRatio.values as ImageAspectRatio[],
              }
            : undefined,
          quality: record.controls.quality
            ? {
                values: record.controls.quality.values as ImageQuality[],
              }
            : undefined,
          style: record.controls.style
            ? {
                values: record.controls.style.values as ImageStyle[],
              }
            : undefined,
        },
        maxVariants: record.maxVariants ?? 1,
      };
    }
  }

  if (provider === "openrouter") {
    return {
      supported: true,
      provider,
      supportedParameters,
      controls: {
        aspectRatio: {
          values: aspectRatioValues as ImageAspectRatio[],
        },
        quality: {
          values: [...qualityValues],
        },
        style: {
          values: [...STYLES],
        },
      },
      maxVariants: 1,
    };
  }

  if (!provider || GENERIC_IMAGE_PROVIDER_KINDS.has(provider)) {
    return {
      supported: true,
      provider,
      supportedParameters,
      controls: {
        aspectRatio: {
          values: [...ASPECT_RATIOS],
        },
        quality: {
          values: [...qualityValues],
        },
        style: {
          values: [...STYLES],
        },
      },
      maxVariants: 1,
    };
  }

  return {
    supported: false,
    provider,
    supportedParameters,
    controls: {
      aspectRatio: { values: ["auto"] },
      quality: { values: ["auto"] },
      style: { values: [...STYLES] },
    },
    maxVariants: 1,
  };
}
