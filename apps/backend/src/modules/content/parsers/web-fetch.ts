import { createDefaultWebProvider, validatePublicHttpUrl } from "../web";
import type { WebProvider } from "../web";
import { ContentError } from "../errors";
import { buildParsedDocument } from "./providers/utils";
import { BaseSourceParser } from "./base";
import type { ParsedDocument, ParseInput } from "./types";

export const WEB_FETCH_SOURCE_MIME_TYPE = "text/x-sourceweft-web-url";
const WEB_FETCH_SOURCE_TIMEOUT_MS = 60_000;

function createWebFetchSourceProvider() {
  return createDefaultWebProvider({
    fetchTimeoutMs: WEB_FETCH_SOURCE_TIMEOUT_MS,
  });
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function resolveWebSourceTitle(input: {
  requestedTitle?: string;
  preferRequestedTitle?: boolean;
  fetchedTitle?: string;
  url: string;
}) {
  const requestedTitle = compactWhitespace(input.requestedTitle ?? "");
  if (requestedTitle && input.preferRequestedTitle === true) {
    return requestedTitle;
  }

  const fetchedTitle = compactWhitespace(input.fetchedTitle ?? "");
  if (fetchedTitle) {
    return fetchedTitle;
  }

  try {
    const parsed = new URL(input.url);
    return parsed.hostname.replace(/^www\./, "") || input.url;
  } catch {
    return input.url;
  }
}

function buildWebSourceMarkdown(input: {
  title: string;
  url: string;
  markdown: string;
}) {
  const markdown = input.markdown.trim();
  if (!markdown) {
    return "";
  }

  return [`# ${input.title}`, `Source: ${input.url}`, markdown].join("\n\n");
}

export class WebFetchSourceParser extends BaseSourceParser {
  readonly id = "web-fetch";
  readonly name = "Web Fetch Parser";
  readonly supportedMimeTypes = [WEB_FETCH_SOURCE_MIME_TYPE] as const;

  constructor(
    private readonly createProvider: () => WebProvider | null = createWebFetchSourceProvider,
  ) {
    super();
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const provider = this.createProvider();
    if (!provider) {
      throw new ContentError(
        503,
        "WEB_PROVIDER_NOT_CONFIGURED",
        "Web source ingestion is not configured",
      );
    }

    if (!input.sourceExternalUri) {
      throw new ContentError(
        400,
        "WEB_SOURCE_URL_MISSING",
        "Web source URL is missing",
      );
    }

    const requestedUrl = validatePublicHttpUrl(input.sourceExternalUri);
    const fetched = await provider.fetch({
      ...(input.forceRefresh ? { fresh: true } : {}),
      items: [{ url: requestedUrl }],
    });
    const result = fetched.results[0];
    if (!result) {
      throw new ContentError(
        502,
        "WEB_SOURCE_FETCH_FAILED",
        "Failed to fetch web page",
      );
    }
    if (result.error) {
      throw new ContentError(502, "WEB_SOURCE_FETCH_FAILED", result.error);
    }

    const sourceUrl = result.url || requestedUrl;
    const title = resolveWebSourceTitle({
      requestedTitle: input.fileName,
      preferRequestedTitle: input.preferInputTitle === true,
      fetchedTitle: result.title,
      url: sourceUrl,
    });
    const content = buildWebSourceMarkdown({
      title,
      url: sourceUrl,
      markdown: result.markdown,
    });
    if (!content.trim()) {
      throw new ContentError(
        422,
        "WEB_SOURCE_CONTENT_EMPTY",
        "No markdown content could be extracted from this URL",
      );
    }

    return buildParsedDocument({
      parseInput: {
        ...input,
        fileName: title,
        mimeType: WEB_FETCH_SOURCE_MIME_TYPE,
        fileSize: Buffer.byteLength(content, "utf8"),
      },
      title,
      content,
      metadata: {
        parserId: this.id,
        provider: fetched.provider,
        sourceUrl,
        requestedUrl,
        description: result.description,
        wordCount: result.wordCount,
        truncated: result.truncated,
        fetchedAt: new Date().toISOString(),
      },
    });
  }
}

export const webFetchSourceParser = new WebFetchSourceParser();
