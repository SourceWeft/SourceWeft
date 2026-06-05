import { defineAgentTool } from "../define";

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

export const searchNotionPagesTool = defineAgentTool({
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

export const readNotionPageTool = defineAgentTool({
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

export const createNotionPageTool = defineAgentTool({
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

export const appendNotionPageTool = defineAgentTool({
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

export const updateNotionPageTool = defineAgentTool({
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

export const deleteNotionPageTool = defineAgentTool({
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

export const saveArtifactToNotionTool = defineAgentTool({
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

export const saveFinalAnswerToNotionTool = defineAgentTool({
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

export const notionTools = [
  searchNotionPagesTool,
  readNotionPageTool,
  createNotionPageTool,
  appendNotionPageTool,
  updateNotionPageTool,
  deleteNotionPageTool,
  saveArtifactToNotionTool,
  saveFinalAnswerToNotionTool,
] as const;
