import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

const sandboxActivation = {
  default: "always",
  userControl: "none",
  skill: {
    declarable: true,
    activates: true,
  },
} as const;

export const prepareSandboxWorkspaceAgentTool = defineAgentTool({
  id: "prepareSandboxWorkspace",
  name: "prepare_sandbox_workspace",
  domain: "sandbox",
  capabilities: ["sandbox", "sandbox_file_transfer"],
  activation: sandboxActivation,
  defaultPermission: "ask",
  riskLevel: "high",
});

export const executeAgentTool = defineAgentTool({
  id: "execute",
  name: "execute",
  domain: "sandbox",
  capabilities: ["sandbox", "sandbox_execute"],
  activation: sandboxActivation,
  defaultPermission: "ask",
  riskLevel: "high",
});

export const collectSandboxOutputsAgentTool = defineAgentTool({
  id: "collectSandboxOutputs",
  name: "collect_sandbox_outputs",
  domain: "sandbox",
  capabilities: ["sandbox", "sandbox_file_transfer"],
  activation: sandboxActivation,
  defaultPermission: "ask",
  riskLevel: "high",
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const PREPARE_SANDBOX_TOOL_NAME = prepareSandboxWorkspaceAgentTool.name;
export const EXECUTE_TOOL_NAME = executeAgentTool.name;
export const COLLECT_SANDBOX_OUTPUTS_TOOL_NAME = collectSandboxOutputsAgentTool.name;

export const sandboxAgentToolDefs = [
  prepareSandboxWorkspaceAgentTool,
  executeAgentTool,
  collectSandboxOutputsAgentTool,
] as const;
