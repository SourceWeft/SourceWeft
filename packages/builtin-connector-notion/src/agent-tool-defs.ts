import { defineAgentTool } from "@sourceweft/contracts/agent-tools";

const notionActivation = {
  default: "off",
  userControl: "enable-disable",
  skill: {
    declarable: true,
    activates: true,
  },
} as const;

const notionSlashIcon = {
  iconName: "notion",
  iconTone: "brand",
} as const;

export const searchNotionPagesAgentTool = defineAgentTool({
  id: "searchNotionPages",
  name: "search_notion_pages",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_read"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  defaultPermission: "allow",
  riskLevel: "low",
  slash: {
    description:
      "Find Notion pages with a non-empty search query and return page IDs",
    displayName: "Find Notion pages",
    ...notionSlashIcon,
    supportsCommand: true,
  },
});

export const readNotionPageAgentTool = defineAgentTool({
  id: "readNotionPage",
  name: "read_notion_page",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_read"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  defaultPermission: "allow",
  riskLevel: "low",
  slash: {
    description: "Read Notion page content by page ID",
    displayName: "Read Notion page",
    ...notionSlashIcon,
    supportsCommand: true,
  },
});

export const createNotionPageAgentTool = defineAgentTool({
  id: "createNotionPage",
  name: "create_notion_page",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  slash: {
    description:
      "Create a Notion page in the authorized workspace unless an explicit parent page or data source ID is provided",
    displayName: "Create Notion page",
    ...notionSlashIcon,
    supportsCommand: true,
  },
});

export const appendNotionPageAgentTool = defineAgentTool({
  id: "appendNotionPage",
  name: "append_notion_page",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  slash: {
    description: "Propose appending content to a Notion page",
    displayName: "Append Notion page",
    ...notionSlashIcon,
    supportsCommand: true,
  },
});

export const updateNotionPageAgentTool = defineAgentTool({
  id: "updateNotionPage",
  name: "update_notion_page",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  slash: {
    description: "Propose updating a Notion page by page ID",
    displayName: "Update Notion page",
    ...notionSlashIcon,
    supportsCommand: true,
  },
});

export const deleteNotionPageAgentTool = defineAgentTool({
  id: "deleteNotionPage",
  name: "delete_notion_page",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  defaultPermission: "ask",
  riskLevel: "high",
  slash: {
    description: "Move Notion pages to trash by page ID",
    displayName: "Delete Notion page",
    ...notionSlashIcon,
    supportsCommand: true,
  },
});

export const saveArtifactToNotionAgentTool = defineAgentTool({
  id: "saveArtifactToNotion",
  name: "save_artifact_to_notion",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write", "artifact"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  slash: {
    description: "Propose saving an artifact reference to Notion",
    displayName: "Save artifact to Notion",
    ...notionSlashIcon,
    supportsCommand: true,
  },
});

export const saveFinalAnswerToNotionAgentTool = defineAgentTool({
  id: "saveFinalAnswerToNotion",
  name: "save_final_answer_to_notion",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  defaultPermission: "ask",
  riskLevel: "medium",
  slash: {
    description: "Propose saving the final answer to Notion",
    displayName: "Save answer to Notion",
    ...notionSlashIcon,
    supportsCommand: true,
  },
});

/** Tool name constants — use these instead of AGENT_TOOL_NAMES */
export const SEARCH_NOTION_PAGES_TOOL_NAME = searchNotionPagesAgentTool.name;
export const READ_NOTION_PAGE_TOOL_NAME = readNotionPageAgentTool.name;
export const CREATE_NOTION_PAGE_TOOL_NAME = createNotionPageAgentTool.name;
export const APPEND_NOTION_PAGE_TOOL_NAME = appendNotionPageAgentTool.name;
export const UPDATE_NOTION_PAGE_TOOL_NAME = updateNotionPageAgentTool.name;
export const DELETE_NOTION_PAGE_TOOL_NAME = deleteNotionPageAgentTool.name;
export const SAVE_ARTIFACT_TO_NOTION_TOOL_NAME = saveArtifactToNotionAgentTool.name;
export const SAVE_FINAL_ANSWER_TO_NOTION_TOOL_NAME = saveFinalAnswerToNotionAgentTool.name;

export const notionAgentToolDefs = [
  searchNotionPagesAgentTool,
  readNotionPageAgentTool,
  createNotionPageAgentTool,
  appendNotionPageAgentTool,
  updateNotionPageAgentTool,
  deleteNotionPageAgentTool,
  saveArtifactToNotionAgentTool,
  saveFinalAnswerToNotionAgentTool,
] as const;
