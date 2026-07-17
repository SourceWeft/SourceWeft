export const GENERATE_IMAGE_TOOL_ID = "generate_image" as const;

export type GenerateImageToolId = typeof GENERATE_IMAGE_TOOL_ID;

export type ImageAspectRatio =
  | "auto"
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9"
  | "1:4"
  | "4:1"
  | "1:8"
  | "8:1";
export type ImageQuality = "auto" | "low" | "standard" | "higher" | "highest";
export type ImageStyle = "auto" | "ghibli" | "pixar" | "cartoon" | "pixel";

export type ArtifactGenerationKind = "image";

export type ArtifactImageConfig = {
  readonly aspectRatio: ImageAspectRatio;
  readonly quality: ImageQuality;
  readonly style: ImageStyle;
};

export type GenerateImageToolSelection = {
  readonly enabled?: boolean;
  readonly mode?: "auto" | "generate";
  readonly modelAlias?: string;
  readonly execution?: {
    readonly byokModelId?: string;
    readonly credentialId?: string;
    readonly modelAlias?: string;
    readonly providerModel?: string;
    readonly executionMode?: "GLOBAL" | "BYOK";
    readonly providerHint?: string;
    readonly byok?: {
      readonly provider: string;
      readonly apiKey?: string;
    };
  };
  readonly config?: Partial<ArtifactImageConfig>;
};

export type ImageModelCapabilities = {
  readonly supported: boolean;
  readonly provider?: string;
  readonly supportedParameters?: readonly string[];
  readonly controls: {
    readonly aspectRatio?: {
      readonly values: readonly ImageAspectRatio[];
    };
    readonly quality?: {
      readonly values: readonly ImageQuality[];
    };
    readonly style?: {
      readonly values: readonly ImageStyle[];
    };
  };
  readonly maxVariants?: number;
};

export type ArtifactIntentDecision = {
  readonly kind: ArtifactGenerationKind | null;
  readonly shouldInjectTool: boolean;
  readonly source: "none" | "explicit_tool" | "skill";
  readonly confidence: number;
  readonly reason: string;
  readonly config: ArtifactImageConfig;
  readonly warnings: readonly string[];
};

export type ImageToolOption = {
  readonly id: "aspectRatio" | "quality" | "style";
  readonly title: string;
  readonly description: string;
  readonly valueType: "string";
  readonly defaultValue: string;
  readonly target: {
    readonly toolId: GenerateImageToolId;
    readonly path: `config.${string}`;
  };
  readonly values: readonly {
    readonly value: string;
    readonly label: string;
  }[];
};

export const DEFAULT_IMAGE_ARTIFACT_CONFIG: ArtifactImageConfig = {
  aspectRatio: "auto",
  quality: "auto",
  style: "auto",
};

export const BASE_IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
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
];

export const IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  ...BASE_IMAGE_ASPECT_RATIOS,
  "1:4",
  "4:1",
  "1:8",
  "8:1",
];

export const IMAGE_QUALITIES: readonly ImageQuality[] = [
  "auto",
  "low",
  "standard",
  "higher",
  "highest",
];

export const IMAGE_STYLES: readonly ImageStyle[] = [
  "auto",
  "ghibli",
  "pixar",
  "cartoon",
  "pixel",
];

export const GENERIC_IMAGE_PROVIDER_KINDS = new Set([
  "openai",
  "openai-compatible",
  "azure-openai",
  "siliconflow-cn",
]);

export const IMAGE_ASPECT_RATIO_SET = new Set<string>(IMAGE_ASPECT_RATIOS);
export const IMAGE_QUALITY_SET = new Set<string>(IMAGE_QUALITIES);
export const IMAGE_STYLE_SET = new Set<string>(IMAGE_STYLES);
