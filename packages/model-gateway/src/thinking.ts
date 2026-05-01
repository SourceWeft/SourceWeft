import type { ThinkingConfig, ThinkingMode } from "./types";

export function resolveThinkingMode(thinking: ThinkingConfig | undefined): ThinkingMode {
  if (!thinking) {
    return "auto";
  }

  if (thinking.mode) {
    return thinking.mode;
  }

  if (thinking.enabled === false) {
    return "off";
  }

  if (thinking.enabled === true && thinking.effort) {
    return "effort";
  }

  return "auto";
}
