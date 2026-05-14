import type {
  ImageAspectRatio,
  ImageQuality,
  ImageStyle,
} from "@sourceweft/model-gateway";

export type ArtifactGenerationKind = "image";

export type ArtifactImageConfig = {
  aspectRatio: ImageAspectRatio;
  quality: ImageQuality;
  style: ImageStyle;
};

export type ArtifactToolSelection = {
  kind: ArtifactGenerationKind;
  mode?: "auto" | "generate";
  modelAlias?: string;
  image?: Partial<ArtifactImageConfig>;
};

export type GenerateImageToolSelection = {
  enabled?: boolean;
  mode?: "auto" | "generate";
  modelAlias?: string;
  execution?: {
    byokModelId?: string;
    credentialId?: string;
    modelAlias?: string;
    providerModel?: string;
    executionMode?: "GLOBAL" | "BYOK";
    providerHint?: string;
    byok?: {
      provider: string;
      apiKey?: string;
    };
  };
  config?: Partial<ArtifactImageConfig>;
};

export type ImageModelCapabilities = {
  supported: boolean;
  provider?: string;
  supportedParameters?: string[];
  controls: {
    aspectRatio?: {
      values: ImageAspectRatio[];
    };
    quality?: {
      values: ImageQuality[];
    };
    style?: {
      values: ImageStyle[];
    };
  };
  maxVariants?: number;
};

export type ArtifactIntentDecision = {
  kind: ArtifactGenerationKind | null;
  shouldInjectTool: boolean;
  source: "none" | "explicit_tool" | "skill";
  confidence: number;
  reason: string;
  config: ArtifactImageConfig;
  warnings: string[];
};

export const DEFAULT_IMAGE_ARTIFACT_CONFIG: ArtifactImageConfig = {
  aspectRatio: "auto",
  quality: "auto",
  style: "auto",
};

const IMAGE_ASPECT_RATIOS = [
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
const IMAGE_QUALITIES = ["auto", "low", "standard", "higher", "highest"] as const;
const IMAGE_STYLES = ["auto", "ghibli", "pixar", "cartoon", "pixel"] as const;

function normalizeEnumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  if (typeof value !== "string") {
    return fallback;
  }
  return allowed.includes(value as T[number]) ? (value as T[number]) : fallback;
}

function normalizeOptionalEnumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return allowed.includes(value as T[number]) ? (value as T[number]) : undefined;
}

export function normalizeArtifactImageConfig(
  input: unknown,
): ArtifactImageConfig {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  return {
    aspectRatio: normalizeEnumValue(
      record.aspectRatio,
      IMAGE_ASPECT_RATIOS,
      DEFAULT_IMAGE_ARTIFACT_CONFIG.aspectRatio,
    ),
    quality: normalizeEnumValue(
      record.quality,
      IMAGE_QUALITIES,
      DEFAULT_IMAGE_ARTIFACT_CONFIG.quality,
    ),
    style: normalizeEnumValue(
      record.style,
      IMAGE_STYLES,
      DEFAULT_IMAGE_ARTIFACT_CONFIG.style,
    ),
  };
}

export function normalizePartialArtifactImageConfig(
  input: unknown,
): Partial<ArtifactImageConfig> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const config: Partial<ArtifactImageConfig> = {};
  if (record.aspectRatio !== undefined) {
    const aspectRatio = normalizeOptionalEnumValue(
      record.aspectRatio,
      IMAGE_ASPECT_RATIOS,
    );
    if (aspectRatio) {
      config.aspectRatio = aspectRatio;
    }
  }
  if (record.quality !== undefined) {
    const quality = normalizeOptionalEnumValue(
      record.quality,
      IMAGE_QUALITIES,
    );
    if (quality) {
      config.quality = quality;
    }
  }
  if (record.style !== undefined) {
    const style = normalizeOptionalEnumValue(
      record.style,
      IMAGE_STYLES,
    );
    if (style) {
      config.style = style;
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

export function normalizeArtifactToolSelection(
  input: unknown,
): ArtifactToolSelection | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (record.kind !== "image") {
    return undefined;
  }

  const mode = record.mode === "generate" ? "generate" : "auto";
  const modelAlias =
    typeof record.modelAlias === "string" && record.modelAlias.trim().length > 0
      ? record.modelAlias.trim()
      : undefined;
  return {
    kind: "image",
    mode,
    ...(modelAlias ? { modelAlias } : {}),
    ...(record.image !== undefined
      ? { image: normalizePartialArtifactImageConfig(record.image) }
      : {}),
  };
}

export function normalizeGenerateImageToolSelection(
  input: unknown,
): GenerateImageToolSelection | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const modelAlias =
    typeof record.modelAlias === "string" && record.modelAlias.trim().length > 0
      ? record.modelAlias.trim()
      : undefined;
  const config = normalizePartialArtifactImageConfig(record.config);
  const execution =
    record.execution && typeof record.execution === "object" && !Array.isArray(record.execution)
      ? (record.execution as GenerateImageToolSelection["execution"])
      : undefined;
  const enabled =
    typeof record.enabled === "boolean" ? record.enabled : undefined;
  const mode = record.mode === "generate" ? "generate" : undefined;

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
  ...configs: Array<Partial<ArtifactImageConfig> | undefined>
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
