import { buildParsedDocument } from "./build-parsed-document";
import { ParserContentError } from "./errors";
import { BaseSourceParser } from "./base";
import type { ParsedDocument, ParseInput, WebFetchProviderLike } from "./types";
import { validatePublicHttpUrl } from "./web-url-safety";

export const WEB_FETCH_SOURCE_MIME_TYPE = "text/x-sourceweft-web-url";

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function resolveWebSourceTitle(input: {
  readonly requestedTitle?: string;
  readonly preferRequestedTitle?: boolean;
  readonly fetchedTitle?: string;
  readonly url: string;
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
    return parsed.hostname.replace(/^www\./u, "") || input.url;
  } catch {
    return input.url;
  }
}

function buildWebSourceMarkdown(input: {
  readonly title: string;
  readonly url: string;
  readonly markdown: string;
}) {
  const markdown = input.markdown.trim();
  return markdown
    ? [`# ${input.title}`, `Source: ${input.url}`, markdown].join("\n\n")
    : "";
}

function validateWebSourceUrl(value: string) {
  try {
    return validatePublicHttpUrl(value);
  } catch (error) {
    if (error instanceof Error) {
      throw new ParserContentError(
        400,
        "WEB_SOURCE_URL_INVALID",
        error.message,
      );
    }
    throw error;
  }
}

export class WebFetchSourceParser extends BaseSourceParser {
  readonly id = "web-fetch";
  readonly name = "Web Fetch Parser";
  readonly supportedMimeTypes = [WEB_FETCH_SOURCE_MIME_TYPE] as const;

  constructor(
    private readonly createProvider: () =>
      | WebFetchProviderLike
      | null
      | Promise<WebFetchProviderLike | null>,
  ) {
    super();
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const provider = await this.createProvider();
    if (!provider) {
      throw new ParserContentError(
        503,
        "WEB_PROVIDER_NOT_CONFIGURED",
        "Web source ingestion is not configured",
      );
    }
    if (!input.sourceExternalUri) {
      throw new ParserContentError(
        400,
        "WEB_SOURCE_URL_MISSING",
        "Web source URL is missing",
      );
    }
    const requestedUrl = validateWebSourceUrl(input.sourceExternalUri);
    const fetched = await provider.fetch({
      ...(input.forceRefresh ? { fresh: true } : {}),
      items: [{ url: requestedUrl }],
    });
    const result = fetched.results[0];
    if (!result) {
      throw new ParserContentError(
        502,
        "WEB_SOURCE_FETCH_FAILED",
        "Failed to fetch web page",
      );
    }
    if (result.error) {
      throw new ParserContentError(
        502,
        "WEB_SOURCE_FETCH_FAILED",
        result.error,
      );
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
      throw new ParserContentError(
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
