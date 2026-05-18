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
});

export const createNotionPageTool = defineAgentTool({
  id: "createNotionPage",
  name: "create_notion_page",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
});

export const appendNotionPageTool = defineAgentTool({
  id: "appendNotionPage",
  name: "append_notion_page",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
});

export const updateNotionPageByTitleTool = defineAgentTool({
  id: "updateNotionPageByTitle",
  name: "update_notion_page_by_title",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
});

export const deleteNotionPageByTitleTool = defineAgentTool({
  id: "deleteNotionPageByTitle",
  name: "delete_notion_page_by_title",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
});

export const saveArtifactToNotionTool = defineAgentTool({
  id: "saveArtifactToNotion",
  name: "save_artifact_to_notion",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write", "artifact"],
  activation: notionActivation,
});

export const saveFinalAnswerToNotionTool = defineAgentTool({
  id: "saveFinalAnswerToNotion",
  name: "save_final_answer_to_notion",
  domain: "connector",
  capabilities: ["connector", "notion", "connector_write"],
  activation: notionActivation,
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
