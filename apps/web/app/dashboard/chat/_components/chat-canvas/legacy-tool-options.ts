export const LEGACY_TOOL_OPTIONS_WARNING_MESSAGE =
  "This message saved tool settings in a legacy format. Re-select skills and tools before editing or regenerating.";

export function hasLegacyToolOptionsMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  if (!metadata) {
    return false;
  }
  return metadata.tools !== undefined && metadata.options === undefined;
}
