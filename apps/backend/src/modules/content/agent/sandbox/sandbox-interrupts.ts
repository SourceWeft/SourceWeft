import type { InterruptOnConfig } from "langchain";
import { AGENT_TOOL_NAMES } from "../tool-names";

export function createSandboxInterruptConfigs(): Record<string, InterruptOnConfig> {
  return {
    [AGENT_TOOL_NAMES.prepareSandboxWorkspace]: {
      allowedDecisions: ["approve", "reject"],
      description: "Prepare selected SourceWeft /work files inside an isolated sandbox runtime. Review paths and sizes before copying data into the sandbox.",
    },
    [AGENT_TOOL_NAMES.execute]: {
      allowedDecisions: ["approve", "edit", "reject"],
      description: "Execute a shell command inside an isolated sandbox runtime. Review command intent, network access, and expected outputs before running.",
    },
    [AGENT_TOOL_NAMES.collectSandboxOutputs]: {
      allowedDecisions: ["approve", "reject"],
      description: "Collect selected sandbox outputs back into SourceWeft /work. Review destination paths before persisting output.",
    },
  };
}
