import { createHash } from "node:crypto";
import { config } from "../../../shared/config";
import { ConnectorError } from "../errors";
import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorDiscoverInput,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorItem,
  ConnectorManifest,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
} from "../types";

const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_AUTHORIZATION_URL = "https://www.notion.so/install-integration";
const NOTION_TOKEN_URL = `${NOTION_API_BASE_URL}/oauth/token`;
const DEFAULT_NOTION_VERSION = "2026-03-11";

function getNotionRedirectUri() {
  const configured = process.env.NOTION_REDIRECT_URI?.trim();
  if (configured) {
    return configured;
  }
  return `${config.auth.baseUrl}/v1/connectors/oauth/notion/callback`;
}

type NotionRichText = Array<{
  plain_text?: string;
  href?: string | null;
  text?: { content?: string; link?: { url?: string } | null };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
}>;

type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

type NotionPage = {
  object: "page";
  id: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: Record<string, unknown>;
  properties?: Record<string, unknown>;
};

type NotionDataSource = {
  object: string;
  id: string;
  title?: NotionRichText;
  description?: NotionRichText;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
};

type NotionSearchResult = NotionPage | NotionDataSource | Record<string, unknown>;

type NotionListResponse<T> = {
  results: T[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type NotionTokenResponse = {
  access_token?: string;
  refresh_token?: string | null;
  token_type?: string;
  expires_in?: number;
  workspace_id?: string;
  workspace_name?: string;
  workspace_icon?: string | null;
  owner?: unknown;
  bot_id?: string;
  duplicated_template_id?: string | null;
};

type NotionErrorResponse = {
  object?: "error";
  status?: number;
  code?: string;
  message?: string;
};

const jsonObjectSchema = { type: "object", additionalProperties: true };

const actionInputSchemas: Record<string, Record<string, unknown>> = {
  "notion.page.create": {
    type: "object",
    required: ["title", "content"],
    additionalProperties: true,
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      parentPageId: { type: "string" },
      dataSourceId: { type: "string" },
    },
  },
  "notion.page.append": {
    type: "object",
    required: ["pageId", "content"],
    additionalProperties: true,
    properties: {
      pageId: { type: "string" },
      content: { type: "string" },
    },
  },
  "notion.page.update_properties": {
    type: "object",
    required: ["pageId", "properties"],
    additionalProperties: true,
    properties: {
      pageId: { type: "string" },
      properties: { type: "object" },
    },
  },
  "notion.page.trash": {
    type: "object",
    required: ["pageId"],
    additionalProperties: false,
    properties: {
      pageId: { type: "string" },
    },
  },
  "notion.comment.create": {
    type: "object",
    required: ["richText"],
    additionalProperties: true,
    properties: {
      pageId: { type: "string" },
      discussionId: { type: "string" },
      richText: { type: "string" },
    },
  },
  "notion.data_source.query": {
    type: "object",
    required: ["dataSourceId"],
    additionalProperties: true,
    properties: {
      dataSourceId: { type: "string" },
      filter: { type: "object" },
      sorts: { type: "array" },
    },
  },
};

const notionManifest: ConnectorManifest = {
  type: "notion",
  displayName: "Notion",
  auth: {
    kind: "oauth2",
    authorizationUrl: NOTION_AUTHORIZATION_URL,
    tokenUrl: NOTION_TOKEN_URL,
    scopes: [],
    redirectUri: getNotionRedirectUri(),
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
        displayName: "Notion page",
        supportsDeleteDetection: false,
      },
      {
        type: "notion_data_source",
        displayName: "Notion data source",
        supportsDeleteDetection: false,
      },
      {
        type: "notion_database",
        displayName: "Notion database",
        supportsDeleteDetection: false,
      },
    ],
  },
  actions: [
    {
      type: "notion.page.create",
      displayName: "Create Notion page",
      riskLevel: "medium",
      requiresApproval: true,
      inputSchema: actionInputSchemas["notion.page.create"] ?? jsonObjectSchema,
    },
    {
      type: "notion.page.append",
      displayName: "Append to Notion page",
      riskLevel: "medium",
      requiresApproval: true,
      inputSchema: actionInputSchemas["notion.page.append"] ?? jsonObjectSchema,
    },
    {
      type: "notion.page.update_properties",
      displayName: "Update Notion page properties",
      riskLevel: "medium",
      requiresApproval: true,
      inputSchema:
        actionInputSchemas["notion.page.update_properties"] ?? jsonObjectSchema,
    },
    {
      type: "notion.page.trash",
      displayName: "Move Notion page to trash",
      riskLevel: "high",
      requiresApproval: true,
      inputSchema: actionInputSchemas["notion.page.trash"] ?? jsonObjectSchema,
    },
    {
      type: "notion.comment.create",
      displayName: "Create Notion comment",
      riskLevel: "medium",
      requiresApproval: true,
      inputSchema: actionInputSchemas["notion.comment.create"] ?? jsonObjectSchema,
    },
    {
      type: "notion.data_source.query",
      displayName: "Query Notion data source",
      riskLevel: "low",
      requiresApproval: false,
      inputSchema:
        actionInputSchemas["notion.data_source.query"] ?? jsonObjectSchema,
    },
  ],
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      includePages: { type: "boolean" },
      includeDataSources: { type: "boolean" },
      includeDatabases: { type: "boolean" },
      rootPageIds: { type: "array" },
      defaultParentPageId: { type: "string" },
      notionApiVersion: { type: "string" },
    },
  },
};

function getNotionClientId() {
  const value = process.env.NOTION_CLIENT_ID?.trim();
  if (!value) {
    throw new ConnectorError(
      500,
      "NOTION_CLIENT_ID_MISSING",
      "NOTION_CLIENT_ID is required for Notion connector OAuth",
    );
  }
  return value;
}

function getNotionClientSecret() {
  const value = process.env.NOTION_CLIENT_SECRET?.trim();
  if (!value) {
    throw new ConnectorError(
      500,
      "NOTION_CLIENT_SECRET_MISSING",
      "NOTION_CLIENT_SECRET is required for Notion connector OAuth",
    );
  }
  return value;
}

function getNotionVersion(configJson?: Record<string, unknown>) {
  const configured =
    typeof configJson?.notionApiVersion === "string"
      ? configJson.notionApiVersion.trim()
      : "";
  return (
    configured ||
    process.env.NOTION_API_VERSION?.trim() ||
    DEFAULT_NOTION_VERSION
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getRequestString(
  request: Record<string, unknown>,
  key: string,
  required = true,
) {
  const value = asString(request[key]).trim();
  if (!value && required) {
    throw new ConnectorError(
      400,
      "NOTION_ACTION_INPUT_INVALID",
      `requestJson.${key} is required`,
    );
  }
  return value;
}

function computeHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeNotionId(value: string) {
  return value.trim().replace(/-/g, "");
}

function buildNotionUri(id: string, fallback?: string | null) {
  return fallback || `https://www.notion.so/${normalizeNotionId(id)}`;
}

function richTextToPlainText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return (value as NotionRichText)
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("");
}

function richTextToMarkdown(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return (value as NotionRichText)
    .map((item) => {
      let text = item.plain_text ?? item.text?.content ?? "";
      if (!text) {
        return "";
      }
      const href = item.href ?? item.text?.link?.url;
      if (item.annotations?.code) text = `\`${text}\``;
      if (item.annotations?.bold) text = `**${text}**`;
      if (item.annotations?.italic) text = `_${text}_`;
      if (item.annotations?.strikethrough) text = `~~${text}~~`;
      if (href) text = `[${text}](${href})`;
      return text;
    })
    .join("");
}

function findPageTitle(page: NotionPage) {
  for (const property of Object.values(page.properties ?? {})) {
    const record = asRecord(property);
    if (record.type === "title") {
      const title = richTextToPlainText(record.title);
      if (title.trim()) {
        return title.trim();
      }
    }
  }
  return "Untitled Notion Page";
}

function findDataSourceTitle(value: NotionDataSource) {
  const title = richTextToPlainText(value.title);
  return title.trim() || "Untitled Notion Data Source";
}

function parseDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNotionItem(value: NotionSearchResult): ConnectorItem | null {
  const object = asString(value.object);
  const id = asString(value.id);
  if (!id) {
    return null;
  }

  if (object === "page") {
    const page = value as NotionPage;
    const title = findPageTitle(page);
    return {
      externalId: `page:${page.id}`,
      externalUri: buildNotionUri(page.id, page.url),
      title,
      mimeType: "text/markdown",
      sizeBytes: null,
      externalUpdatedAt: parseDate(page.last_edited_time),
      contentHash: null,
      metadata: {
        provider: "notion",
        object: "page",
        notionId: page.id,
        archived: Boolean(page.archived),
        inTrash: Boolean(page.in_trash),
        parent: page.parent ?? null,
      },
    };
  }

  if (object === "data_source" || object === "database") {
    const dataSource = value as NotionDataSource;
    return {
      externalId: `${object}:${dataSource.id}`,
      externalUri: buildNotionUri(dataSource.id, dataSource.url),
      title: findDataSourceTitle(dataSource),
      mimeType: "application/json",
      sizeBytes: null,
      externalUpdatedAt: parseDate(dataSource.last_edited_time),
      contentHash: null,
      metadata: {
        provider: "notion",
        object,
        notionId: dataSource.id,
        propertyNames: Object.keys(dataSource.properties ?? {}),
      },
    };
  }

  return null;
}

function notionRichText(content: string) {
  return [
    {
      type: "text",
      text: {
        content: content.slice(0, 2000),
      },
    },
  ];
}

function markdownToBlocks(markdown: string) {
  const chunks = markdown
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  return chunks.slice(0, 100).map((chunk) => {
    const heading = chunk.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const type =
        level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
      return {
        object: "block",
        type,
        [type]: {
          rich_text: notionRichText(heading[2] ?? ""),
        },
      };
    }

    const bullet = chunk.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      return {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: notionRichText(bullet[1] ?? ""),
        },
      };
    }

    return {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: notionRichText(chunk),
      },
    };
  });
}

function propertyNameList(properties: Record<string, unknown> | undefined) {
  return Object.keys(properties ?? {}).sort();
}

function pageToMarkdown(page: NotionPage, blocksMarkdown: string) {
  const title = findPageTitle(page);
  const metadata = [
    `# ${title}`,
    "",
    `- Notion ID: ${page.id}`,
    page.url ? `- URL: ${page.url}` : null,
    page.created_time ? `- Created: ${page.created_time}` : null,
    page.last_edited_time ? `- Last edited: ${page.last_edited_time}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return `${metadata}\n\n${blocksMarkdown}`.trim();
}

function dataSourceToMarkdown(value: NotionDataSource) {
  const title = findDataSourceTitle(value);
  const propertyNames = propertyNameList(value.properties);
  return [
    `# ${title}`,
    "",
    `- Notion ID: ${value.id}`,
    value.url ? `- URL: ${value.url}` : null,
    value.created_time ? `- Created: ${value.created_time}` : null,
    value.last_edited_time ? `- Last edited: ${value.last_edited_time}` : null,
    "",
    "## Properties",
    propertyNames.length ? propertyNames.map((name) => `- ${name}`).join("\n") : "- None",
  ]
    .filter((item) => item !== null)
    .join("\n");
}

function formatBlock(block: NotionBlock, childMarkdown = "") {
  const data = asRecord(block[block.type]);
  const richText = richTextToMarkdown(data.rich_text);
  const caption = richTextToMarkdown(data.caption);

  switch (block.type) {
    case "paragraph":
      return [richText, childMarkdown].filter(Boolean).join("\n\n");
    case "heading_1":
      return [`# ${richText}`, childMarkdown].filter(Boolean).join("\n\n");
    case "heading_2":
      return [`## ${richText}`, childMarkdown].filter(Boolean).join("\n\n");
    case "heading_3":
      return [`### ${richText}`, childMarkdown].filter(Boolean).join("\n\n");
    case "bulleted_list_item":
      return [`- ${richText}`, childMarkdown].filter(Boolean).join("\n");
    case "numbered_list_item":
      return [`1. ${richText}`, childMarkdown].filter(Boolean).join("\n");
    case "to_do":
      return [`- [${data.checked ? "x" : " "}] ${richText}`, childMarkdown]
        .filter(Boolean)
        .join("\n");
    case "toggle":
      return [`<details><summary>${richText}</summary>`, childMarkdown, "</details>"]
        .filter(Boolean)
        .join("\n\n");
    case "quote":
      return [`> ${richText}`, childMarkdown].filter(Boolean).join("\n");
    case "callout":
      return [`> ${richText}`, childMarkdown].filter(Boolean).join("\n");
    case "code": {
      const language = asString(data.language) || "text";
      return [`\`\`\`${language}`, richText, "```"].join("\n");
    }
    case "image":
    case "file":
    case "pdf": {
      const file = asRecord(data.file);
      const external = asRecord(data.external);
      const url = asString(file.url) || asString(external.url);
      return url ? `[${caption || block.type}](${url})` : `[${block.type}]`;
    }
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = asString(data.url);
      return url ? `[${url}](${url})` : `[${block.type}]`;
    }
    case "child_page":
      return `## ${asString(data.title) || "Child page"}`;
    case "child_database":
      return `## ${asString(data.title) || "Child database"}`;
    case "table_of_contents":
    case "divider":
      return "---";
    case "equation":
      return `$$${asString(data.expression)}$$`;
    default:
      return richText || `[Unsupported Notion block: ${block.type}]`;
  }
}

function buildBasicAuthHeader() {
  return `Basic ${Buffer.from(
    `${getNotionClientId()}:${getNotionClientSecret()}`,
  ).toString("base64")}`;
}

async function parseNotionResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const error = payload as NotionErrorResponse;
    throw new ConnectorError(
      response.status,
      `NOTION_${(error.code || "REQUEST_FAILED").toUpperCase()}`,
      error.message || response.statusText || "Notion request failed",
      { status: response.status },
    );
  }
  return payload as T;
}

class NotionApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly notionVersion: string,
  ) {}

  async request<T>(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.accessToken}`);
    headers.set("notion-version", this.notionVersion);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
      ...init,
      headers,
    });
    return parseNotionResponse<T>(response);
  }

  async *paginate<T>(
    path: string,
    body: Record<string, unknown> = {},
    method: "GET" | "POST" = "POST",
  ) {
    let startCursor: string | null = null;
    do {
      const payload: NotionListResponse<T> =
        method === "POST"
          ? await this.request<NotionListResponse<T>>(path, {
              method,
              body: JSON.stringify({
                ...body,
                ...(startCursor ? { start_cursor: startCursor } : {}),
              }),
            })
          : await this.request<NotionListResponse<T>>(
              `${path}${startCursor ? `?start_cursor=${encodeURIComponent(startCursor)}` : ""}`,
            );
      for (const result of payload.results ?? []) {
        yield result;
      }
      startCursor = payload.has_more ? (payload.next_cursor ?? null) : null;
    } while (startCursor);
  }

  search(filter?: Record<string, unknown>) {
    return this.paginate<NotionSearchResult>(
      "/search",
      filter ? { filter } : {},
    );
  }

  retrievePage(pageId: string) {
    return this.request<NotionPage>(`/pages/${encodeURIComponent(pageId)}`);
  }

  retrieveDataSource(dataSourceId: string) {
    return this.request<NotionDataSource>(
      `/data_sources/${encodeURIComponent(dataSourceId)}`,
    );
  }

  listBlockChildren(blockId: string) {
    return this.paginate<NotionBlock>(
      `/blocks/${encodeURIComponent(blockId)}/children`,
      {},
      "GET",
    );
  }
}

async function exchangeToken(input: {
  grantType: "authorization_code" | "refresh_token";
  code?: string;
  refreshToken?: string;
  redirectUri?: string;
}) {
  const body =
    input.grantType === "authorization_code"
      ? {
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri,
        }
      : {
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
        };
  const response = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: buildBasicAuthHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const token = await parseNotionResponse<NotionTokenResponse>(response);
  if (!token.access_token) {
    throw new ConnectorError(
      502,
      "NOTION_TOKEN_RESPONSE_INVALID",
      "Notion token response did not include an access token",
    );
  }
  return token;
}

function mapTokenResponse(token: NotionTokenResponse): OAuthTokenSet {
  const expiresAt =
    typeof token.expires_in === "number"
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;
  return {
    accessToken: token.access_token ?? "",
    refreshToken: token.refresh_token ?? null,
    expiresAt,
    scopes: [],
    providerAccountId: token.workspace_id ?? token.bot_id ?? null,
    providerAccountEmail: null,
    displayName: token.workspace_name ?? "Notion workspace",
  };
}

async function collectBlocksMarkdown(
  client: NotionApiClient,
  blockId: string,
  depth = 0,
): Promise<string> {
  if (depth > 8) {
    return "";
  }
  const output: string[] = [];
  for await (const block of client.listBlockChildren(blockId)) {
    let childMarkdown = "";
    if (block.has_children) {
      childMarkdown = await collectBlocksMarkdown(client, block.id, depth + 1);
    }
    const formatted = formatBlock(block, childMarkdown);
    if (formatted.trim()) {
      output.push(formatted.trim());
    }
  }
  return output.join("\n\n");
}

function getNotionObjectIdFromItem(item: ConnectorItem) {
  const notionId =
    typeof item.metadata.notionId === "string"
      ? item.metadata.notionId
      : item.externalId.includes(":")
        ? item.externalId.split(":").slice(1).join(":")
        : item.externalId;
  if (!notionId) {
    throw new ConnectorError(
      400,
      "NOTION_ITEM_ID_INVALID",
      "Notion item id is missing",
    );
  }
  return notionId;
}

function createNotionClient(input: {
  accessToken: string;
  config: Record<string, unknown>;
}) {
  return new NotionApiClient(input.accessToken, getNotionVersion(input.config));
}

async function createPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const title = getRequestString(request, "title");
  const content = getRequestString(request, "content");
  const parentPageId = getRequestString(request, "parentPageId", false);
  const dataSourceId = getRequestString(request, "dataSourceId", false);
  if (!parentPageId && !dataSourceId) {
    throw new ConnectorError(
      400,
      "NOTION_PARENT_REQUIRED",
      "parentPageId or dataSourceId is required",
    );
  }

  const parent = dataSourceId
    ? { data_source_id: dataSourceId }
    : { page_id: parentPageId };
  const page = await client.request<NotionPage>("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent,
      properties: {
        title: {
          title: notionRichText(title),
        },
      },
      children: markdownToBlocks(content),
    }),
  });
  return {
    externalId: page.id,
    shouldResync: true,
    result: {
      pageId: page.id,
      url: page.url ?? buildNotionUri(page.id),
      title,
    },
  };
}

async function appendPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const pageId = getRequestString(request, "pageId");
  const content = getRequestString(request, "content");
  await client.request(`/blocks/${encodeURIComponent(pageId)}/children`, {
    method: "PATCH",
    body: JSON.stringify({
      children: markdownToBlocks(content),
    }),
  });
  return {
    externalId: pageId,
    shouldResync: true,
    result: {
      pageId,
      appended: true,
      contentHash: computeHash(content),
    },
  };
}

async function updatePagePropertiesAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const pageId = getRequestString(request, "pageId");
  const properties = asRecord(request.properties);
  await client.request(`/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  return {
    externalId: pageId,
    shouldResync: true,
    result: {
      pageId,
      updated: true,
      propertyNames: Object.keys(properties),
    },
  };
}

async function trashPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const pageId = getRequestString(request, "pageId");
  await client.request(`/pages/${encodeURIComponent(pageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ in_trash: true }),
  });
  return {
    externalId: pageId,
    shouldResync: true,
    result: {
      pageId,
      trashed: true,
    },
  };
}

async function createCommentAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const richText = getRequestString(request, "richText");
  const pageId = getRequestString(request, "pageId", false);
  const discussionId = getRequestString(request, "discussionId", false);
  if (!pageId && !discussionId) {
    throw new ConnectorError(
      400,
      "NOTION_COMMENT_TARGET_REQUIRED",
      "pageId or discussionId is required",
    );
  }
  const result = await client.request<Record<string, unknown>>("/comments", {
    method: "POST",
    body: JSON.stringify({
      ...(pageId
        ? { parent: { page_id: pageId } }
        : { discussion_id: discussionId }),
      rich_text: notionRichText(richText),
    }),
  });
  return {
    externalId: asString(result.id) || pageId || discussionId,
    shouldResync: Boolean(pageId),
    result: {
      commentId: asString(result.id) || null,
      pageId: pageId || null,
      discussionId: discussionId || null,
      contentHash: computeHash(richText),
    },
  };
}

async function queryDataSourceAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const dataSourceId = getRequestString(request, "dataSourceId");
  const payload = {
    ...(request.filter ? { filter: request.filter } : {}),
    ...(request.sorts ? { sorts: request.sorts } : {}),
    page_size: 20,
  };
  const result = await client.request<NotionListResponse<Record<string, unknown>>>(
    `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
  return {
    externalId: dataSourceId,
    result: {
      dataSourceId,
      resultCount: result.results.length,
      hasMore: Boolean(result.has_more),
      pageIds: result.results
        .map((item) => asString(item.id))
        .filter((id) => id.length > 0),
    },
  };
}

export const notionAdapter: ConnectorAdapter = {
  getManifest() {
    return notionManifest;
  },

  async exchangeOAuthCode(input: OAuthCodeExchangeInput) {
    const token = await exchangeToken({
      grantType: "authorization_code",
      code: input.code,
      redirectUri: input.redirectUri,
    });
    return mapTokenResponse(token);
  },

  async refreshOAuthToken(input: OAuthRefreshInput) {
    const token = await exchangeToken({
      grantType: "refresh_token",
      refreshToken: input.refreshToken,
    });
    return mapTokenResponse(token);
  },

  async *discover(input: ConnectorDiscoverInput) {
    const client = createNotionClient(input);
    const includePages = input.config.includePages !== false;
    const includeDataSources = input.config.includeDataSources !== false;
    const includeDatabases = input.config.includeDatabases !== false;

    if (includePages) {
      for await (const value of client.search({
        property: "object",
        value: "page",
      })) {
        const item = toNotionItem(value);
        if (item) {
          yield item;
        }
      }
    }

    if (includeDataSources) {
      for await (const value of client.search({
        property: "object",
        value: "data_source",
      })) {
        const item = toNotionItem(value);
        if (item) {
          yield item;
        }
      }
    }

    if (includeDatabases) {
      for await (const value of client.search({
        property: "object",
        value: "database",
      })) {
        const item = toNotionItem(value);
        if (item) {
          yield item;
        }
      }
    }
  },

  async extract(input: ConnectorExtractInput): Promise<ConnectorExtractedContent> {
    const client = createNotionClient(input);
    const object = asString(input.item.metadata.object);
    const notionId = getNotionObjectIdFromItem(input.item);

    if (object === "page") {
      const page = await client.retrievePage(notionId);
      const blocksMarkdown = await collectBlocksMarkdown(client, page.id);
      const markdown = pageToMarkdown(page, blocksMarkdown);
      return {
        item: {
          ...input.item,
          title: findPageTitle(page),
          externalUri: buildNotionUri(page.id, page.url),
          externalUpdatedAt: parseDate(page.last_edited_time),
          contentHash: computeHash(markdown),
          metadata: {
            ...input.item.metadata,
            archived: Boolean(page.archived),
            inTrash: Boolean(page.in_trash),
            parent: page.parent ?? null,
          },
        },
        contentText: markdown,
        markdown,
      };
    }

    if (object === "data_source") {
      const dataSource = await client.retrieveDataSource(notionId);
      const markdown = dataSourceToMarkdown(dataSource);
      return {
        item: {
          ...input.item,
          title: findDataSourceTitle(dataSource),
          externalUri: buildNotionUri(dataSource.id, dataSource.url),
          externalUpdatedAt: parseDate(dataSource.last_edited_time),
          contentHash: computeHash(markdown),
          metadata: {
            ...input.item.metadata,
            propertyNames: propertyNameList(dataSource.properties),
          },
        },
        contentText: markdown,
        markdown,
      };
    }

    return {
      item: input.item,
      contentText: input.item.title,
      markdown: `# ${input.item.title}`,
    };
  },

  async executeAction(
    input: ConnectorActionInput,
  ): Promise<ConnectorActionResult> {
    const client = createNotionClient(input);
    switch (input.actionType) {
      case "notion.page.create":
        return createPageAction(client, input.request);
      case "notion.page.append":
        return appendPageAction(client, input.request);
      case "notion.page.update_properties":
        return updatePagePropertiesAction(client, input.request);
      case "notion.page.trash":
        return trashPageAction(client, input.request);
      case "notion.comment.create":
        return createCommentAction(client, input.request);
      case "notion.data_source.query":
        return queryDataSourceAction(client, input.request);
      default:
        throw new ConnectorError(
          400,
          "CONNECTOR_ACTION_NOT_SUPPORTED",
          `Notion action '${input.actionType}' is not supported`,
        );
    }
  },
};
