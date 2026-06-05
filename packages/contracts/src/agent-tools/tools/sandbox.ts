import { defineAgentTool } from "../define";

const sandboxActivation = {
  default: "always",
  userControl: "none",
  skill: {
    declarable: true,
    activates: true,
  },
} as const;

export const prepareSandboxWorkspaceTool = defineAgentTool({
  id: "prepareSandboxWorkspace",
  name: "prepare_sandbox_workspace",
  domain: "sandbox",
  capabilities: ["sandbox", "sandbox_file_transfer"],
  activation: sandboxActivation,
  defaultPermission: "ask",
  riskLevel: "high",
});

export const executeTool = defineAgentTool({
  id: "execute",
  name: "execute",
  domain: "sandbox",
  capabilities: ["sandbox", "sandbox_execute"],
  activation: sandboxActivation,
  defaultPermission: "ask",
  riskLevel: "high",
});

export const collectSandboxOutputsTool = defineAgentTool({
  id: "collectSandboxOutputs",
  name: "collect_sandbox_outputs",
  domain: "sandbox",
  capabilities: ["sandbox", "sandbox_file_transfer"],
  activation: sandboxActivation,
  defaultPermission: "ask",
  riskLevel: "high",
});

export const sandboxTools = [
  prepareSandboxWorkspaceTool,
  executeTool,
  collectSandboxOutputsTool,
] as const;
