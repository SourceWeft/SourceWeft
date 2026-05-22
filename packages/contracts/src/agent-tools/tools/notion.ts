import { defineAgentTool } from "../define";

const notionActivation = {
  default: "off",
  userControl: "enable-disable",
  skill: {
    declarable: true,
    activates: true,
  },
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
  slash: {
    description: "Search indexed Notion pages",
    displayName: "Search Notion pages",
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
  slash: {
    description: "Propose creating a Notion page",
    displayName: "Create Notion page",
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
  slash: {
    description: "Propose appending content to a Notion page",
    displayName: "Append Notion page",
  },
});

export const updateNotionPageByTitleTool = defineAgentTool({
  id: "updateNotionPageByTitle",
  name: "update_notion_page_by_title",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  slash: {
    description: "Propose updating a Notion page by exact title",
    displayName: "Update Notion page",
  },
});

export const deleteNotionPageByTitleTool = defineAgentTool({
  id: "deleteNotionPageByTitle",
  name: "delete_notion_page_by_title",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
  configuration: {
    configurable: true,
    configKeys: ["connectorId"],
  },
  slash: {
    description: "Propose moving a Notion page to trash by exact title",
    displayName: "Delete Notion page",
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
  slash: {
    description: "Propose saving an artifact reference to Notion",
    displayName: "Save artifact to Notion",
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
  slash: {
    description: "Propose saving the final answer to Notion",
    displayName: "Save answer to Notion",
  },
});

export const notionTools = [
  searchNotionPagesTool,
  createNotionPageTool,
  appendNotionPageTool,
  updateNotionPageByTitleTool,
  deleteNotionPageByTitleTool,
  saveArtifactToNotionTool,
  saveFinalAnswerToNotionTool,
] as const;
