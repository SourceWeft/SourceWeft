import { createDeepAgent } from "deepagents";

type DeepAgentsRuntimeConfig = NonNullable<Parameters<typeof createDeepAgent>[0]>;

export type DeepAgentsRuntimeTool = NonNullable<
  DeepAgentsRuntimeConfig["tools"]
>[number];

export type DeepAgentsRuntimeHandoffInput = Omit<
  DeepAgentsRuntimeConfig,
  "tools"
> & {
  tools: DeepAgentsRuntimeTool[];
};

export function createDeepAgentsRuntimeHandoff(
  input: DeepAgentsRuntimeHandoffInput,
) {
  if (!Array.isArray(input.tools)) {
    throw new Error("DeepAgents handoff requires a LangChain tool array");
  }
  const runtime = createDeepAgent(
    input as unknown as Parameters<typeof createDeepAgent>[0],
  );
  return {
    boundary: "deepagents" as const,
    runtime,
    tools: input.tools,
  };
}
