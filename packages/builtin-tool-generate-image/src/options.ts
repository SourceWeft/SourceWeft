import {
  DEFAULT_IMAGE_ARTIFACT_CONFIG,
  GENERATE_IMAGE_TOOL_ID,
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODEL_CATALOG_KEY,
  IMAGE_QUALITIES,
  IMAGE_STYLES,
  type ImageToolOption,
} from "./image-types";

function toOptionValues(values: readonly string[]) {
  return values.map((value) => ({ value, label: value }));
}

/**
 * Every option here offers the full set this capability understands, then
 * declares where the *selected model's* supported subset is advertised. The
 * mapping from an option id to its slot in the model-catalog annotation is the
 * one thing only this package can know, so it is stated here — the client that
 * narrows the picker just follows the pointer.
 */
export const generateImageToolOptions: readonly ImageToolOption[] = [
  {
    id: "aspectRatio",
    title: "Aspect Ratio",
    description: "Default aspect ratio for generated images.",
    valueType: "string",
    defaultValue: DEFAULT_IMAGE_ARTIFACT_CONFIG.aspectRatio,
    target: { toolId: GENERATE_IMAGE_TOOL_ID, path: "config.aspectRatio" },
    modelValues: {
      key: IMAGE_MODEL_CATALOG_KEY,
      path: "controls.aspectRatio.values",
    },
    values: toOptionValues(IMAGE_ASPECT_RATIOS),
  },
  {
    id: "quality",
    title: "Quality",
    description: "Default quality level for generated images.",
    valueType: "string",
    defaultValue: DEFAULT_IMAGE_ARTIFACT_CONFIG.quality,
    target: { toolId: GENERATE_IMAGE_TOOL_ID, path: "config.quality" },
    modelValues: {
      key: IMAGE_MODEL_CATALOG_KEY,
      path: "controls.quality.values",
    },
    values: toOptionValues(IMAGE_QUALITIES),
  },
  {
    id: "style",
    title: "Style",
    description: "Default visual style for generated images.",
    valueType: "string",
    defaultValue: DEFAULT_IMAGE_ARTIFACT_CONFIG.style,
    target: { toolId: GENERATE_IMAGE_TOOL_ID, path: "config.style" },
    modelValues: {
      key: IMAGE_MODEL_CATALOG_KEY,
      path: "controls.style.values",
    },
    values: toOptionValues(IMAGE_STYLES),
  },
] as const;
