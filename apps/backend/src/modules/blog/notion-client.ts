import { config } from "../../shared/config";

export type NotionRichText = {
  plain_text?: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
  };
};

export type NotionFileObject = {
  name?: string;
  type?: "file" | "external";
  file?: { url?: string; expiry_time?: string };
  external?: { url?: string };
};

export type NotionPage = {
  id: string;
  object: "page";
  created_time?: string;
  last_edited_time?: string;
  cover?: NotionBlockFile | null;
  properties: Record<string, NotionProperty>;
};

export type NotionBlockFile = {
  type: "external" | "file";
  external?: { url?: string };
  file?: { url?: string; expiry_time?: string };
};

export type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
};

export type NotionProperty =
  | { type: "checkbox"; checkbox?: boolean }
  | { type: "rich_text"; rich_text?: NotionRichText[] }
  | { type: "title"; title?: NotionRichText[] }
  | { type: "select"; select?: { name?: string } | null }
  | { type: "status"; status?: { name?: string } | null }
  | { type: "multi_select"; multi_select?: Array<{ name?: string }> }
  | { type: "date"; date?: { start?: string; end?: string | null } | null }
  | { type: "url"; url?: string | null }
  | { type: "files"; files?: NotionFileObject[] }
  | { type: "people"; people?: Array<{ name?: string }> }
  | { type: "created_time"; created_time?: string }
  | { type: "last_edited_time"; last_edited_time?: string }
  | { type: string; [key: string]: unknown };

export type NotionDataSource = {
  id?: string;
  properties?: Record<
    string,
    {
      type?: string;
      select?: { options?: Array<{ name?: string }> };
      status?: { options?: Array<{ name?: string }> };
    }
  >;
};

type NotionDatabase = {
  data_sources?: Array<{ id?: string; name?: string }>;
  initial_data_source?: { id?: string; name?: string };
};

let resolvedBlogDataSourceId: string | null = null;

function requireNotionConfig() {
  const missing = [
    ["NOTION_BLOG_API_KEY", config.blog.notionApiKey],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing Notion blog configuration: ${missing.map(([name]) => name).join(", ")}`,
    );
  }

  if (!config.blog.notionDatabaseId && !config.blog.notionDataSourceId) {
    throw new Error(
      "Missing Notion blog configuration: NOTION_BLOG_DATABASE_ID",
    );
  }
}

async function notionRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  requireNotionConfig();

  const response = await fetch(`${config.blog.notionApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.blog.notionApiKey}`,
      "Content-Type": "application/json",
      "Notion-Version": config.blog.notionVersion,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Notion request failed ${response.status} ${response.statusText}: ${body}`,
    );
  }

  return (await response.json()) as T;
}

async function getBlogDataSourceId() {
  if (resolvedBlogDataSourceId) {
    return resolvedBlogDataSourceId;
  }

  if (config.blog.notionDataSourceId) {
    resolvedBlogDataSourceId = config.blog.notionDataSourceId;
    return resolvedBlogDataSourceId;
  }

  const database = await notionRequest<NotionDatabase>(
    `/v1/databases/${config.blog.notionDatabaseId}`,
  );
  const dataSourceId =
    database.initial_data_source?.id ?? database.data_sources?.[0]?.id;

  if (!dataSourceId) {
    throw new Error(
      `Notion database ${config.blog.notionDatabaseId} does not expose a data source. Create the blog data source first and retry.`,
    );
  }

  resolvedBlogDataSourceId = dataSourceId;
  return resolvedBlogDataSourceId;
}

export async function getBlogDataSource() {
  const dataSourceId = await getBlogDataSourceId();
  return notionRequest<NotionDataSource>(`/v1/data_sources/${dataSourceId}`);
}

export async function queryBlogPages(input: {
  filter?: Record<string, unknown>;
}) {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      sorts: [
        {
          property: "Published At",
          direction: "descending",
        },
      ],
    };

    if (cursor) {
      body.start_cursor = cursor;
    }

    if (input.filter) {
      body.filter = input.filter;
    }

    const dataSourceId = await getBlogDataSourceId();
    const result = await notionRequest<{
      results: NotionPage[];
      has_more: boolean;
      next_cursor?: string | null;
    }>(`/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    pages.push(...result.results.filter((page) => page.object === "page"));
    cursor = result.next_cursor ?? undefined;
  } while (cursor);

  return pages;
}

export async function listBlockChildren(blockId: string) {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;

  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) {
      query.set("start_cursor", cursor);
    }

    const result = await notionRequest<{
      results: NotionBlock[];
      has_more: boolean;
      next_cursor?: string | null;
    }>(`/v1/blocks/${blockId}/children?${query.toString()}`);

    blocks.push(...result.results);
    cursor = result.next_cursor ?? undefined;
  } while (cursor);

  return blocks;
}
