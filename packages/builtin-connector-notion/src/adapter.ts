import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { NOTION_API_BASE_URL, NOTION_API_VERSION, NOTION_TOKEN_URL } from "./constants";
import { notionConnectorContribution } from "./contribution";
import {
  toBackendNotionConnectorManifest,
} from "./backend-manifest";
import { builtinNotionConnectorCapability } from "./manifest";
import type {
  ConnectorActionInput,
  ConnectorActionResult,
  ConnectorAdapter,
  ConnectorDiscoverInput,
  ConnectorExtractInput,
  ConnectorExtractedContent,
  ConnectorItem,
  ConnectorManifest,
  ConnectorSyncReadinessResult,
  ConnectorWebhookPayload,
  ConnectorWebhookTarget,
  ConnectorWebhookVerifyInput,
  OAuthCodeExchangeInput,
  OAuthRefreshInput,
  OAuthTokenSet,
} from "@sourceweft/contracts";

// ---------------------------------------------------------------------------
// Runtime config — injected by the backend via the factory function
// ---------------------------------------------------------------------------

export type NotionAdapterRuntimeConfig = {
  /** Base URL of the SourceWeft deployment (for OAuth redirect URI fallback). */
  baseUrl: string;
  /** Optional explicit redirect URI override. */
  redirectUri?: string;
  /** Notion OAuth client id. */
  clientId: string;
  /** Notion OAuth client secret. */
  clientSecret: string;
  /** Notion webhook verification secret (HMAC-SHA256). */
  webhookSecret: string;
};

// ---------------------------------------------------------------------------
// Package-local error class (satisfies ConnectorErrorShape so the
// backend can detect and re-wrap into its own ConnectorError).
// ---------------------------------------------------------------------------

const ERROR_NAME = "NotionAdapterError";

class NotionAdapterError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = ERROR_NAME;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Module-level runtime config (set once by the factory).
// All env/config accessor functions read from this.
// ---------------------------------------------------------------------------

let rc: NotionAdapterRuntimeConfig;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTION_RELATION_TITLE_RESOLVE_LIMIT = 10;
const NOTION_LOCATION_MAX_DEPTH = 6;
const NOTION_PROPERTY_SUMMARY_LIMIT = 4;

// ---------------------------------------------------------------------------
// Config / env accessors
// ---------------------------------------------------------------------------

function getNotionRedirectUri() {
  if (rc.redirectUri) return rc.redirectUri;
  return `${rc.baseUrl}/v1/connectors/oauth/notion/callback`;
}

function getOptionalNotionClientId() {
  return rc.clientId || "";
}

function getNotionClientId() {
  const value = getOptionalNotionClientId();
  if (!value) {
    throw new NotionAdapterError(
      500,
      "NOTION_CLIENT_ID_MISSING",
      "NOTION_CLIENT_ID is required for Notion connector OAuth",
    );
  }
  return value;
}

function getNotionClientSecret() {
  const value = rc.clientSecret;
  if (!value) {
    throw new NotionAdapterError(
      500,
      "NOTION_CLIENT_SECRET_MISSING",
      "NOTION_CLIENT_SECRET is required for Notion connector OAuth",
    );
  }
  return value;
}

function getNotionWebhookSecret() {
  return rc.webhookSecret || "";
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => asString(item).trim())
        .filter((item) => item.length > 0)
    : [];
}

function getRequestString(
  request: Record<string, unknown>,
  key: string,
  required = true,
) {
  const value = asString(request[key]).trim();
  if (!value && required) {
    throw new NotionAdapterError(
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

function sanitizedUrlLabel(value: string, fallback: string) {
  try {
    const url = new URL(value);
    return url.hostname || fallback;
  } catch {
    return fallback;
  }
}

function sanitizedLinkTarget(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Notion rich-text helpers
// ---------------------------------------------------------------------------

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

function richTextToPlainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as NotionRichText)
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("");
}

function richTextToMarkdown(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as NotionRichText)
    .map((item) => {
      let text = item.plain_text ?? item.text?.content ?? "";
      if (!text) return "";
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

// ---------------------------------------------------------------------------
// Notion domain types
// ---------------------------------------------------------------------------

type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  archived?: boolean;
  in_trash?: boolean;
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
  parent?: Record<string, unknown>;
  properties?: Record<string, unknown>;
};

type NotionSearchResult = NotionPage | NotionDataSource | Record<string, unknown>;

type NotionPropertyValue = {
  type: string;
  value: string;
  raw?: unknown;
};

type NotionPropertyNormalization = {
  values: Record<string, NotionPropertyValue>;
  emptyPropertyNames: string[];
  unsupportedPropertyTypes: string[];
  markdownLines: string[];
  summaryParts: string[];
};

type NotionBreadcrumbItem = {
  type: "page" | "data_source" | "workspace" | "unknown";
  id: string | null;
  title: string;
  url?: string | null;
  isTitleResolved?: boolean;
};

type NotionLocation = {
  parent: NotionBreadcrumbItem | null;
  breadcrumb: NotionBreadcrumbItem[];
  path: string | null;
  parentType: string | null;
  containerName: string | null;
};

type NotionTitleResolver = {
  page: (pageId: string) => Promise<NotionPage | null>;
  dataSource: (dataSourceId: string) => Promise<NotionDataSource | null>;
  pageTitle: (pageId: string) => Promise<NotionBreadcrumbItem | null>;
  dataSourceTitle: (dataSourceId: string) => Promise<NotionBreadcrumbItem | null>;
};

type NotionListResponse<T> = {
  results: T[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type NotionSearchBody = {
  query?: string;
  filter?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  page_size?: number;
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

type NotionWebhookPayload = {
  id?: string;
  timestamp?: string;
  type?: string;
  workspace_id?: string;
  workspace_name?: string;
  data?: unknown;
  entity?: unknown;
  object?: unknown;
  [key: string]: unknown;
};

type NotionRawResponseLogEntry = {
  body: unknown;
  method: string;
  path: string;
  status: number;
};

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function getNotionManifest(): ConnectorManifest {
  return toBackendNotionConnectorManifest(notionConnectorContribution, {
    clientId: getOptionalNotionClientId(),
    redirectUri: getNotionRedirectUri(),
  });
}

// ---------------------------------------------------------------------------
// Notion property display helpers
// ---------------------------------------------------------------------------

function findPageTitle(page: NotionPage) {
  for (const property of Object.values(page.properties ?? {})) {
    const record = asRecord(property);
    if (record.type === "title") {
      const title = richTextToPlainText(record.title);
      if (title.trim()) return title.trim();
    }
  }
  return "Untitled Notion Page";
}

function findDataSourceTitle(value: NotionDataSource) {
  const title = richTextToPlainText(value.title);
  return title.trim() || "Untitled Notion Data Source";
}

function titleFromPlainObject(value: unknown, fallback = "") {
  const record = asRecord(value);
  const name = asString(record.name).trim();
  if (name) return name;
  const plainText = asString(record.plain_text).trim();
  if (plainText) return plainText;
  const id = asString(record.id).trim();
  return id || fallback;
}

function optionName(value: unknown) {
  const record = asRecord(value);
  return asString(record.name).trim();
}

function arrayOptionNames(value: unknown) {
  return Array.isArray(value)
    ? value.map(optionName).filter((name) => name.length > 0)
    : [];
}

function notionDateValue(value: unknown) {
  const record = asRecord(value);
  const start = asString(record.start).trim();
  const end = asString(record.end).trim();
  if (!start) return "";
  return end ? `${start} to ${end}` : start;
}

function notionUserNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      return (
        asString(record.name).trim() ||
        asString(record.id).trim() ||
        "Unknown user"
      );
    })
    .filter((name) => name.length > 0);
}

function notionFilesValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      return (
        asString(record.name).trim() ||
        sanitizedUrlLabel(asString(asRecord(record.external).url), "") ||
        "Notion file"
      );
    })
    .filter((name) => name.length > 0);
}

function notionUniqueIdValue(value: unknown) {
  const record = asRecord(value);
  const prefix = asString(record.prefix).trim();
  const number = asNumber(record.number);
  if (number === null) return "";
  return `${prefix}${number}`;
}

function formulaValue(value: unknown) {
  const record = asRecord(value);
  const type = asString(record.type);
  switch (type) {
    case "string":
      return asString(record.string).trim();
    case "number": {
      const number = asNumber(record.number);
      return number === null ? "" : String(number);
    }
    case "boolean":
      return typeof record.boolean === "boolean" ? String(record.boolean) : "";
    case "date":
      return notionDateValue(record.date);
    default:
      return "";
  }
}

function rollupValue(value: unknown) {
  const record = asRecord(value);
  const type = asString(record.type);
  switch (type) {
    case "number": {
      const number = asNumber(record.number);
      return number === null ? "" : String(number);
    }
    case "date":
      return notionDateValue(record.date);
    case "array": {
      if (!Array.isArray(record.array)) return "";
      return record.array
        .map((item) => propertyDisplayValue(asRecord(item), null))
        .filter((item) => item.value.length > 0)
        .map((item) => item.value)
        .join(", ");
    }
    case "incomplete":
    case "unsupported":
      return `[${type} rollup]`;
    default:
      return "";
  }
}

function notionPropertySummaryLine(name: string, value: NotionPropertyValue) {
  return `${name}: ${value.value.replace(/\s+/g, " ").trim()}`;
}

function notionPropertyMarkdownLine(name: string, value: NotionPropertyValue) {
  const lines = value.value.replace(/\r\n?/g, "\n").split("\n");
  const firstLine = lines.shift()?.trim() ?? "";
  const continuationLines = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `  ${line}`);
  return [`- ${name}: ${firstLine}`, ...continuationLines].join("\n");
}

function propertyDisplayValue(
  property: Record<string, unknown>,
  resolver: NotionTitleResolver | null,
): { type: string; value: string; raw?: unknown; unsupported?: boolean } {
  const type = asString(property.type);
  switch (type) {
    case "title":
      return { type, value: richTextToPlainText(property.title).trim() };
    case "rich_text":
      return { type, value: richTextToPlainText(property.rich_text).trim() };
    case "status":
      return { type, value: optionName(property.status) };
    case "select":
      return { type, value: optionName(property.select) };
    case "multi_select":
      return { type, value: arrayOptionNames(property.multi_select).join(", ") };
    case "date":
      return { type, value: notionDateValue(property.date) };
    case "people":
      return { type, value: notionUserNames(property.people).join(", ") };
    case "relation": {
      if (!Array.isArray(property.relation)) return { type, value: "" };
      const ids = property.relation
        .map((item) => asString(asRecord(item).id).trim())
        .filter(Boolean);
      const limitedIds = ids.slice(0, NOTION_RELATION_TITLE_RESOLVE_LIMIT);
      const overflow = ids.length - limitedIds.length;
      return {
        type,
        value:
          overflow > 0
            ? `${limitedIds.join(", ")} and ${overflow} more`
            : limitedIds.join(", "),
        raw: {
          relationIds: ids,
          resolverAvailable: Boolean(resolver),
          overflow,
        },
      };
    }
    case "rollup":
      return { type, value: rollupValue(property.rollup) };
    case "number": {
      const number = asNumber(property.number);
      return { type, value: number === null ? "" : String(number) };
    }
    case "checkbox":
      return {
        type,
        value: typeof property.checkbox === "boolean" ? String(property.checkbox) : "",
      };
    case "url":
      return { type, value: asString(property.url).trim() };
    case "email":
      return { type, value: asString(property.email).trim() };
    case "phone_number":
      return { type, value: asString(property.phone_number).trim() };
    case "files":
      return { type, value: notionFilesValue(property.files).join(", ") };
    case "formula":
      return { type, value: formulaValue(property.formula) };
    case "created_time":
      return { type, value: asString(property.created_time).trim() };
    case "created_by":
      return { type, value: titleFromPlainObject(property.created_by, "Unknown user") };
    case "last_edited_time":
      return { type, value: asString(property.last_edited_time).trim() };
    case "last_edited_by":
      return {
        type,
        value: titleFromPlainObject(property.last_edited_by, "Unknown user"),
      };
    case "unique_id":
      return { type, value: notionUniqueIdValue(property.unique_id) };
    default:
      return { type: type || "unknown", value: "", unsupported: true };
  }
}

async function resolveRelationTitles(
  value: NotionPropertyValue,
  resolver: NotionTitleResolver | null,
) {
  const raw = asRecord(value.raw);
  const ids = Array.isArray(raw.relationIds)
    ? raw.relationIds.filter((id): id is string => typeof id === "string")
    : [];
  if (!ids.length || !resolver) return value;
  const limitedIds = ids.slice(0, NOTION_RELATION_TITLE_RESOLVE_LIMIT);
  const titles: string[] = [];
  for (const id of limitedIds) {
    try {
      const related = await resolver.pageTitle(id);
      titles.push(related?.title || id);
    } catch {
      titles.push(id);
    }
  }
  const overflow = ids.length - limitedIds.length;
  return {
    ...value,
    value: overflow > 0 ? `${titles.join(", ")} and ${overflow} more` : titles.join(", "),
  };
}

async function normalizeNotionPageProperties(
  properties: Record<string, unknown> | undefined,
  resolver: NotionTitleResolver | null,
): Promise<NotionPropertyNormalization> {
  const values: Record<string, NotionPropertyValue> = {};
  const emptyPropertyNames: string[] = [];
  const unsupportedPropertyTypes = new Set<string>();

  for (const [name, rawProperty] of Object.entries(properties ?? {})) {
    const property = asRecord(rawProperty);
    const display = propertyDisplayValue(property, resolver);
    if (display.unsupported) unsupportedPropertyTypes.add(display.type);
    let normalized: NotionPropertyValue = {
      type: display.type,
      value: display.value.trim(),
      ...(display.raw ? { raw: display.raw } : {}),
    };
    if (normalized.type === "relation") {
      normalized = await resolveRelationTitles(normalized, resolver);
    }
    if (normalized.value) {
      values[name] = normalized;
    } else {
      emptyPropertyNames.push(name);
    }
  }

  const summaryLines = Object.entries(values)
    .filter(([, value]) => value.type !== "title")
    .map(([name, value]) => notionPropertySummaryLine(name, value));
  const markdownLines = Object.entries(values)
    .filter(([, value]) => value.type !== "title")
    .map(([name, value]) => notionPropertyMarkdownLine(name, value));
  const summaryParts = summaryLines.slice(0, NOTION_PROPERTY_SUMMARY_LIMIT);

  return {
    values,
    emptyPropertyNames: emptyPropertyNames.sort(),
    unsupportedPropertyTypes: [...unsupportedPropertyTypes].sort(),
    markdownLines,
    summaryParts,
  };
}

// ---------------------------------------------------------------------------
// Parent / location resolution
// ---------------------------------------------------------------------------

function parentInfoFromPage(page: NotionPage) {
  return parentInfoFromRecord(asRecord(page.parent));
}

function parentInfoFromRecord(parent: Record<string, unknown>) {
  const type = asString(parent.type);
  if (type === "page_id") return { type: "page" as const, id: asString(parent.page_id) };
  if (type === "data_source_id") return { type: "data_source" as const, id: asString(parent.data_source_id) };
  if (type === "database_id") return { type: "data_source" as const, id: asString(parent.database_id) };
  if (type === "workspace") return { type: "workspace" as const, id: null };
  return { type: "unknown" as const, id: null };
}

function parentInfoFromDataSource(dataSource: NotionDataSource) {
  return parentInfoFromRecord(asRecord(dataSource.parent));
}

function notionDirectoryExternalId(input: {
  connectorId: string;
  type: NotionBreadcrumbItem["type"] | "connector";
  id: string | null;
}) {
  if (input.type === "connector") return `notion-dir:connector:${input.connectorId}`;
  if (input.type === "workspace") return `notion-dir:workspace:${input.connectorId}`;
  return `notion-dir:${input.type}:${input.id ?? "unknown"}`;
}

function rawNotionIdMatchesTitle(title: string, id: string | null) {
  if (!id) return false;
  const normalize = (value: string) => value.replaceAll("-", "").toLowerCase();
  return normalize(title.trim()) === normalize(id);
}

function hasVisibleNotionDirectoryTitle(item: NotionBreadcrumbItem) {
  const title = item.title.trim();
  return (
    item.isTitleResolved !== false &&
    title.length > 0 &&
    (item.isTitleResolved === true || !rawNotionIdMatchesTitle(title, item.id))
  );
}

function unresolvedNotionParent(info: ReturnType<typeof parentInfoFromRecord>) {
  return { type: info.type, id: info.id, title: "", isTitleResolved: false };
}

function buildNotionDirectoryPath(input: {
  connectorId: string;
  connectorName?: string | null;
  location: NotionLocation;
}) {
  return [
    {
      externalId: notionDirectoryExternalId({
        connectorId: input.connectorId,
        type: "connector",
        id: input.connectorId,
      }),
      title: "Notion",
      externalUri: null,
      metadata: {
        provider: "notion",
        connectorType: "notion",
        notion: {
          type: "connector_root",
          connectorId: input.connectorId,
          connectorName: input.connectorName ?? null,
        },
      },
    },
    ...input.location.breadcrumb
      .filter(
        (item) =>
          item.type !== "workspace" && hasVisibleNotionDirectoryTitle(item),
      )
      .slice(0, -1)
      .map((item) => ({
        externalId: notionDirectoryExternalId({
          connectorId: input.connectorId,
          type: item.type,
          id: item.id,
        }),
        title: item.title,
        externalUri: item.url ?? null,
        metadata: {
          provider: "notion",
          connectorType: "notion",
          notion: {
            type: item.type,
            id: item.id,
            url: item.url ?? null,
          },
        },
      })),
  ];
}

async function resolveNotionPageLocation(
  page: NotionPage,
  resolver: NotionTitleResolver,
): Promise<NotionLocation> {
  const breadcrumb: NotionBreadcrumbItem[] = [];
  const visited = new Set<string>();
  let parent: NotionBreadcrumbItem | null = null;
  const directParentInfo = parentInfoFromPage(page);
  let parentType: string | null = directParentInfo.type;
  let currentInfo: ReturnType<typeof parentInfoFromRecord> = directParentInfo;

  for (let depth = 0; depth < NOTION_LOCATION_MAX_DEPTH; depth += 1) {
    const info = currentInfo;
    if (info.type === "workspace") {
      const workspace = {
        type: "workspace" as const,
        id: null,
        title: "Workspace",
        isTitleResolved: true,
      };
      parent = parent ?? workspace;
      break;
    }
    if (!info.id || visited.has(info.id)) break;
    visited.add(info.id);

    try {
      const resolved =
        info.type === "page"
          ? await resolver.pageTitle(info.id)
          : info.type === "data_source"
            ? await resolver.dataSourceTitle(info.id)
            : null;
      if (!resolved) {
        const fallback = unresolvedNotionParent(info);
        parent = parent ?? fallback;
        breadcrumb.unshift(fallback);
        break;
      }
      parent = parent ?? resolved;
      breadcrumb.unshift(resolved);
      if (info.type === "page") {
        const parentPage = await resolver.page(info.id);
        if (!parentPage) break;
        currentInfo = parentInfoFromPage(parentPage);
        continue;
      }
      if (info.type === "data_source") {
        const dataSource = await resolver.dataSource(info.id);
        if (!dataSource) break;
        currentInfo = parentInfoFromDataSource(dataSource);
        continue;
      }
      break;
    } catch {
      const fallback = unresolvedNotionParent(info);
      parent = parent ?? fallback;
      breadcrumb.unshift(fallback);
      break;
    }
  }

  const currentPage = {
    type: "page" as const,
    id: page.id,
    title: findPageTitle(page),
    url: page.url ?? null,
    isTitleResolved: true,
  };
  const fullBreadcrumb = [...breadcrumb, currentPage].filter(
    (item, index, items) =>
      index === items.findIndex((candidate) => candidate.id === item.id),
  );
  return {
    parent,
    breadcrumb: fullBreadcrumb,
    path:
      fullBreadcrumb
        .filter(hasVisibleNotionDirectoryTitle)
        .map((item) => item.title)
        .join(" / ") || null,
    parentType,
    containerName:
      [...breadcrumb]
        .reverse()
        .find(
          (item) =>
            item.type === "data_source" && hasVisibleNotionDirectoryTitle(item),
        )?.title ?? null,
  };
}

// ---------------------------------------------------------------------------
// Item conversion
// ---------------------------------------------------------------------------

function parseDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNotionItem(value: NotionSearchResult): ConnectorItem | null {
  const object = asString(value.object);
  const id = asString(value.id);
  if (!id) return null;

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
        forceRefetch: true,
      },
    };
  }

  if (object === "data_source") {
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
        forceRefetch: true,
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Markdown ↔ Notion block helpers
// ---------------------------------------------------------------------------

function notionRichText(content: string) {
  return [{ type: "text", text: { content: content.slice(0, 2000) } }];
}

function richTextSegment(content: string, annotations?: Record<string, boolean>) {
  return {
    type: "text",
    text: { content: content.slice(0, 2000) },
    ...(annotations ? { annotations } : {}),
  };
}

function parseInlineMarkdown(content: string) {
  const output: Array<Record<string, unknown>> = [];
  let remaining = content;
  const pattern = /(\*\*([^*]+)\*\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/;
  while (remaining.length > 0) {
    const match = remaining.match(pattern);
    if (!match || match.index === undefined) {
      output.push(richTextSegment(remaining));
      break;
    }
    if (match.index > 0) {
      output.push(richTextSegment(remaining.slice(0, match.index)));
    }
    if (match[2]) {
      output.push(richTextSegment(match[2], { bold: true }));
    } else if (match[3]) {
      output.push(richTextSegment(match[3], { italic: true }));
    } else if (match[4]) {
      output.push(richTextSegment(match[4], { code: true }));
    } else if (match[5]) {
      output.push({
        type: "text",
        text: { content: match[5].slice(0, 2000), link: { url: match[6] } },
      });
    }
    remaining = remaining.slice(match.index + match[0].length);
  }
  return output.length ? output : notionRichText("");
}

function createRichTextBlock(type: string, content: string) {
  return { object: "block", type, [type]: { rich_text: parseInlineMarkdown(content) } };
}

function markdownToBlocks(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<Record<string, unknown>> = [];
  let paragraph: string[] = [];
  let codeFence: { language: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    const content = paragraph.join("\n").trim();
    paragraph = [];
    if (content) blocks.push(createRichTextBlock("paragraph", content));
  };

  for (const line of lines) {
    const codeStart = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (codeStart) {
      if (codeFence) {
        blocks.push({
          object: "block",
          type: "code",
          code: {
            rich_text: notionRichText(codeFence.lines.join("\n")),
            language: codeFence.language || "plain text",
          },
        });
        codeFence = null;
      } else {
        flushParagraph();
        codeFence = { language: codeStart[1] ?? "plain text", lines: [] };
      }
      continue;
    }
    if (codeFence) { codeFence.lines.push(line); continue; }

    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); continue; }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1]?.length ?? 1;
      const type = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
      blocks.push(createRichTextBlock(type, heading[2] ?? ""));
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      flushParagraph();
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }

    const todo = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (todo) {
      flushParagraph();
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: parseInlineMarkdown(todo[2] ?? ""),
          checked: todo[1]?.toLowerCase() === "x",
        },
      });
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      blocks.push(createRichTextBlock("bulleted_list_item", bullet[1] ?? ""));
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      flushParagraph();
      blocks.push(createRichTextBlock("numbered_list_item", numbered[1] ?? ""));
      continue;
    }

    const quote = trimmed.match(/^>\s+(.+)$/);
    if (quote) {
      flushParagraph();
      blocks.push(createRichTextBlock("quote", quote[1] ?? ""));
      continue;
    }

    const callout = trimmed.match(/^!\s+(.+)$/);
    if (callout) {
      flushParagraph();
      blocks.push(createRichTextBlock("callout", callout[1] ?? ""));
      continue;
    }

    if (trimmed.includes("|") && /^\|?[-:\s|]+\|?$/.test(trimmed)) continue;
    paragraph.push(line);
  }

  if (codeFence) {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        rich_text: notionRichText(codeFence.lines.join("\n")),
        language: codeFence.language || "plain text",
      },
    });
  }
  flushParagraph();
  return blocks;
}

function propertyNameList(properties: Record<string, unknown> | undefined) {
  return Object.keys(properties ?? {}).sort();
}

function formatMarkdownSection(title: string, lines: string[]) {
  const body = lines.filter((line) => line.trim().length > 0);
  if (!body.length) return "";
  return [`## ${title}`, ...body].join("\n");
}

function pageToMarkdown(input: {
  page: NotionPage;
  accountLabel?: string | null;
  properties: NotionPropertyNormalization;
  location: NotionLocation;
  blocksMarkdown: string;
}) {
  const { page, properties, blocksMarkdown } = input;
  const title = findPageTitle(page);
  const sections = [
    `# ${title}`,
    "",
    formatMarkdownSection("Notion Properties", properties.markdownLines),
    formatMarkdownSection("Content", [blocksMarkdown]),
  ].filter((section) => section.trim().length > 0);
  return sections.join("\n\n").trim();
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
      return [`- [${data.checked ? "x" : " "}] ${richText}`, childMarkdown].filter(Boolean).join("\n");
    case "toggle":
      return [`<details><summary>${richText}</summary>`, childMarkdown, "</details>"].filter(Boolean).join("\n\n");
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
      const fileUrl = asString(file.url);
      const externalUrl = asString(external.url);
      if (externalUrl) {
        const label = caption || `${block.type} from ${sanitizedUrlLabel(externalUrl, "external source")}`;
        const safeUrl = sanitizedLinkTarget(externalUrl);
        return safeUrl ? `[${label}](${safeUrl})` : `[${label}]`;
      }
      if (fileUrl) return `[Notion ${block.type}${caption ? `: ${caption}` : ""}]`;
      return `[${block.type}]`;
    }
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = asString(data.url);
      if (!url) return `[${block.type}]`;
      const label = sanitizedUrlLabel(url, block.type);
      const safeUrl = sanitizedLinkTarget(url);
      return safeUrl ? `[${label}](${safeUrl})` : `[${label}]`;
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

// ---------------------------------------------------------------------------
// Notion API client
// ---------------------------------------------------------------------------

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
    throw new NotionAdapterError(
      response.status,
      `NOTION_${(error.code || "REQUEST_FAILED").toUpperCase()}`,
      error.message || response.statusText || "Notion request failed",
      { rawResponseJson: payload, status: response.status },
    );
  }
  return payload as T;
}

function retryAfterMs(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Math.max(0, date.getTime() - Date.now());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NotionApiClient {
  private rawResponseLog: NotionRawResponseLogEntry[] = [];

  constructor(private readonly accessToken: string) {}

  clearRawResponseLog() {
    this.rawResponseLog = [];
  }

  getRawResponseLog() {
    return [...this.rawResponseLog];
  }

  async request<T>(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.accessToken}`);
    headers.set("notion-version", NOTION_API_VERSION);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
        ...init,
        headers,
      });
      if (
        response.ok ||
        (response.status !== 429 && (response.status < 500 || response.status >= 600))
      ) {
        const payload = await parseNotionResponse<T>(response);
        this.rawResponseLog.push({
          body: payload,
          method: init.method ?? "GET",
          path,
          status: response.status,
        });
        return payload;
      }
      lastResponse = response;
      const delayMs = retryAfterMs(response) ?? 500 * 2 ** attempt;
      await sleep(delayMs);
    }
    if (lastResponse) {
      const payload = await parseNotionResponse<T>(lastResponse);
      this.rawResponseLog.push({
        body: payload,
        method: init.method ?? "GET",
        path,
        status: lastResponse.status,
      });
      return payload;
    }
    throw new NotionAdapterError(502, "NOTION_REQUEST_FAILED", "Notion request failed");
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

  search(body: NotionSearchBody = {}) {
    return this.paginate<NotionSearchResult>("/search", body);
  }

  async hasAccessiblePage() {
    const payload = await this.request<NotionListResponse<NotionSearchResult>>(
      "/search",
      {
        method: "POST",
        body: JSON.stringify({
          filter: { property: "object", value: "page" },
          page_size: 1,
        }),
      },
    );
    return (payload.results ?? []).some(
      (value) => asString(value.object) === "page",
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

  appendBlockChildren(blockId: string, children: Array<Record<string, unknown>>) {
    return this.request(`/blocks/${encodeURIComponent(blockId)}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children }),
    });
  }

  updateBlock(blockId: string, payload: Record<string, unknown>) {
    return this.request(`/blocks/${encodeURIComponent(blockId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

async function exchangeToken(input: {
  grantType: "authorization_code" | "refresh_token";
  code?: string;
  refreshToken?: string;
  redirectUri?: string;
}) {
  const body =
    input.grantType === "authorization_code"
      ? { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }
      : { grant_type: "refresh_token", refresh_token: input.refreshToken };
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
    throw new NotionAdapterError(
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

// ---------------------------------------------------------------------------
// Block collection
// ---------------------------------------------------------------------------

async function collectBlocksMarkdown(
  client: NotionApiClient,
  blockId: string,
  depth = 0,
): Promise<{ markdown: string; skippedBlockTypes: string[]; skippedBlockCount: number }> {
  if (depth > 8) {
    return { markdown: "", skippedBlockTypes: ["max_depth"], skippedBlockCount: 1 };
  }
  const output: string[] = [];
  const skippedBlockTypes = new Set<string>();
  let skippedBlockCount = 0;

  try {
    for await (const block of client.listBlockChildren(blockId)) {
      let childMarkdown = "";
      if (block.has_children) {
        const childBlocks = await collectBlocksMarkdown(client, block.id, depth + 1);
        childMarkdown = childBlocks.markdown;
        for (const type of childBlocks.skippedBlockTypes) skippedBlockTypes.add(type);
        skippedBlockCount += childBlocks.skippedBlockCount;
      }
      const formatted = formatBlock(block, childMarkdown);
      if (formatted.includes("[Unsupported Notion block:")) {
        skippedBlockTypes.add(block.type);
        skippedBlockCount += 1;
      }
      if (formatted.trim()) output.push(formatted.trim());
    }
  } catch (error) {
    if (
      error instanceof NotionAdapterError &&
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 404
    ) {
      skippedBlockTypes.add("inaccessible_children");
      skippedBlockCount += 1;
    } else {
      throw error;
    }
  }

  return { markdown: output.join("\n\n"), skippedBlockTypes: [...skippedBlockTypes], skippedBlockCount };
}

// ---------------------------------------------------------------------------
// Object ID helpers
// ---------------------------------------------------------------------------

function getNotionObjectIdFromItem(item: ConnectorItem) {
  const notionId =
    typeof item.metadata.notionId === "string"
      ? item.metadata.notionId
      : item.externalId.includes(":")
        ? item.externalId.split(":").slice(1).join(":")
        : item.externalId;
  if (!notionId) {
    throw new NotionAdapterError(400, "NOTION_ITEM_ID_INVALID", "Notion item id is missing");
  }
  return notionId;
}

// ---------------------------------------------------------------------------
// Client & resolver factories
// ---------------------------------------------------------------------------

function createNotionClient(input: { accessToken: string }) {
  return new NotionApiClient(input.accessToken);
}

function createNotionTitleResolver(client: NotionApiClient): NotionTitleResolver {
  const pageCache = new Map<string, Promise<NotionPage | null>>();
  const dataSourceCache = new Map<string, Promise<NotionDataSource | null>>();

  const page = (pageId: string) => {
    const existing = pageCache.get(pageId);
    if (existing) return existing;
    const next = client.retrievePage(pageId).catch((error) => {
      if (error instanceof NotionAdapterError && (error as NotionAdapterError).statusCode === 404) return null;
      throw error;
    });
    pageCache.set(pageId, next);
    return next;
  };

  const dataSource = (dataSourceId: string) => {
    const existing = dataSourceCache.get(dataSourceId);
    if (existing) return existing;
    const next = client.retrieveDataSource(dataSourceId).catch((error) => {
      if (error instanceof NotionAdapterError && (error as NotionAdapterError).statusCode === 404) return null;
      throw error;
    });
    dataSourceCache.set(dataSourceId, next);
    return next;
  };

  return {
    dataSource,
    page,
    async pageTitle(pageId: string) {
      const value = await page(pageId);
      if (!value) return null;
      return { type: "page", id: value.id, title: findPageTitle(value), url: value.url ?? null, isTitleResolved: true };
    },
    async dataSourceTitle(dataSourceId: string) {
      const value = await dataSource(dataSourceId);
      if (!value) return null;
      return { type: "data_source", id: value.id, title: findDataSourceTitle(value), url: value.url ?? null, isTitleResolved: true };
    },
  };
}

async function appendMarkdownInBatches(
  client: NotionApiClient,
  pageId: string,
  markdown: string,
) {
  const blocks = markdownToBlocks(markdown);
  for (let index = 0; index < blocks.length; index += 100) {
    await client.appendBlockChildren(pageId, blocks.slice(index, index + 100));
  }
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

function parseJsonObject(value: string) {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    throw new NotionAdapterError(400, "NOTION_WEBHOOK_PAYLOAD_INVALID", "Notion webhook payload must be JSON");
  }
}

function getRequestBoolean(
  request: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
) {
  return typeof request[key] === "boolean" ? (request[key] as boolean) : defaultValue;
}

function getRequestPositiveInteger(
  request: Record<string, unknown>,
  key: string,
  defaultValue: number,
) {
  const value = request[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  return Math.max(1, Math.floor(value));
}

function signatureMatches(input: {
  rawBody: string;
  signature: string;
  secret: string;
}) {
  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest("hex");
  const normalized = input.signature.replace(/^sha256=/, "");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(normalized, "hex");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function verifyNotionWebhook(input: ConnectorWebhookVerifyInput) {
  const secret = getNotionWebhookSecret();
  if (!secret) return;
  const signature =
    input.headers["x-notion-signature"] ??
    input.headers["notion-signature"] ??
    "";
  if (!signature || !signatureMatches({ rawBody: input.rawBody, signature, secret })) {
    throw new NotionAdapterError(401, "NOTION_WEBHOOK_SIGNATURE_INVALID", "Notion webhook signature is invalid");
  }
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function notionWebhookObject(payload: Record<string, unknown>) {
  const data = asRecord(payload.data);
  const entity = asRecord(payload.entity);
  const object = asRecord(payload.object);
  const nestedObject = asRecord(data.object);
  const objectId = firstString(
    data.id, data.object_id, data.page_id, data.database_id,
    data.data_source_id, data.file_upload_id,
    entity.id, entity.object_id, object.id, nestedObject.id, payload.object_id,
  );
  const objectType = firstString(
    data.object, data.object_type, data.type, data.entity_type,
    entity.type, entity.object, object.type, object.object,
    nestedObject.object, nestedObject.type, payload.object, payload.object_type,
  );
  return { objectId: objectId || null, objectType: normalizeWebhookObjectType(objectType) };
}

function normalizeWebhookObjectType(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("data_source")) return "data_source";
  if (normalized.includes("database")) return "database";
  if (normalized.includes("file_upload")) return "file_upload";
  if (normalized.includes("comment")) return "comment";
  if (normalized.includes("view")) return "view";
  if (normalized.includes("page")) return "page";
  return normalized;
}

function webhookExternalId(input: { objectType: string | null; objectId: string | null }) {
  if (!input.objectType || !input.objectId) return null;
  if (input.objectType === "page" || input.objectType === "data_source") {
    return `${input.objectType}:${input.objectId}`;
  }
  return null;
}

async function parseNotionWebhookEvent(
  input: ConnectorWebhookVerifyInput,
): Promise<ConnectorWebhookPayload> {
  const payload = parseJsonObject(input.rawBody) as NotionWebhookPayload;
  const eventType = firstString(payload.type, payload.event_type, payload.event);
  const verificationToken = firstString(payload.verification_token);
  if (verificationToken && !eventType) {
    return {
      providerEventId: `verification:${computeHash(verificationToken)}`,
      eventType: "webhook.verification",
      objectId: null,
      objectType: "webhook",
      workspaceHint: firstString(payload.workspace_id),
      connectorId: input.query.connectorId ?? null,
      rawPayload: payload,
      metadata: {
        verificationToken,
        workspaceId: firstString(payload.workspace_id) || null,
      },
    };
  }
  if (!eventType) {
    throw new NotionAdapterError(400, "NOTION_WEBHOOK_EVENT_TYPE_MISSING", "Notion webhook event type is missing");
  }
  const { objectId, objectType } = notionWebhookObject(payload);
  return {
    providerEventId: firstString(payload.id, payload.event_id),
    eventType,
    objectId,
    objectType,
    workspaceHint: firstString(payload.workspace_id),
    connectorId: input.query.connectorId ?? null,
    rawPayload: payload,
    metadata: {
      workspaceId: firstString(payload.workspace_id) || null,
      workspaceName: firstString(payload.workspace_name) || null,
      timestamp: firstString(payload.timestamp) || null,
      objectId,
      objectType,
    },
  };
}

async function mapNotionWebhookTargets(
  event: ConnectorWebhookPayload,
): Promise<ConnectorWebhookTarget[]> {
  if (event.eventType === "webhook.verification") {
    return [{ action: "record_only", reason: "verification" }];
  }
  const externalId = webhookExternalId(event);
  if (event.eventType.includes(".deleted")) {
    if (event.objectType === "data_source") {
      return [{ action: "sync", objectId: event.objectId, objectType: event.objectType, reason: "data source deletion requires page rediscovery" }];
    }
    return event.objectType === "page" && externalId
      ? [{ action: "archive_source", externalId, objectId: event.objectId, objectType: event.objectType }]
      : [{ action: "record_only", reason: "deleted event without source target" }];
  }
  if (event.objectType === "page" || event.objectType === "data_source") {
    if (event.objectType === "data_source") {
      return [{ action: "sync", objectId: event.objectId, objectType: event.objectType, reason: "data source event requires page rediscovery" }];
    }
    return externalId
      ? [{ action: "sync", externalId, objectId: event.objectId, objectType: event.objectType }]
      : [{ action: "record_only", reason: "event without object id" }];
  }
  if (event.objectType === "comment" || event.objectType === "file_upload") {
    const pageId = firstString(
      asRecord(event.rawPayload.data).page_id,
      asRecord(event.rawPayload.entity).page_id,
      event.rawPayload.page_id,
    );
    return pageId
      ? [{ action: "sync", externalId: `page:${pageId}`, objectId: pageId, objectType: "page" }]
      : [{ action: "record_only", reason: `${event.objectType} event without page target` }];
  }
  return [{ action: "record_only", reason: "not indexable" }];
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

async function createPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const title = getRequestString(request, "title");
  const content = getRequestString(request, "content");
  const parentPageId =
    getRequestString(request, "parentPageId", false) ||
    getRequestString(request, "pageId", false);
  const dataSourceId = getRequestString(request, "dataSourceId", false);
  const parent = dataSourceId
    ? { data_source_id: dataSourceId }
    : parentPageId
      ? { page_id: parentPageId }
      : undefined;
  const children = markdownToBlocks(content);
  const page = await client.request<NotionPage>("/pages", {
    method: "POST",
    body: JSON.stringify({
      ...(parent ? { parent } : {}),
      properties: { title: { title: notionRichText(title) } },
      children: children.slice(0, 100),
    }),
  });
  for (let index = 100; index < children.length; index += 100) {
    await client.appendBlockChildren(page.id, children.slice(index, index + 100));
  }
  return {
    externalId: `page:${page.id}`,
    resyncExternalIds: [`page:${page.id}`],
    shouldResync: true,
    result: { pageId: page.id, url: page.url ?? buildNotionUri(page.id), title },
  };
}

async function saveArtifactAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const artifactId = getRequestString(request, "artifactId");
  const artifactUrl = getRequestString(request, "artifactUrl", false);
  return createPageAction(client, {
    title: getRequestString(request, "title"),
    content: artifactUrl
      ? `[Artifact ${artifactId}](${artifactUrl})`
      : `Artifact: ${artifactId}`,
  });
}

async function appendPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const pageId = getRequestString(request, "pageId");
  const content = getRequestString(request, "content");
  await appendMarkdownInBatches(client, pageId, content);
  return {
    externalId: `page:${pageId}`,
    resyncExternalIds: [`page:${pageId}`],
    shouldResync: true,
    result: { pageId, appended: true, contentHash: computeHash(content) },
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
    externalId: `page:${pageId}`,
    resyncExternalIds: [`page:${pageId}`],
    shouldResync: true,
    result: { pageId, updated: true, propertyNames: Object.keys(properties) },
  };
}

async function trashPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const pageIds = Array.from(
    new Set([
      ...asStringArray(request.pageIds),
      ...(getRequestString(request, "pageId", false)
        ? [getRequestString(request, "pageId", false)]
        : []),
    ]),
  );
  if (pageIds.length === 0) {
    throw new NotionAdapterError(400, "NOTION_ACTION_INPUT_INVALID", "requestJson.pageId or requestJson.pageIds is required");
  }
  for (const pageId of pageIds) {
    await client.request(`/pages/${encodeURIComponent(pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ in_trash: true }),
    });
  }
  return {
    externalId: pageIds.length === 1 ? `page:${pageIds[0]}` : null,
    resyncExternalIds: pageIds.map((pageId) => `page:${pageId}`),
    shouldResync: true,
    result: { pageId: pageIds[0], pageIds, count: pageIds.length, trashed: true },
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
    throw new NotionAdapterError(400, "NOTION_COMMENT_TARGET_REQUIRED", "pageId or discussionId is required");
  }
  const result = await client.request<Record<string, unknown>>("/comments", {
    method: "POST",
    body: JSON.stringify({
      ...(pageId ? { parent: { page_id: pageId } } : { discussion_id: discussionId }),
      rich_text: notionRichText(richText),
    }),
  });
  return {
    externalId: pageId ? `page:${pageId}` : asString(result.id) || discussionId,
    resyncExternalIds: pageId ? [`page:${pageId}`] : [],
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
    { method: "POST", body: JSON.stringify(payload) },
  );
  return {
    externalId: dataSourceId,
    result: {
      dataSourceId,
      resultCount: result.results.length,
      hasMore: Boolean(result.has_more),
      pageIds: result.results.map((item) => asString(item.id)).filter((id) => id.length > 0),
    },
  };
}

async function findPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const query = getRequestString(request, "query", false);
  if (!query) {
    throw new NotionAdapterError(
      400,
      "CONNECTOR_TOOL_INPUT_INVALID",
      "search_notion_pages requires a non-empty page title, keyword, or topic. Ask the user what Notion page to find.",
      { details: { field: "query", toolName: "search_notion_pages" }, recoverable: true, sourceRef: undefined },
    );
  }
  const pages: Array<Record<string, unknown>> = [];
  for await (const value of client.search({
    query,
    filter: { property: "object", value: "page" },
  })) {
    if (asString(value.object) === "page") {
      const page = value as NotionPage;
      pages.push({
        pageId: page.id,
        title: findPageTitle(page),
        url: buildNotionUri(page.id, page.url),
        lastEditedTime: page.last_edited_time ?? null,
      });
    }
    if (pages.length >= 10) break;
  }
  return { result: { query, resultCount: pages.length, pages } };
}

async function readPageMarkdown(client: NotionApiClient, pageId: string) {
  const page = await client.retrievePage(pageId);
  const resolver = createNotionTitleResolver(client);
  const properties = await normalizeNotionPageProperties(page.properties, resolver);
  const location = await resolveNotionPageLocation(page, resolver);
  const blocks = await collectBlocksMarkdown(client, page.id);
  const markdown = pageToMarkdown({ page, properties, location, blocksMarkdown: blocks.markdown });
  return { page, properties, location, blocks, markdown };
}

function truncateMarkdown(markdown: string, maxChars: number) {
  if (markdown.length <= maxChars) return { markdown, truncated: false };
  return { markdown: markdown.slice(0, maxChars), truncated: true };
}

async function readPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const pageId = getRequestString(request, "pageId");
  const includeContent = getRequestBoolean(request, "includeContent", true);
  const includeProperties = getRequestBoolean(request, "includeProperties", true);
  const maxChars = getRequestPositiveInteger(request, "maxChars", 20000);
  const read = await readPageMarkdown(client, pageId);
  const markdownResult = includeContent
    ? truncateMarkdown(read.markdown, maxChars)
    : { markdown: "", truncated: false };

  return {
    externalId: `page:${read.page.id}`,
    result: {
      pageId: read.page.id,
      title: findPageTitle(read.page),
      url: buildNotionUri(read.page.id, read.page.url),
      lastEditedTime: read.page.last_edited_time ?? null,
      archived: Boolean(read.page.archived),
      inTrash: Boolean(read.page.in_trash),
      path: read.location.path,
      parent: read.location.parent,
      ...(includeProperties ? { properties: read.properties.values } : {}),
      ...(includeContent ? { markdown: markdownResult.markdown } : {}),
      truncated: markdownResult.truncated,
      contentHash: computeHash(read.markdown),
      skippedBlockTypes: read.blocks.skippedBlockTypes,
      skippedBlockCount: read.blocks.skippedBlockCount,
    },
  };
}

async function archiveTopLevelBlocks(client: NotionApiClient, pageId: string) {
  const blockIds: string[] = [];
  for await (const block of client.listBlockChildren(pageId)) {
    if (!block.archived && !block.in_trash) blockIds.push(block.id);
  }
  for (const blockId of blockIds) {
    await client.updateBlock(blockId, { archived: true });
  }
  return blockIds.length;
}

async function updatePageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const pageId = getRequestString(request, "pageId");
  const content = getRequestString(request, "content", false);
  const mode = getRequestString(request, "mode", false) || "append";
  const properties = asRecord(request.properties);
  if (!content && Object.keys(properties).length === 0) {
    throw new NotionAdapterError(400, "NOTION_ACTION_INPUT_INVALID", "requestJson.content or requestJson.properties is required");
  }
  if (mode !== "append" && mode !== "replace") {
    throw new NotionAdapterError(400, "NOTION_ACTION_INPUT_INVALID", "requestJson.mode must be append or replace");
  }
  if (Object.keys(properties).length > 0) {
    await client.request(`/pages/${encodeURIComponent(pageId)}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
  }
  const replacedBlockCount = content && mode === "replace"
    ? await archiveTopLevelBlocks(client, pageId)
    : 0;
  if (content) await appendMarkdownInBatches(client, pageId, content);
  return {
    externalId: `page:${pageId}`,
    resyncExternalIds: [`page:${pageId}`],
    shouldResync: true,
    result: {
      pageId,
      updated: true,
      mode,
      propertyNames: Object.keys(properties),
      ...(content ? { contentHash: computeHash(content), contentUpdated: true, replacedBlockCount } : {}),
    },
  };
}

async function createFileUploadAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const fileName = getRequestString(request, "fileName");
  const contentType = getRequestString(request, "contentType", false);
  const result = await client.request<Record<string, unknown>>("/file_uploads", {
    method: "POST",
    body: JSON.stringify({
      filename: fileName,
      ...(contentType ? { content_type: contentType } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
    }),
  });
  return {
    externalId: asString(result.id) || null,
    result: {
      fileUploadId: asString(result.id) || null,
      status: asString(result.status) || null,
      uploadUrl: asString(result.upload_url) ? "[redacted]" : null,
      fileName,
    },
  };
}

async function attachFileUploadToPageAction(
  client: NotionApiClient,
  request: Record<string, unknown>,
): Promise<ConnectorActionResult> {
  const pageId = getRequestString(request, "pageId");
  const fileUploadId = getRequestString(request, "fileUploadId");
  const fileName = getRequestString(request, "fileName");
  await client.appendBlockChildren(pageId, [
    {
      object: "block",
      type: "file",
      file: {
        caption: notionRichText(fileName),
        type: "file_upload",
        file_upload: { id: fileUploadId },
      },
    },
  ]);
  return {
    externalId: `page:${pageId}`,
    resyncExternalIds: [`page:${pageId}`],
    shouldResync: true,
    result: { pageId, fileUploadId, attached: true },
  };
}

// ---------------------------------------------------------------------------
// Factory — creates a ConnectorAdapter wired with the given runtime config
// ---------------------------------------------------------------------------

export function createNotionConnectorAdapter(
  config: NotionAdapterRuntimeConfig,
): ConnectorAdapter {
  rc = config;

  return {
    capabilityId: builtinNotionConnectorCapability.id,

    getManifest() {
      return getNotionManifest();
    },

    verifyWebhook(input: ConnectorWebhookVerifyInput) {
      return verifyNotionWebhook(input);
    },

    parseWebhookEvent(input: ConnectorWebhookVerifyInput) {
      return parseNotionWebhookEvent(input);
    },

    mapWebhookEventToSyncTargets(event: ConnectorWebhookPayload) {
      return mapNotionWebhookTargets(event);
    },

    async checkSyncReadiness(input: ConnectorDiscoverInput): Promise<ConnectorSyncReadinessResult> {
      const client = createNotionClient(input);
      const hasPages = await client.hasAccessiblePage();
      if (hasPages) return { ready: true };
      return {
        ready: false,
        reason: "notion_no_pages",
        message: "No Notion pages are shared with this integration. Share at least one page before syncing.",
      };
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

      if (includePages) {
        for await (const value of client.search({
          filter: { property: "object", value: "page" },
        })) {
          const item = toNotionItem(value);
          if (item) yield item;
        }
      }
    },

    async extract(input: ConnectorExtractInput): Promise<ConnectorExtractedContent> {
      const client = createNotionClient(input);
      const object = asString(input.item.metadata.object);
      const notionId = getNotionObjectIdFromItem(input.item);

      if (object === "page") {
        const page = await client.retrievePage(notionId);
        const resolver = createNotionTitleResolver(client);
        const properties = await normalizeNotionPageProperties(page.properties, resolver);
        const location = await resolveNotionPageLocation(page, resolver);
        const directoryPath = buildNotionDirectoryPath({
          connectorId: input.connectorId,
          connectorName: input.connectorName ?? null,
          location,
        });
        const blocks = await collectBlocksMarkdown(client, page.id);
        const markdown = pageToMarkdown({
          page,
          accountLabel: input.connectorName ?? null,
          properties,
          location,
          blocksMarkdown: blocks.markdown,
        });
        return {
          item: {
            ...input.item,
            title: findPageTitle(page),
            externalUri: buildNotionUri(page.id, page.url),
            externalUpdatedAt: parseDate(page.last_edited_time),
            contentHash: computeHash(markdown),
            metadata: {
              ...input.item.metadata,
              provider: "notion",
              connectorName: input.connectorName ?? null,
              notion: {
                id: page.id,
                url: page.url ?? null,
                properties: properties.values,
                emptyPropertyNames: properties.emptyPropertyNames,
                propertySummary: properties.summaryParts,
                parent: location.parent,
                breadcrumb: location.breadcrumb,
                path: location.path,
                parentType: location.parentType,
                containerName: location.containerName,
                directoryExternalIds: directoryPath.map((node) => node.externalId),
                unsupportedPropertyTypes: properties.unsupportedPropertyTypes,
              },
              archived: Boolean(page.archived),
              inTrash: Boolean(page.in_trash),
              parent: page.parent ?? null,
              notionPath: location.path,
              notionPropertySummary: properties.summaryParts,
              skippedBlockTypes: blocks.skippedBlockTypes,
              skippedBlockCount: blocks.skippedBlockCount,
            },
          },
          contentText: markdown,
          markdown,
          parentExternalId: location.parent?.id
            ? `${location.parent.type}:${location.parent.id}`
            : null,
          directoryPath,
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

    async executeAction(input: ConnectorActionInput): Promise<ConnectorActionResult> {
      const client = createNotionClient(input);
      client.clearRawResponseLog();
      let result: ConnectorActionResult;
      switch (input.actionType) {
        case "notion.page.create":
          result = await createPageAction(client, input.request);
          break;
        case "notion.page.save_artifact":
          result = await saveArtifactAction(client, input.request);
          break;
        case "notion.page.save_final_answer":
          result = await createPageAction(client, input.request);
          break;
        case "notion.page.append":
          result = await appendPageAction(client, input.request);
          break;
        case "notion.page.update_properties":
          result = await updatePagePropertiesAction(client, input.request);
          break;
        case "notion.page.trash":
          result = await trashPageAction(client, input.request);
          break;
        case "notion.comment.create":
          result = await createCommentAction(client, input.request);
          break;
        case "notion.data_source.query":
          result = await queryDataSourceAction(client, input.request);
          break;
        case "notion.page.find":
          result = await findPageAction(client, input.request);
          break;
        case "notion.page.read":
          result = await readPageAction(client, input.request);
          break;
        case "notion.page.update":
          result = await updatePageAction(client, input.request);
          break;
        case "notion.file_upload.create":
          result = await createFileUploadAction(client, input.request);
          break;
        case "notion.file_upload.attach_to_page":
          result = await attachFileUploadToPageAction(client, input.request);
          break;
        default:
          throw new NotionAdapterError(
            400,
            "CONNECTOR_ACTION_NOT_SUPPORTED",
            `Notion action '${input.actionType}' is not supported`,
          );
      }
      return { ...result, rawResponseJson: client.getRawResponseLog() };
    },
  };
}
