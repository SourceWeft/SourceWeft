import {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  IMAGE_ASPECT_RATIO_SET,
  IMAGE_QUALITY_SET,
  IMAGE_STYLE_SET,
  type ArtifactImageConfig,
  type ArtifactToolSelection,
  type GenerateImageToolSelection,
  type ImageAspectRatio,
  type ImageQuality,
  type ImageStyle,
} from "./image-types";

export function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function normalizeImageAspectRatio(
  value: unknown,
): ImageAspectRatio | undefined {
  if (typeof value !== "string" || !IMAGE_ASPECT_RATIO_SET.has(value)) {
    return undefined;
  }
  switch (value) {
    case "auto":
    case "1:1":
    case "2:3":
    case "3:2":
    case "3:4":
    case "4:3":
    case "4:5":
    case "5:4":
    case "9:16":
    case "16:9":
    case "21:9":
    case "1:4":
    case "4:1":
    case "1:8":
    case "8:1":
      return value;
    default:
      return undefined;
  }
}

export function normalizeImageQuality(value: unknown): ImageQuality | undefined {
  if (typeof value !== "string" || !IMAGE_QUALITY_SET.has(value)) {
    return undefined;
  }
  switch (value) {
    case "auto":
    case "low":
    case "standard":
    case "higher":
    case "highest":
      return value;
    default:
      return undefined;
  }
}

export function normalizeImageStyle(value: unknown): ImageStyle | undefined {
  if (typeof value !== "string" || !IMAGE_STYLE_SET.has(value)) {
    return undefined;
  }
  switch (value) {
    case "auto":
    case "ghibli":
    case "pixar":
    case "cartoon":
    case "pixel":
      return value;
    default:
      return undefined;
  }
}

export function normalizeArtifactImageConfig(
  input: unknown,
): ArtifactImageConfig {
  const record = toRecord(input) ?? {};
  return {
    aspectRatio:
      normalizeImageAspectRatio(record.aspectRatio) ??
      DEFAULT_IMAGE_ARTIFACT_CONFIG.aspectRatio,
    quality:
      normalizeImageQuality(record.quality) ??
      DEFAULT_IMAGE_ARTIFACT_CONFIG.quality,
    style:
      normalizeImageStyle(record.style) ?? DEFAULT_IMAGE_ARTIFACT_CONFIG.style,
  };
}

export function normalizePartialArtifactImageConfig(
  input: unknown,
): Partial<ArtifactImageConfig> | undefined {
  const record = toRecord(input);
  if (!record) {
    return undefined;
  }
  const config: {
    aspectRatio?: ImageAspectRatio;
    quality?: ImageQuality;
    style?: ImageStyle;
  } = {};
  const aspectRatio = normalizeImageAspectRatio(record.aspectRatio);
  const quality = normalizeImageQuality(record.quality);
  const style = normalizeImageStyle(record.style);
  if (aspectRatio) {
    config.aspectRatio = aspectRatio;
  }
  if (quality) {
    config.quality = quality;
  }
  if (style) {
    config.style = style;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

export function normalizeArtifactToolSelection(
  input: unknown,
): ArtifactToolSelection | undefined {
  const record = toRecord(input);
  if (!record || record.kind !== "image") {
    return undefined;
  }
  const modelAlias = normalizeOptionalString(record.modelAlias);
  return {
    kind: "image",
    mode: record.mode === "generate" ? "generate" : "auto",
    ...(modelAlias ? { modelAlias } : {}),
    ...(record.image !== undefined
      ? { image: normalizePartialArtifactImageConfig(record.image) }
      : {}),
  };
}

function normalizeGenerateImageExecution(
  input: unknown,
): GenerateImageToolSelection["execution"] | undefined {
  const record = toRecord(input);
  if (!record) {
    return undefined;
  }
  const byokRecord = toRecord(record.byok);
  const byokProvider = normalizeOptionalString(byokRecord?.provider);
  const byok =
    byokRecord && byokProvider
      ? {
          provider: byokProvider,
          ...(normalizeOptionalString(byokRecord.apiKey)
            ? { apiKey: normalizeOptionalString(byokRecord.apiKey) }
            : {}),
        }
      : undefined;
  const executionMode =
    record.executionMode === "GLOBAL" || record.executionMode === "BYOK"
      ? record.executionMode
      : undefined;
  const execution: NonNullable<GenerateImageToolSelection["execution"]> = {
    ...(normalizeOptionalString(record.byokModelId)
      ? { byokModelId: normalizeOptionalString(record.byokModelId) }
      : {}),
    ...(normalizeOptionalString(record.credentialId)
      ? { credentialId: normalizeOptionalString(record.credentialId) }
      : {}),
    ...(normalizeOptionalString(record.modelAlias)
      ? { modelAlias: normalizeOptionalString(record.modelAlias) }
      : {}),
    ...(normalizeOptionalString(record.providerModel)
      ? { providerModel: normalizeOptionalString(record.providerModel) }
      : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(normalizeOptionalString(record.providerHint)
      ? { providerHint: normalizeOptionalString(record.providerHint) }
      : {}),
    ...(byok ? { byok } : {}),
  };
  return Object.keys(execution).length > 0 ? execution : undefined;
}

export function normalizeGenerateImageToolSelection(
  input: unknown,
): GenerateImageToolSelection | undefined {
  const record = toRecord(input);
  if (!record) {
    return undefined;
  }
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const mode = record.mode === "generate" ? "generate" : undefined;
  const modelAlias = normalizeOptionalString(record.modelAlias);
  const execution = normalizeGenerateImageExecution(record.execution);
  const config = normalizePartialArtifactImageConfig(record.config);
  if (enabled === undefined && !mode && !modelAlias && !execution && !config) {
    return undefined;
  }
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(mode ? { mode } : {}),
    ...(modelAlias ? { modelAlias } : {}),
    ...(execution ? { execution } : {}),
    ...(config ? { config } : {}),
  };
}

export function mergeImageArtifactConfig(
  ...configs: readonly (Partial<ArtifactImageConfig> | undefined)[]
): ArtifactImageConfig {
  return configs.reduce<ArtifactImageConfig>((current, next) => {
    if (!next) {
      return current;
    }
    return {
      ...current,
      ...normalizePartialArtifactImageConfig(next),
    };
  }, DEFAULT_IMAGE_ARTIFACT_CONFIG);
}
