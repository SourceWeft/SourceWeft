import { tool } from "langchain";
import type { ToolRuntime } from "@langchain/core/tools";
import { AGENT_TOOL_NAMES } from "@sourceweft/contracts/agent-tools";
import { z } from "zod";
import type { ToolConfirmationRequest } from "@sourceweft/contracts";
import { connectorActionRunner, connectorRegistry } from "../..";
import {
  listSourceConnectorRecords,
  lookupConnectorSourceRecords,
} from "../../repository";
import { findSourceRecord } from "../../../content/sources/repository";
import { ConnectorError } from "../../errors";
import { connectorActionApprovalPayload } from "../../agent-tool-payload";
import { connectorToolResult } from "../../agent-tool-errors";
import {
  resolveConnectorActionExecutionRef,
  resolveConnectorActionToolIdempotencyKey,
  type ConnectorActionApprovalCursor,
  type ConnectorActionExecutionCursor,
} from "../../agent-tool-idempotency";
import type {
  ConnectorActionRunRecord,
  SourceConnectorRecord,
} from "../../types";

type NotionToolContext = {
  actionApprovalCursor?: ConnectorActionApprovalCursor;
  actionExecutionCursor?: ConnectorActionExecutionCursor;
  actionApprovalScope?: string;
  teamId: string;
  enabledToolNames?: ReadonlySet<string>;
  workspaceId: string;
  userId: string;
};

type NotionToolRuntime = ToolRuntime<unknown, Record<string, never>>;

function isToolEnabled(context: NotionToolContext, toolName: string) {
  return !context.enabledToolNames || context.enabledToolNames.has(toolName);
}

function compactRecord(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        !(typeof value === "string" && value.trim().length === 0),
    ),
  );
}

function compactString(value: string | undefined | null) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function listActiveNotionConnectors(input: NotionToolContext) {
  const connectors = await listSourceConnectorRecords({
    teamId: input.teamId,
    workspaceId: input.workspaceId,
  });
  return connectors.filter(
    (connector) =>
      connector.connectorType === "notion" && connector.status === "active",
  );
}

export async function hasActiveNotionConnector(input: NotionToolContext) {
  return (await listActiveNotionConnectors(input)).length > 0;
}

async function activeNotionConnector(input: NotionToolContext & {
  connectorId?: string;
}) {
  const notionConnectors = (await listActiveNotionConnectors(input)).filter(
    (connector) => !input.connectorId || connector.id === input.connectorId,
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

type NotionActionProposal = {
  action: ConnectorActionRunRecord;
  connector: SourceConnectorRecord;
  target?: {
    externalUri?: string | null;
    id?: string | null;
    label: string;
    type: string;
  };
};

function connectorActionToolOutput(input: {
  action: ConnectorActionRunRecord;
}) {
  if (input.action.status === "succeeded") {
    return input.action.resultJson ?? {
      ok: true,
      actionType: input.action.actionType,
    };
  }
  return {
    type: "connector_tool_error" as const,
    code: input.action.errorCode ?? "CONNECTOR_ACTION_FAILED",
    message: input.action.errorMessage ?? "Connector action failed.",
    statusCode: 400,
  };
}

async function proposeNotionAction(input: NotionToolContext & {
  connectorId?: string;
  actionType: string;
  agentToolName?: string;
  requestJson: Record<string, unknown>;
  requestPreview: string;
  idempotencyKey?: string;
}): Promise<NotionActionProposal> {
  const connector = await activeNotionConnector(input);
  const result = await connectorActionRunner.propose({
    workspaceId: input.workspaceId,
    userId: input.userId,
    connectorId: connector.id,
    actionType: input.actionType,
    agentToolName: input.agentToolName,
    requestJson: input.requestJson,
    requestPreview: input.requestPreview,
    idempotencyKey: input.idempotencyKey,
  });
  return { action: result.action, connector };
}

type NotionCreateTarget = {
  dataSourceId?: string;
  externalUri?: string | null;
  label: string;
  pageId?: string;
  sourceId?: string;
  targetHint?: string;
  type: "notion_private" | "notion_page" | "notion_data_source";
};

async function resolveNotionCreateTarget(input: NotionToolContext & {
  connectorId: string;
  dataSourceId?: string;
  pageId?: string;
  sourceId?: string;
  targetHint?: string;
}): Promise<NotionCreateTarget> {
  const dataSourceId = compactString(input.dataSourceId);
  if (dataSourceId) {
    return {
      dataSourceId,
      label: `Notion data source ${dataSourceId}`,
      targetHint: compactString(input.targetHint),
      type: "notion_data_source",
    };
  }

  const pageId = compactString(input.pageId);
  if (pageId) {
    return {
      pageId,
      label: `Notion page ${pageId}`,
      targetHint: compactString(input.targetHint),
      type: "notion_page",
    };
  }

  const sourceId = compactString(input.sourceId);
  if (sourceId) {
    const page = await findSourceRecord({
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      sourceId,
    });
    if (
      page?.connectorId !== input.connectorId ||
      page.metadata.connectorType !== "notion"
    ) {
      throw new ConnectorError(
        400,
        "NOTION_TARGET_NOT_FOUND",
        "The provided sourceId does not resolve to an indexed Notion page.",
      );
    }
    const resolvedPageId = pageIdFromExternalId(page?.externalId ?? null);
    if (resolvedPageId) {
      return {
        externalUri: page?.externalUri ?? null,
        label: page?.title ?? `Notion page ${resolvedPageId}`,
        pageId: resolvedPageId,
        sourceId,
        targetHint: compactString(input.targetHint),
        type: "notion_page",
      };
    }
    throw new ConnectorError(
      400,
      "NOTION_TARGET_NOT_FOUND",
      "The provided sourceId does not resolve to an indexed Notion page.",
    );
  }

  return {
    label: "Private page in Notion workspace",
    targetHint: compactString(input.targetHint),
    type: "notion_private",
  };
}

async function proposeNotionCreatePageAction(input: NotionToolContext & {
  connectorId?: string;
  agentToolName?: string;
  title: string;
  content: string;
  dataSourceId?: string;
  pageId?: string;
  requestPreview: string;
  sourceId?: string;
  targetHint?: string;
  idempotencyKey?: string;
}): Promise<NotionActionProposal> {
  const connector = await activeNotionConnector(input);
  const target = await resolveNotionCreateTarget({
    ...input,
    connectorId: connector.id,
  });
  const requestJson = compactRecord({
    title: input.title,
    content: input.content,
    parentPageId: target.pageId,
    dataSourceId: target.dataSourceId,
    sourceId: target.sourceId,
    targetHint: target.targetHint,
  });
  const result = await connectorActionRunner.propose({
    workspaceId: input.workspaceId,
    userId: input.userId,
    connectorId: connector.id,
    actionType: "notion.page.create",
    agentToolName: input.agentToolName,
    requestJson,
    requestPreview: input.requestPreview,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    action: result.action,
    connector,
    target: {
      externalUri: target.externalUri,
      id: target.pageId ?? target.dataSourceId ?? target.sourceId ?? null,
      label: target.label,
      type: target.type,
    },
  };
}

function approvalPayloadFromProposal(input: {
  agentToolName?: string;
  proposal: NotionActionProposal;
}) {
  return connectorActionApprovalPayload({
    action: input.proposal.action,
    agentToolName: input.agentToolName,
    connector: input.proposal.connector,
    target: input.proposal.target,
  });
}

async function executeNotionProposal(input: {
  context: NotionToolContext;
  proposal: NotionActionProposal;
}) {
  const executed = await connectorActionRunner.execute({
    workspaceId: input.context.workspaceId,
    userId: input.context.userId,
    connectorId: input.proposal.connector.id,
    actionRunId: input.proposal.action.id,
  });
  return connectorActionToolOutput({ action: executed.action });
}

async function executeApprovedNotionAction(input: {
  actionRunId: string;
  connectorId: string;
  context: NotionToolContext;
}) {
  const executed = await connectorActionRunner.execute({
    workspaceId: input.context.workspaceId,
    userId: input.context.userId,
    connectorId: input.connectorId,
    actionRunId: input.actionRunId,
  });
  return connectorActionToolOutput({ action: executed.action });
}

function notionToolCallId(runtime: NotionToolRuntime) {
  return runtime.toolCall?.id ?? undefined;
}

function notionActionIdempotencyKey(input: {
  context: NotionToolContext;
  runtime?: NotionToolRuntime;
  toolName: string;
}) {
  return resolveConnectorActionToolIdempotencyKey(input.context, {
    fallback: input.runtime ? notionToolCallId(input.runtime) : undefined,
    toolName: input.toolName,
  });
}

function notionActionExecutionRef(input: {
  connectorId?: string;
  context: NotionToolContext;
  toolName: string;
}) {
  return resolveConnectorActionExecutionRef(input.context, {
    connectorId: input.connectorId,
    toolName: input.toolName,
  });
}

function pageIdFromExternalId(value: string | null) {
  return value?.startsWith("page:") ? value.slice("page:".length) : null;
}

function stripConnectorId(args: Record<string, unknown>) {
  const { connectorId: _connectorId, ...requestJson } = args;
  return requestJson;
}

export async function createNotionToolApprovalRequest(
  context: NotionToolContext,
  input: {
    args: Record<string, unknown>;
    toolCallId: string;
    toolName: string;
  },
): Promise<ToolConfirmationRequest | null> {
  switch (input.toolName) {
    case AGENT_TOOL_NAMES.createNotionPage: {
      const proposal = await proposeNotionCreatePageAction({
        ...context,
        connectorId:
          typeof input.args.connectorId === "string"
            ? input.args.connectorId
            : undefined,
        title: typeof input.args.title === "string" ? input.args.title : "",
        content:
          typeof input.args.content === "string" ? input.args.content : "",
        pageId:
          typeof input.args.pageId === "string" ? input.args.pageId : undefined,
        sourceId:
          typeof input.args.sourceId === "string"
            ? input.args.sourceId
            : undefined,
        targetHint:
          typeof input.args.targetHint === "string"
            ? input.args.targetHint
            : undefined,
        dataSourceId:
          typeof input.args.dataSourceId === "string"
            ? input.args.dataSourceId
            : undefined,
        agentToolName: AGENT_TOOL_NAMES.createNotionPage,
        requestPreview: `Create Notion page: ${
          typeof input.args.title === "string" ? input.args.title : ""
        }`,
        idempotencyKey: notionActionIdempotencyKey({
          context,
          toolName: input.toolName,
        }),
      });
      return approvalPayloadFromProposal({
        agentToolName: AGENT_TOOL_NAMES.createNotionPage,
        proposal,
      });
    }
    case AGENT_TOOL_NAMES.appendNotionPage: {
      const requestArgs = stripConnectorId(input.args);
      const proposal = await proposeNotionAction({
        ...context,
        connectorId:
          typeof input.args.connectorId === "string"
            ? input.args.connectorId
            : undefined,
        actionType: "notion.page.append",
        agentToolName: AGENT_TOOL_NAMES.appendNotionPage,
        requestJson: requestArgs,
        requestPreview: `Append to Notion page: ${
          typeof input.args.pageId === "string" ? input.args.pageId : ""
        }`,
        idempotencyKey: notionActionIdempotencyKey({
          context,
          toolName: input.toolName,
        }),
      });
      return approvalPayloadFromProposal({
        agentToolName: AGENT_TOOL_NAMES.appendNotionPage,
        proposal,
      });
    }
    case AGENT_TOOL_NAMES.updateNotionPageByTitle: {
      const requestArgs = stripConnectorId(input.args);
      const proposal = await proposeNotionAction({
        ...context,
        connectorId:
          typeof input.args.connectorId === "string"
            ? input.args.connectorId
            : undefined,
        actionType: "notion.page.update_by_title",
        agentToolName: AGENT_TOOL_NAMES.updateNotionPageByTitle,
        requestJson: requestArgs,
        requestPreview: `Update Notion page by title: ${
          typeof input.args.title === "string" ? input.args.title : ""
        }`,
        idempotencyKey: notionActionIdempotencyKey({
          context,
          toolName: input.toolName,
        }),
      });
      return approvalPayloadFromProposal({
        agentToolName: AGENT_TOOL_NAMES.updateNotionPageByTitle,
        proposal,
      });
    }
    case AGENT_TOOL_NAMES.deleteNotionPageByTitle: {
      const requestArgs = stripConnectorId(input.args);
      const proposal = await proposeNotionAction({
        ...context,
        connectorId:
          typeof input.args.connectorId === "string"
            ? input.args.connectorId
            : undefined,
        actionType: "notion.page.trash_by_title",
        agentToolName: AGENT_TOOL_NAMES.deleteNotionPageByTitle,
        requestJson: requestArgs,
        requestPreview: `Move Notion page to trash: ${
          typeof input.args.title === "string" ? input.args.title : ""
        }`,
        idempotencyKey: notionActionIdempotencyKey({
          context,
          toolName: input.toolName,
        }),
      });
      return approvalPayloadFromProposal({
        agentToolName: AGENT_TOOL_NAMES.deleteNotionPageByTitle,
        proposal,
      });
    }
    case AGENT_TOOL_NAMES.saveFinalAnswerToNotion: {
      const proposal = await proposeNotionCreatePageAction({
        ...context,
        connectorId:
          typeof input.args.connectorId === "string"
            ? input.args.connectorId
            : undefined,
        title: typeof input.args.title === "string" ? input.args.title : "",
        content:
          typeof input.args.content === "string" ? input.args.content : "",
        agentToolName: AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
        requestPreview: `Save final answer to Notion: ${
          typeof input.args.title === "string" ? input.args.title : ""
        }`,
        idempotencyKey: notionActionIdempotencyKey({
          context,
          toolName: input.toolName,
        }),
      });
      return approvalPayloadFromProposal({
        agentToolName: AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
        proposal,
      });
    }
    case AGENT_TOOL_NAMES.saveArtifactToNotion: {
      const artifactId =
        typeof input.args.artifactId === "string" ? input.args.artifactId : "";
      const artifactUrl =
        typeof input.args.artifactUrl === "string"
          ? input.args.artifactUrl
          : undefined;
      const proposal = await proposeNotionCreatePageAction({
        ...context,
        connectorId:
          typeof input.args.connectorId === "string"
            ? input.args.connectorId
            : undefined,
        title: typeof input.args.title === "string" ? input.args.title : "",
        agentToolName: AGENT_TOOL_NAMES.saveArtifactToNotion,
        content: artifactUrl
          ? `[Artifact ${artifactId}](${artifactUrl})`
          : `Artifact: ${artifactId}`,
        requestPreview: `Save artifact to Notion: ${
          typeof input.args.title === "string" ? input.args.title : ""
        }`,
        idempotencyKey: notionActionIdempotencyKey({
          context,
          toolName: input.toolName,
        }),
      });
      return approvalPayloadFromProposal({
        agentToolName: AGENT_TOOL_NAMES.saveArtifactToNotion,
        proposal,
      });
    }
    default:
      return null;
  }
}

function notionActionArgsSchema(toolName: string) {
  const manifest = connectorRegistry.getManifest("notion");
  const action = manifest.actions.find(
    (candidate) => candidate.agentToolName === toolName,
  );
  return action?.inputSchema;
}

export function createNotionInterruptConfig(toolName: string) {
  const editable =
    toolName === AGENT_TOOL_NAMES.appendNotionPage ||
    toolName === AGENT_TOOL_NAMES.updateNotionPageByTitle;
  const allowedDecisions: Array<"approve" | "edit" | "reject"> = editable
    ? ["approve", "edit", "reject"]
    : ["approve", "reject"];
  return {
    allowedDecisions,
    description: `Review Notion action before execution: ${toolName}`,
    ...(notionActionArgsSchema(toolName)
      ? { argsSchema: notionActionArgsSchema(toolName) }
      : {}),
  };
}

export function createNotionTools(context: NotionToolContext) {
  const tools = [];
  if (isToolEnabled(context, AGENT_TOOL_NAMES.searchNotionPages)) {
    tools.push(tool(
      async ({ query, connectorId }: { query: string; connectorId?: string }) =>
        connectorToolResult(
          async () => {
            const searchQuery = compactString(query);
            if (!searchQuery) {
              return "Enter a Notion page title keyword to search.";
            }
            const connector = await activeNotionConnector({
              ...context,
              connectorId,
            });
            const pages = await lookupConnectorSourceRecords({
              teamId: context.teamId,
              workspaceId: context.workspaceId,
              connectorType: "notion",
              connectorId: connector.id,
              fuzzyTitle: searchQuery,
              limit: 10,
            });
            if (pages.length === 0) {
              return "No indexed Notion pages matched. Sync Notion or try a different keyword.";
            }
            return pages
              .map(
                (page) =>
                  `- ${page.title} (${page.externalUri ?? "no url"}) sourceId=${page.id} pageId=${pageIdFromExternalId(page.externalId) ?? "unknown"}`,
              )
              .join("\n");
          },
          {
            connectorType: "notion",
            toolName: AGENT_TOOL_NAMES.searchNotionPages,
          },
        ),
      {
        name: AGENT_TOOL_NAMES.searchNotionPages,
        description:
          "Search indexed Notion pages by fuzzy title keyword. Use before updating or deleting a Notion page by title.",
        schema: z.object({
          query: z.string().min(1),
          connectorId: z.string().optional(),
        }),
      },
    ));
  }
  if (isToolEnabled(context, AGENT_TOOL_NAMES.createNotionPage)) {
    tools.push(tool(
      async (args: {
        title: string;
        content: string;
        pageId?: string;
        sourceId?: string;
        targetHint?: string;
        dataSourceId?: string;
        connectorId?: string;
      }, runtime: NotionToolRuntime) =>
        connectorToolResult(
          async () => {
            const executionRef = notionActionExecutionRef({
              context,
              connectorId: args.connectorId,
              toolName: AGENT_TOOL_NAMES.createNotionPage,
            });
            if (executionRef) {
              return executeApprovedNotionAction({
                context,
                connectorId: executionRef.connectorId,
                actionRunId: executionRef.actionRunId,
              });
            }
            const proposal = await proposeNotionCreatePageAction({
              ...context,
              connectorId: args.connectorId,
              title: args.title,
              content: args.content,
              pageId: args.pageId,
              sourceId: args.sourceId,
              targetHint: args.targetHint,
              dataSourceId: args.dataSourceId,
              agentToolName: AGENT_TOOL_NAMES.createNotionPage,
              requestPreview: `Create Notion page: ${args.title}`,
              idempotencyKey: notionActionIdempotencyKey({
                context,
                runtime,
                toolName: AGENT_TOOL_NAMES.createNotionPage,
              }),
            });
            return executeNotionProposal({ context, proposal });
          },
          {
            connectorType: "notion",
            toolName: AGENT_TOOL_NAMES.createNotionPage,
          },
        ),
      {
        name: AGENT_TOOL_NAMES.createNotionPage,
        description:
          "Propose creating a Notion page. Requires user approval before execution. By default this creates a private Notion workspace page; optionally pass a SourceWeft sourceId, Notion pageId, or dataSourceId when the user explicitly named a target.",
        schema: z.object({
          title: z.string().min(1),
          content: z.string().min(1),
          targetHint: z.string().optional(),
          sourceId: z.string().optional(),
          pageId: z.string().optional(),
          dataSourceId: z.string().optional(),
          connectorId: z.string().optional(),
        }),
      },
    ));
  }
  if (isToolEnabled(context, AGENT_TOOL_NAMES.appendNotionPage)) {
    tools.push(tool(
      async (
        args: { pageId: string; content: string; connectorId?: string },
        runtime: NotionToolRuntime,
      ) =>
        connectorToolResult(
          async () => {
            const executionRef = notionActionExecutionRef({
              context,
              connectorId: args.connectorId,
              toolName: AGENT_TOOL_NAMES.appendNotionPage,
            });
            if (executionRef) {
              return executeApprovedNotionAction({
                context,
                connectorId: executionRef.connectorId,
                actionRunId: executionRef.actionRunId,
              });
            }
            const proposal = await proposeNotionAction({
              ...context,
              connectorId: args.connectorId,
              actionType: "notion.page.append",
              agentToolName: AGENT_TOOL_NAMES.appendNotionPage,
              requestJson: { pageId: args.pageId, content: args.content },
              requestPreview: `Append to Notion page: ${args.pageId}`,
              idempotencyKey: notionActionIdempotencyKey({
                context,
                runtime,
                toolName: AGENT_TOOL_NAMES.appendNotionPage,
              }),
            });
            return executeNotionProposal({ context, proposal });
          },
          {
            connectorType: "notion",
            toolName: AGENT_TOOL_NAMES.appendNotionPage,
          },
        ),
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
    ));
  }
  if (isToolEnabled(context, AGENT_TOOL_NAMES.updateNotionPageByTitle)) {
    tools.push(tool(
      async (
        args: { title: string; content: string; connectorId?: string },
        runtime: NotionToolRuntime,
      ) =>
        connectorToolResult(
          async () => {
            const executionRef = notionActionExecutionRef({
              context,
              connectorId: args.connectorId,
              toolName: AGENT_TOOL_NAMES.updateNotionPageByTitle,
            });
            if (executionRef) {
              return executeApprovedNotionAction({
                context,
                connectorId: executionRef.connectorId,
                actionRunId: executionRef.actionRunId,
              });
            }
            const proposal = await proposeNotionAction({
              ...context,
              connectorId: args.connectorId,
              actionType: "notion.page.update_by_title",
              agentToolName: AGENT_TOOL_NAMES.updateNotionPageByTitle,
              requestJson: { title: args.title, content: args.content },
              requestPreview: `Update Notion page by title: ${args.title}`,
              idempotencyKey: notionActionIdempotencyKey({
                context,
                runtime,
                toolName: AGENT_TOOL_NAMES.updateNotionPageByTitle,
              }),
            });
            return executeNotionProposal({ context, proposal });
          },
          {
            connectorType: "notion",
            toolName: AGENT_TOOL_NAMES.updateNotionPageByTitle,
          },
        ),
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
    ));
  }
  if (isToolEnabled(context, AGENT_TOOL_NAMES.deleteNotionPageByTitle)) {
    tools.push(tool(
      async (args: {
        title: string;
        deleteFromKnowledgeBase?: boolean;
        connectorId?: string;
      }, runtime: NotionToolRuntime) =>
        connectorToolResult(
          async () => {
            const executionRef = notionActionExecutionRef({
              context,
              connectorId: args.connectorId,
              toolName: AGENT_TOOL_NAMES.deleteNotionPageByTitle,
            });
            if (executionRef) {
              return executeApprovedNotionAction({
                context,
                connectorId: executionRef.connectorId,
                actionRunId: executionRef.actionRunId,
              });
            }
            const proposal = await proposeNotionAction({
              ...context,
              connectorId: args.connectorId,
              actionType: "notion.page.trash_by_title",
              agentToolName: AGENT_TOOL_NAMES.deleteNotionPageByTitle,
              requestJson: compactRecord({
                title: args.title,
                deleteFromKnowledgeBase: args.deleteFromKnowledgeBase,
              }),
              requestPreview: `Move Notion page to trash: ${args.title}`,
              idempotencyKey: notionActionIdempotencyKey({
                context,
                runtime,
                toolName: AGENT_TOOL_NAMES.deleteNotionPageByTitle,
              }),
            });
            return executeNotionProposal({ context, proposal });
          },
          {
            connectorType: "notion",
            toolName: AGENT_TOOL_NAMES.deleteNotionPageByTitle,
          },
        ),
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
    ));
  }
  if (isToolEnabled(context, AGENT_TOOL_NAMES.saveFinalAnswerToNotion)) {
    tools.push(tool(
      async (
        args: { title: string; content: string; connectorId?: string },
        runtime: NotionToolRuntime,
      ) =>
        connectorToolResult(
          async () => {
            const executionRef = notionActionExecutionRef({
              context,
              connectorId: args.connectorId,
              toolName: AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
            });
            if (executionRef) {
              return executeApprovedNotionAction({
                context,
                connectorId: executionRef.connectorId,
                actionRunId: executionRef.actionRunId,
              });
            }
            const proposal = await proposeNotionCreatePageAction({
              ...context,
              connectorId: args.connectorId,
              title: args.title,
              content: args.content,
              agentToolName: AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
              requestPreview: `Save final answer to Notion: ${args.title}`,
              idempotencyKey: notionActionIdempotencyKey({
                context,
                runtime,
                toolName: AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
              }),
            });
            return executeNotionProposal({ context, proposal });
          },
          {
            connectorType: "notion",
            toolName: AGENT_TOOL_NAMES.saveFinalAnswerToNotion,
          },
        ),
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
    ));
  }
  if (isToolEnabled(context, AGENT_TOOL_NAMES.saveArtifactToNotion)) {
    tools.push(tool(
      async (args: {
        title: string;
        artifactId: string;
        artifactUrl?: string;
        connectorId?: string;
      }, runtime: NotionToolRuntime) =>
        connectorToolResult(
          async () => {
            const executionRef = notionActionExecutionRef({
              context,
              connectorId: args.connectorId,
              toolName: AGENT_TOOL_NAMES.saveArtifactToNotion,
            });
            if (executionRef) {
              return executeApprovedNotionAction({
                context,
                connectorId: executionRef.connectorId,
                actionRunId: executionRef.actionRunId,
              });
            }
            const proposal = await proposeNotionCreatePageAction({
              ...context,
              connectorId: args.connectorId,
              title: args.title,
              agentToolName: AGENT_TOOL_NAMES.saveArtifactToNotion,
              content: args.artifactUrl
                ? `[Artifact ${args.artifactId}](${args.artifactUrl})`
                : `Artifact: ${args.artifactId}`,
              requestPreview: `Save artifact to Notion: ${args.title}`,
              idempotencyKey: notionActionIdempotencyKey({
                context,
                runtime,
                toolName: AGENT_TOOL_NAMES.saveArtifactToNotion,
              }),
            });
            return executeNotionProposal({ context, proposal });
          },
          {
            connectorType: "notion",
            toolName: AGENT_TOOL_NAMES.saveArtifactToNotion,
          },
        ),
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
    ));
  }
  return tools;
}
