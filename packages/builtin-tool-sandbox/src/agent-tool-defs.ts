import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

/**
 * Wall-clock budget declared for the two tools that may have to acquire a
 * sandbox before doing their own work: a cold start (provider create 21-70 s
 * observed, plus the provider's readiness probe of up to 90 s) must not be
 * charged against the command's own interactive budget. 240 s = 120 s command
 * budget + 120 s acquisition budget; the host clamps it to its own ceiling
 * (10 min). collect_sandbox_outputs keeps the host default: it never creates.
 */
export const SANDBOX_TOOL_EXECUTION_TIMEOUT_MS = 240_000;

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
  executionTimeoutMs: SANDBOX_TOOL_EXECUTION_TIMEOUT_MS,
  defaultPermission: "ask",
  riskLevel: "high",
});

export const executeAgentTool = defineAgentTool({
  id: "execute",
  name: "execute",
  domain: "sandbox",
  capabilities: ["sandbox", "sandbox_execute"],
  activation: sandboxActivation,
  executionTimeoutMs: SANDBOX_TOOL_EXECUTION_TIMEOUT_MS,
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
export const COLLECT_SANDBOX_OUTPUTS_TOOL_NAME =
  collectSandboxOutputsAgentTool.name;

export const sandboxAgentToolDefs = [
  prepareSandboxWorkspaceAgentTool,
  executeAgentTool,
  collectSandboxOutputsAgentTool,
] as const;
