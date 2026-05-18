import { tool } from "langchain";
import { z } from "zod";
import { connectorActionRunner } from "../../../connectors";
import {
  listSourceConnectorRecords,
  lookupConnectorSourceRecords,
} from "../../../connectors/repository";
import { ConnectorError } from "../../../connectors/errors";
import { AGENT_TOOL_NAMES } from "../tool-names";

type NotionToolContext = {
  teamId: string;
  workspaceId: string;
  userId: string;
};

async function activeNotionConnector(input: NotionToolContext & {
  connectorId?: string;
}) {
  const connectors = await listSourceConnectorRecords({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
  });
  const notionConnectors = connectors.filter(
    (connector) =>
      connector.connectorType === "notion" &&
      connector.status === "active" &&
      (!input.connectorId || connector.id === input.connectorId),
  );
  if (notionConnectors.length === 0) {
    throw new ConnectorError(
      404,
      "NOTION_CONNECTOR_NOT_FOUND",
      "No active Notion connector is available. Connect and sync Notion first.",
    );
  }
  return notionConnectors[0]!;
}

async function proposeNotionAction(input: NotionToolContext & {
  connectorId?: string;
  actionType: string;
  requestJson: Record<string, unknown>;
  requestPreview: string;
}) {
  const connector = await activeNotionConnector(input);
  const result = await connectorActionRunner.propose({
    workspaceId: input.workspaceId,
    userId: input.userId,
    connectorId: connector.id,
    actionType: input.actionType,
    requestJson: input.requestJson,
    requestPreview: input.requestPreview,
  });
  return `Notion action proposed and waiting for approval: ${result.action.id}`;
}

function pageIdFromExternalId(value: string | null) {
  return value?.startsWith("page:") ? value.slice("page:".length) : null;
}

export function createNotionTools(context: NotionToolContext) {
  return [
    tool(
      async ({ query, connectorId }: { query: string; connectorId?: string }) => {
        const connector = await activeNotionConnector({ ...context, connectorId });
        const pages = await lookupConnectorSourceRecords({
          teamId: context.teamId,
          workspaceId: context.workspaceId,
          connectorType: "notion",
          connectorId: connector.id,
          title: query,
          limit: 10,
        });
        if (pages.length === 0) {
          return "No indexed Notion pages matched. Sync Notion or use the exact page title.";
        }
        return pages
          .map(
            (page) =>
              `- ${page.title} (${page.externalUri ?? "no url"}) sourceId=${page.id} pageId=${pageIdFromExternalId(page.externalId) ?? "unknown"}`,
          )
          .join("\n");
      },
      {
        name: AGENT_TOOL_NAMES.searchNotionPages,
        description:
          "Search indexed Notion pages by exact title. Use before updating or deleting a Notion page by title.",
        schema: z.object({
          query: z.string().min(1),
          connectorId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: {
        title: string;
        content: string;
        parentPageId?: string;
        dataSourceId?: string;
        connectorId?: string;
      }) =>
        proposeNotionAction({
          ...context,
          connectorId: args.connectorId,
          actionType: "notion.page.create",
          requestJson: {
            title: args.title,
            content: args.content,
            parentPageId: args.parentPageId,
            dataSourceId: args.dataSourceId,
          },
          requestPreview: `Create Notion page: ${args.title}`,
        }),
      {
        name: AGENT_TOOL_NAMES.createNotionPage,
        description:
          "Propose creating a Notion page. This requires user approval before execution.",
        schema: z.object({
          title: z.string().min(1),
          content: z.string().min(1),
          parentPageId: z.string().optional(),
          dataSourceId: z.string().optional(),
          connectorId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: { pageId: string; content: string; connectorId?: string }) =>
        proposeNotionAction({
          ...context,
          connectorId: args.connectorId,
          actionType: "notion.page.append",
          requestJson: { pageId: args.pageId, content: args.content },
          requestPreview: `Append to Notion page: ${args.pageId}`,
        }),
      {
        name: AGENT_TOOL_NAMES.appendNotionPage,
        description:
          "Propose appending markdown content to an existing Notion page by page id.",
        schema: z.object({
          pageId: z.string().min(1),
          content: z.string().min(1),
          connectorId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: { title: string; content: string; connectorId?: string }) =>
        proposeNotionAction({
          ...context,
          connectorId: args.connectorId,
          actionType: "notion.page.update_by_title",
          requestJson: { title: args.title, content: args.content },
          requestPreview: `Update Notion page by title: ${args.title}`,
        }),
      {
        name: AGENT_TOOL_NAMES.updateNotionPageByTitle,
        description:
          "Propose updating a synced Notion page by exact title. Use search_notion_pages first when uncertain.",
        schema: z.object({
          title: z.string().min(1),
          content: z.string().min(1),
          connectorId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: {
        title: string;
        deleteFromKnowledgeBase?: boolean;
        connectorId?: string;
      }) =>
        proposeNotionAction({
          ...context,
          connectorId: args.connectorId,
          actionType: "notion.page.trash_by_title",
          requestJson: {
            title: args.title,
            deleteFromKnowledgeBase: args.deleteFromKnowledgeBase,
          },
          requestPreview: `Move Notion page to trash: ${args.title}`,
        }),
      {
        name: AGENT_TOOL_NAMES.deleteNotionPageByTitle,
        description:
          "Propose moving a Notion page to trash by exact title. Use search_notion_pages first when uncertain.",
        schema: z.object({
          title: z.string().min(1),
          deleteFromKnowledgeBase: z.boolean().optional(),
          connectorId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: { title: string; content: string; connectorId?: string }) =>
        proposeNotionAction({
          ...context,
          connectorId: args.connectorId,
          actionType: "notion.page.create",
          requestJson: { title: args.title, content: args.content },
          requestPreview: `Save final answer to Notion: ${args.title}`,
        }),
      {
        name: AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
        description:
          "Propose saving final answer markdown to a new Notion page. This requires approval.",
        schema: z.object({
          title: z.string().min(1),
          content: z.string().min(1),
          connectorId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (args: {
        title: string;
        artifactId: string;
        artifactUrl?: string;
        connectorId?: string;
      }) =>
        proposeNotionAction({
          ...context,
          connectorId: args.connectorId,
          actionType: "notion.page.create",
          requestJson: {
            title: args.title,
            content: args.artifactUrl
              ? `[Artifact ${args.artifactId}](${args.artifactUrl})`
              : `Artifact: ${args.artifactId}`,
          },
          requestPreview: `Save artifact to Notion: ${args.title}`,
        }),
      {
        name: AGENT_TOOL_NAMES.saveArtifactToNotion,
        description:
          "Propose saving an artifact reference to a new Notion page. Binary upload can be completed after approval using file upload actions.",
        schema: z.object({
          title: z.string().min(1),
          artifactId: z.string().min(1),
          artifactUrl: z.string().optional(),
          connectorId: z.string().optional(),
        }),
      },
    ),
  ];
}
