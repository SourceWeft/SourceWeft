import type { StreamThreadEventInput } from "./types";

export function shouldApplyLegacySlashSkillSelection(
  tools: StreamThreadEventInput["tools"],
) {
  return tools?.skillIds === undefined;
}
