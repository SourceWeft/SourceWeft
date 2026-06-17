import {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  GENERATE_IMAGE_TOOL_ID,
  IMAGE_ASPECT_RATIOS,
  IMAGE_QUALITIES,
  IMAGE_STYLES,
  type ImageToolOption,
} from "./image-types";

function toOptionValues(values: readonly string[]) {
  return values.map((value) => ({ value, label: value }));
}

export const generateImageToolOptions: readonly ImageToolOption[] = [
  {
    id: "aspectRatio",
    title: "Aspect Ratio",
    description: "Default aspect ratio for generated images.",
    valueType: "string",
    defaultValue: DEFAULT_IMAGE_ARTIFACT_CONFIG.aspectRatio,
    target: { toolId: GENERATE_IMAGE_TOOL_ID, path: "config.aspectRatio" },
    values: toOptionValues(IMAGE_ASPECT_RATIOS),
  },
  {
    id: "quality",
    title: "Quality",
    description: "Default quality level for generated images.",
    valueType: "string",
    defaultValue: DEFAULT_IMAGE_ARTIFACT_CONFIG.quality,
    target: { toolId: GENERATE_IMAGE_TOOL_ID, path: "config.quality" },
    values: toOptionValues(IMAGE_QUALITIES),
  },
  {
    id: "style",
    title: "Style",
    description: "Default visual style for generated images.",
    valueType: "string",
    defaultValue: DEFAULT_IMAGE_ARTIFACT_CONFIG.style,
    target: { toolId: GENERATE_IMAGE_TOOL_ID, path: "config.style" },
    values: toOptionValues(IMAGE_STYLES),
  },
] as const;
