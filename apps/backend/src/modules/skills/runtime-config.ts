import type { EnabledSkillDescriptor } from "./types";

function escapeRuntimeValue(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Model-facing context only. Never changes skill files, manifests or staging bytes. */
export function skillRuntimeConfigLines(
  skill: Pick<EnabledSkillDescriptor, "name" | "defaultConfig">,
): string[] | null {
  const config = skill.defaultConfig?.config;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).length === 0
  )
    return null;
  return [
    `<skill_runtime_config name="${escapeRuntimeValue(skill.name)}">`,
    ...Object.entries(config).map(([key, value]) => {
      const text =
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
      return `${escapeRuntimeValue(key)}: ${escapeRuntimeValue(text)}`;
    }),
    "</skill_runtime_config>",
  ];
}
