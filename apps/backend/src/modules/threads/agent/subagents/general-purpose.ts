import { GENERAL_PURPOSE_SUBAGENT, type SubAgent } from "deepagents";
import type { AgentMiddleware, InterruptOnConfig } from "langchain";

export function createGeneralPurposeSubagent(input: {
  availableTools: readonly { readonly name: string }[];
  interruptOn: Record<string, boolean | InterruptOnConfig>;
  middleware: readonly AgentMiddleware[];
  skills?: string[];
}): SubAgent {
  return {
    ...GENERAL_PURPOSE_SUBAGENT,
    tools: input.availableTools as unknown as SubAgent["tools"],
    middleware: input.middleware,
    interruptOn: input.interruptOn,
    ...(input.skills ? { skills: input.skills } : {}),
  };
}
