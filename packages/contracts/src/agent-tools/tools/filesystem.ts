import { defineAgentTool } from "../define";

const filesystemActivation = {
  default: "always",
  userControl: "none",
  skill: {
    declarable: false,
    activates: false,
  },
} as const;

export const lsTool = defineAgentTool({
  id: "ls",
  name: "ls",
  domain: "filesystem",
  capabilities: ["filesystem"],
  activation: filesystemActivation,
  defaultPermission: "allow",
  riskLevel: "low",
  slash: {
    displayName: "ls",
  },
});

export const readFileTool = defineAgentTool({
  id: "readFile",
  name: "read_file",
  domain: "filesystem",
  capabilities: ["filesystem", "read_tool_output", "oversized_current_turn"],
  activation: filesystemActivation,
  defaultPermission: "allow",
  riskLevel: "low",
});

export const globTool = defineAgentTool({
  id: "glob",
  name: "glob",
  domain: "filesystem",
  capabilities: ["filesystem", "pattern_scope"],
  activation: filesystemActivation,
  defaultPermission: "allow",
  riskLevel: "low",
});

export const grepTool = defineAgentTool({
  id: "grep",
  name: "grep",
  domain: "filesystem",
  capabilities: ["filesystem", "oversized_current_turn"],
  activation: filesystemActivation,
  defaultPermission: "allow",
  riskLevel: "low",
});

export const writeFileTool = defineAgentTool({
  id: "writeFile",
  name: "write_file",
  domain: "filesystem",
  capabilities: ["filesystem", "workfile_write"],
  activation: filesystemActivation,
  defaultPermission: "ask",
  riskLevel: "medium",
});

export const editFileTool = defineAgentTool({
  id: "editFile",
  name: "edit_file",
  domain: "filesystem",
  capabilities: ["filesystem", "workfile_write"],
  activation: filesystemActivation,
  defaultPermission: "ask",
  riskLevel: "medium",
});

export const filesystemTools = [
  editFileTool,
  globTool,
  grepTool,
  lsTool,
  readFileTool,
  writeFileTool,
] as const;
