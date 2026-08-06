import type { ThinkingConfig, ThinkingMode } from "./types";

export function resolveThinkingMode(thinking: ThinkingConfig | undefined): ThinkingMode {
  if (!thinking) {
    return "auto";
  }

  // An explicit `enabled: false` is an explicit disable, while `mode: "auto"`
  // merely delegates the decision to the provider default. The explicit signal
  // must win over the delegating one — otherwise a caller that sets
  // `enabled: false` alongside a passed-through "auto" gets the provider's
  // default (thinking ON for DeepSeek V4) instead of the disable it asked for.
  if (thinking.enabled === false && (!thinking.mode || thinking.mode === "auto")) {
    return "off";
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
