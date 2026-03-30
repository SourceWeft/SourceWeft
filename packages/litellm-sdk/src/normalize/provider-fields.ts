import { isRecord } from "../utils/object";

const PROVIDER_FIELD_KEYS = [
  "provider_specific_fields",
  "vertex_ai_grounding_metadata",
  "grounding_metadata",
  "citations",
  "web_search_sources",
] as const;

export function extractProviderFields(
  ...candidates: unknown[]
): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};

  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }

    for (const key of PROVIDER_FIELD_KEYS) {
      const value = candidate[key];
      if (value !== undefined) {
        output[key] = value;
      }
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}
