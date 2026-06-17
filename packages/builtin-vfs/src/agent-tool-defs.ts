import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

const filesystemActivation = {
  default: "always",
  userControl: "none",
  skill: {
    declarable: false,
    activates: false,
  },
} as const;

export const lsAgentTool = defineAgentTool({
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

export const readFileAgentTool = defineAgentTool({
  id: "readFile",
  name: "read_file",
  domain: "filesystem",
  capabilities: ["filesystem", "read_tool_output", "oversized_current_turn"],
  activation: filesystemActivation,
  defaultPermission: "allow",
  riskLevel: "low",
});

export const globAgentTool = defineAgentTool({
  id: "glob",
  name: "glob",
  domain: "filesystem",
  capabilities: ["filesystem", "pattern_scope"],
  activation: filesystemActivation,
  defaultPermission: "allow",
  riskLevel: "low",
});

export const grepAgentTool = defineAgentTool({
  id: "grep",
  name: "grep",
  domain: "filesystem",
  capabilities: ["filesystem", "oversized_current_turn"],
  activation: filesystemActivation,
  defaultPermission: "allow",
  riskLevel: "low",
});

export const writeFileAgentTool = defineAgentTool({
  id: "writeFile",
  name: "write_file",
  domain: "filesystem",
  capabilities: ["filesystem", "workfile_write"],
  activation: filesystemActivation,
  defaultPermission: "ask",
  riskLevel: "medium",
});

export const editFileAgentTool = defineAgentTool({
  id: "editFile",
  name: "edit_file",
  domain: "filesystem",
  capabilities: ["filesystem", "workfile_write"],
  activation: filesystemActivation,
  defaultPermission: "ask",
  riskLevel: "medium",
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const LS_TOOL_NAME = lsAgentTool.name;
export const READ_FILE_TOOL_NAME = readFileAgentTool.name;
export const GLOB_TOOL_NAME = globAgentTool.name;
export const GREP_TOOL_NAME = grepAgentTool.name;
export const WRITE_FILE_TOOL_NAME = writeFileAgentTool.name;
export const EDIT_FILE_TOOL_NAME = editFileAgentTool.name;

export const filesystemAgentToolDefs = [
  editFileAgentTool,
  globAgentTool,
  grepAgentTool,
  lsAgentTool,
  readFileAgentTool,
  writeFileAgentTool,
] as const;
