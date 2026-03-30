import type { LiteLLMToolChoice } from "../types";

export function normalizeToolChoice(
  toolChoice: LiteLLMToolChoice | boolean | undefined,
): LiteLLMToolChoice | undefined {
  if (toolChoice === undefined || toolChoice === null) {
    return undefined;
  }

  if (toolChoice === "any" || toolChoice === true) {
    return "required";
  }

  if (toolChoice === false) {
    return "none";
  }

  return toolChoice;
}
