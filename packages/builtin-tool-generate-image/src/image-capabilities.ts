import {
  BASE_IMAGE_ASPECT_RATIOS,
  GENERIC_IMAGE_PROVIDER_KINDS,
  IMAGE_ASPECT_RATIOS,
  IMAGE_QUALITIES,
  IMAGE_STYLES,
  type ImageModelCapabilities,
  type ImageQuality,
} from "./image-types";
import {
  normalizeImageAspectRatio,
  normalizeImageQuality,
  normalizeImageStyle,
  toRecord,
  toStringArray,
} from "./image-config";

type ImageCapabilityProfile = {
  readonly modelAlias?: string | null;
  readonly configJson?: unknown;
};

function normalizeModelId(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function readProviderKind(configJson: Record<string, unknown>): string | null {
  const direct = configJson.providerKind ?? configJson.provider_kind;
  return typeof direct === "string" ? direct.trim().toLowerCase() : null;
}

function isGemini31FlashImagePreview(modelId: string | null | undefined) {
  return normalizeModelId(modelId) === "google/gemini-3.1-flash-image-preview";
}

function isGeminiImageModel(modelId: string | null | undefined) {
  return normalizeModelId(modelId).startsWith("google/gemini-");
}

function resolveQualityValues(input: {
  readonly modelId: string | null | undefined;
}): readonly ImageQuality[] {
  if (isGemini31FlashImagePreview(input.modelId)) {
    return IMAGE_QUALITIES;
  }
  if (isGeminiImageModel(input.modelId)) {
    return ["auto", "standard", "higher", "highest"];
  }
  return ["auto"];
}

function resolveProviderModelId(input: {
  readonly modelId?: string | null;
  readonly profile?: ImageCapabilityProfile | null;
  readonly configJson: Record<string, unknown>;
}): string {
  const direct = normalizeModelId(input.modelId);
  if (direct && !direct.endsWith("-default")) {
    return direct;
  }
  const configuredTargetModel =
    typeof input.configJson.targetModel === "string"
      ? input.configJson.targetModel
      : null;
  const target = normalizeModelId(configuredTargetModel);
  return target || normalizeModelId(input.profile?.modelAlias);
}

function readCapabilityValues<T extends string>(
  input: unknown,
  normalize: (value: unknown) => T | undefined,
): readonly T[] | undefined {
  const values = toStringArray(toRecord(input)?.values).map(normalize).filter(
    (value): value is T => value !== undefined,
  );
  return values.length > 0 ? values : undefined;
}

function resolveConfiguredCapabilities(input: {
  readonly configured: unknown;
  readonly provider: string | undefined;
  readonly supportedParameters: readonly string[];
}): ImageModelCapabilities | undefined {
  const record = toRecord(input.configured);
  const controls = toRecord(record?.controls);
  if (!record || !controls) {
    return undefined;
  }
  return {
    supported:
      typeof record.supported === "boolean" ? record.supported : true,
    provider: input.provider,
    supportedParameters: input.supportedParameters,
    controls: {
      aspectRatio: {
        values:
          readCapabilityValues(controls.aspectRatio, normalizeImageAspectRatio) ??
          ["auto"],
      },
      quality: {
        values:
          readCapabilityValues(controls.quality, normalizeImageQuality) ??
          ["auto"],
      },
      style: {
        values:
          readCapabilityValues(controls.style, normalizeImageStyle) ?? ["auto"],
      },
    },
    maxVariants: typeof record.maxVariants === "number" ? record.maxVariants : 1,
  };
}

export function resolveImageModelCapabilities(input: {
  readonly profile?: ImageCapabilityProfile | null;
  readonly configJson?: Record<string, unknown>;
  readonly providerKind?: string | null;
  readonly modelId?: string | null;
}): ImageModelCapabilities {
  const configJson = input.configJson ?? toRecord(input.profile?.configJson) ?? {};
  const provider =
    input.providerKind?.trim().toLowerCase() ||
    readProviderKind(configJson) ||
    undefined;
  const supportedParameters = toStringArray(configJson.supportedParameters);
  const providerModelId = resolveProviderModelId({
    modelId: input.modelId,
    profile: input.profile,
    configJson,
  });
  const configured = resolveConfiguredCapabilities({
    configured: configJson.imageGeneration,
    provider,
    supportedParameters,
  });
  if (configured) {
    return configured;
  }
  const aspectRatioValues = isGemini31FlashImagePreview(providerModelId)
    ? IMAGE_ASPECT_RATIOS
    : BASE_IMAGE_ASPECT_RATIOS;
  const qualityValues = resolveQualityValues({ modelId: providerModelId });
  if (provider === "openrouter") {
    return {
      supported: true,
      provider,
      supportedParameters,
      controls: {
        aspectRatio: { values: aspectRatioValues },
        quality: { values: qualityValues },
        style: { values: IMAGE_STYLES },
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
        aspectRatio: { values: BASE_IMAGE_ASPECT_RATIOS },
        quality: { values: qualityValues },
        style: { values: IMAGE_STYLES },
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
      style: { values: IMAGE_STYLES },
    },
    maxVariants: 1,
  };
}
