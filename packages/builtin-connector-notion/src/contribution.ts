import type { ConnectorContribution } from "@sourceweft/capability-contracts";
import { notionActionInputSchemas } from "./action-schemas";

export const notionConnectorContribution = {
  id: "notion",
  title: "Notion",
  auth: {
    kind: "oauth2",
    authorizationUrl: "https://www.notion.so/install-integration",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    authorizationParams: {
      owner: "user",
    },
    sendScope: false,
  },
  sync: {
    supportsIncremental: true,
    defaultFrequencyMinutes: 360,
    resources: [
      {
        type: "notion_page",
        title: "Notion page",
        supportsDeleteDetection: false,
      },
    ],
  },
  actions: [
    agentAction({
      id: "notion.page.create",
      title: "Create Notion page",
      agentToolName: "create_notion_page",
      description:
        "Propose creating a Notion page in the authorized workspace selected by this connector. Only include parentPageId/pageId or dataSourceId when the user explicitly requested and confirmed a parent page or data source. Requires user approval before execution.",
      capabilities: ["connector_write", "connector_create"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.page.create"],
    }),
    agentAction({
      id: "notion.page.save_artifact",
      title: "Save artifact to Notion",
      agentToolName: "save_artifact_to_notion",
      description:
        "Save an artifact reference to a new Notion page in the authorized workspace selected by this connector. Requires user approval before execution.",
      capabilities: ["connector_write", "connector_create", "artifact"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.page.save_artifact"],
    }),
    agentAction({
      id: "notion.page.save_final_answer",
      title: "Save final answer to Notion",
      agentToolName: "save_final_answer_to_notion",
      description:
        "Save the final answer markdown to a new Notion page in the authorized workspace selected by this connector. Requires user approval before execution.",
      capabilities: ["connector_write", "connector_create"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.page.save_final_answer"],
    }),
    agentAction({
      id: "notion.page.append",
      title: "Append to Notion page",
      agentToolName: "append_notion_page",
      description:
        "Propose appending markdown content to an existing Notion page by page id.",
      capabilities: ["connector_write", "connector_append"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.page.append"],
    }),
    internalAction({
      id: "notion.page.update_properties",
      title: "Update Notion page properties",
      description:
        "Update properties on an existing Notion page. Intended for internal workflows.",
      capabilities: ["connector_write", "connector_update"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.page.update_properties"],
    }),
    agentAction({
      id: "notion.page.trash",
      title: "Move Notion page to trash",
      agentToolName: "delete_notion_page",
      description:
        "Move one or more existing Notion pages to trash by page ID. Use pageIds for batch deletion and whenever page titles are duplicated.",
      capabilities: ["connector_write", "connector_delete"],
      risk: "high",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.page.trash"],
    }),
    internalAction({
      id: "notion.comment.create",
      title: "Create Notion comment",
      description:
        "Create a Notion comment on a page or discussion. Intended for internal workflows.",
      capabilities: ["connector_write", "connector_comment"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.comment.create"],
    }),
    internalAction({
      id: "notion.data_source.query",
      title: "Query Notion data source",
      description:
        "Query a Notion data source. Intended for internal or future read workflows.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      inputSchema: notionActionInputSchemas["notion.data_source.query"],
    }),
    agentAction({
      id: "notion.page.find",
      title: "Find Notion page",
      agentToolName: "search_notion_pages",
      description:
        "Search Notion pages and return page IDs. Always pass query as non-empty page search text from the user's request, such as a title, keyword, or topic. Use this for discovery before reading, updating, or deleting when the user did not provide a page ID. If there is no searchable text, ask the user what page to find instead of calling this action with empty input.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      inputSchema: notionActionInputSchemas["notion.page.find"],
    }),
    agentAction({
      id: "notion.page.read",
      title: "Read Notion page",
      agentToolName: "read_notion_page",
      description:
        "Read a Notion page by page ID and return markdown content plus page metadata.",
      capabilities: ["connector_read"],
      risk: "low",
      requiresApproval: false,
      inputSchema: notionActionInputSchemas["notion.page.read"],
    }),
    agentAction({
      id: "notion.page.update",
      title: "Update Notion page",
      agentToolName: "update_notion_page",
      description:
        "Propose updating a Notion page by page ID. Supports appending markdown content, replacing top-level page content, and updating page properties.",
      capabilities: ["connector_write", "connector_update"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.page.update"],
    }),
    internalAction({
      id: "notion.file_upload.create",
      title: "Create Notion file upload",
      description:
        "Create a Notion file upload. Intended for internal file workflows.",
      capabilities: ["connector_write", "connector_upload"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.file_upload.create"],
    }),
    internalAction({
      id: "notion.file_upload.attach_to_page",
      title: "Attach Notion file upload to page",
      description:
        "Attach a Notion file upload to a page. Intended for internal file workflows.",
      capabilities: ["connector_write", "connector_upload"],
      risk: "medium",
      requiresApproval: true,
      inputSchema: notionActionInputSchemas["notion.file_upload.attach_to_page"],
    }),
  ],
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      includePages: { type: "boolean" },
    },
  },
} as const satisfies ConnectorContribution;

type ConnectorAction = ConnectorContribution["actions"][number];
type ActionInput = Omit<ConnectorAction, "visibility">;

function agentAction(input: ActionInput): ConnectorAction {
  return { ...input, visibility: "agent" };
}

function internalAction(input: ActionInput): ConnectorAction {
  return { ...input, visibility: "internal" };
}
