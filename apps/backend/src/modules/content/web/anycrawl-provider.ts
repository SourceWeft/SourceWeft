import {
  AnyCrawlClient,
  type Engine,
  type SearchResult,
  type ScrapeResult,
} from "@anycrawl/js-sdk";
import type {
  WebFetchProviderInput,
  WebFetchProviderResult,
  WebFetchResultItem,
  WebProvider,
  WebSearchProviderInput,
  WebSearchProviderResult,
  WebSearchResultItem,
} from "./types";
import { validatePublicHttpUrl } from "./url-safety";
import { logger } from "../../../shared/logger";

const SEARCH_MARKDOWN_MAX_CHARS = 12_000;
const SEARCH_LIMIT_MAX = 20;
const SEARCH_WITH_CONTENT_LIMIT_MAX = 10;
const FETCH_MARKDOWN_MAX_CHARS = 50_000;
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 30_000;
const PLAYWRIGHT_FALLBACK_MIN_WORDS = 80;

type AnyCrawlWebProviderOptions = {
  fetchTimeoutMs?: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function wordCount(value: string) {
  const compacted = compactWhitespace(value);
  return compacted ? compacted.split(/\s+/).length : 0;
}

function truncateMarkdown(markdown: string, maxChars: number) {
  if (markdown.length <= maxChars) {
    return { markdown, truncated: false };
  }
  return {
    markdown: markdown.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

function summarizeWordCounts(counts: number[]) {
  if (counts.length === 0) {
    return {
      min: 0,
      max: 0,
      average: 0,
    };
  }

  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    min: Math.min(...counts),
    max: Math.max(...counts),
    average: Math.round(total / counts.length),
  };
}

function normalizeSearchResult(result: SearchResult): WebSearchResultItem | null {
  if (!result.url) {
    return null;
  }

  const url = validatePublicHttpUrl(result.url);
  const title = compactWhitespace(result.title || url);
  const snippet = compactWhitespace(result.description ?? result.markdown ?? "");
  const markdownSource = result.markdown ?? "";
  const { markdown, truncated } = truncateMarkdown(markdownSource, SEARCH_MARKDOWN_MAX_CHARS);
  const markdownWordCount = wordCount(markdownSource);

  return {
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(markdown ? { markdown } : {}),
    ...(markdownWordCount > 0 ? { wordCount: markdownWordCount, truncated } : {}),
    ...(result.source ? { source: result.source } : {}),
  };
}

function extractDescription(result: ScrapeResult) {
  if (result.status !== "completed") {
    return undefined;
  }

  if (!Array.isArray(result.metadata)) {
    return undefined;
  }

  for (const item of result.metadata) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key of ["description", "og:description", "twitter:description"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return compactWhitespace(value);
      }
    }
  }

  return undefined;
}

function normalizeFetchResult(url: string, result: ScrapeResult): WebFetchResultItem {
  if (result.status === "failed") {
    return {
      url,
      markdown: "",
      wordCount: 0,
      truncated: false,
      error: result.error,
    };
  }

  const { markdown, truncated } = truncateMarkdown(
    result.markdown ?? "",
    FETCH_MARKDOWN_MAX_CHARS,
  );
  return {
    url: result.url || url,
    ...(result.title ? { title: compactWhitespace(result.title) } : {}),
    ...(extractDescription(result) ? { description: extractDescription(result) } : {}),
    markdown,
    wordCount: wordCount(result.markdown ?? ""),
    truncated,
  };
}

function shouldFallbackToPlaywright(result: WebFetchResultItem) {
  return Boolean(result.error) || result.wordCount < PLAYWRIGHT_FALLBACK_MIN_WORDS;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex] as T, currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function createTimeoutError(timeoutMs: number) {
  const error = new Error(
    timeoutMs >= 1_000
      ? `Web fetch timed out after ${Math.round(timeoutMs / 1000)}s.`
      : `Web fetch timed out after ${timeoutMs}ms.`,
  );
  error.name = "TimeoutError";
  return error;
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && error.name === "TimeoutError";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(createTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export class AnyCrawlWebProvider implements WebProvider {
  readonly name = "anycrawl";
  private client: AnyCrawlClient;
  private fetchTimeoutMs: number;

  constructor(apiKey: string, options: AnyCrawlWebProviderOptions = {}) {
    this.client = new AnyCrawlClient(apiKey);
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  }

  async search(input: WebSearchProviderInput): Promise<WebSearchProviderResult> {
    const query = compactWhitespace(input.query);
    const includeContent = input.includeContent !== false;
    const fresh = input.fresh === true;
    const limit = clamp(
      input.limit,
      1,
      includeContent ? SEARCH_WITH_CONTENT_LIMIT_MAX : SEARCH_LIMIT_MAX,
    );
    const pages = Math.max(1, Math.ceil(limit / 10));
    const scrapeOptions = includeContent
      ? {
          engine: "cheerio" as const,
          formats: ["markdown" as const],
          only_main_content: true,
          ...(fresh ? { max_age: 0 } : {}),
        }
      : undefined;
    const searchRequest = {
      query,
      engine: "google",
      pages,
      limit,
      ...(scrapeOptions ? { scrape_options: scrapeOptions } : {}),
      ...(input.lang ? { lang: input.lang } : {}),
      ...(input.country ? { country: input.country } : {}),
    } as const;

    logger.debug("AnyCrawl web search request", {
      provider: this.name,
      queryLength: query.length,
      limit,
      pages,
      includeContent,
      fresh,
      scrapeOptionsSent: Boolean(searchRequest.scrape_options),
      scrapeEngine: searchRequest.scrape_options?.engine ?? null,
      scrapeFormats: searchRequest.scrape_options?.formats ?? null,
      onlyMainContent: searchRequest.scrape_options?.only_main_content ?? null,
      maxAgeMs: searchRequest.scrape_options && "max_age" in searchRequest.scrape_options
        ? searchRequest.scrape_options.max_age
        : null,
      lang: input.lang ?? null,
      country: input.country ?? null,
    });

    const results = await this.client.search(searchRequest);

    const normalized = results
      .map((result) => {
        try {
          return normalizeSearchResult(result);
        } catch {
          return null;
        }
      })
      .filter((item): item is WebSearchResultItem => item !== null)
      .slice(0, limit);

    const markdownWordCounts = normalized
      .map((result) => result.wordCount ?? 0)
      .filter((count) => count > 0);
    logger.debug("AnyCrawl web search response", {
      provider: this.name,
      queryLength: query.length,
      includeContent,
      fresh,
      requestedLimit: limit,
      rawResultCount: results.length,
      normalizedResultCount: normalized.length,
      markdownResultCount: markdownWordCounts.length,
      missingMarkdownCount: Math.max(0, normalized.length - markdownWordCounts.length),
      markdownWordCounts: summarizeWordCounts(markdownWordCounts),
      truncatedResultCount: normalized.filter((result) => result.truncated === true).length,
    });

    return {
      provider: this.name,
      query,
      count: normalized.length,
      results: normalized,
    };
  }

  async fetch(input: WebFetchProviderInput): Promise<WebFetchProviderResult> {
    const fresh = input.fresh === true;
    const items = input.items.slice(0, FETCH_CONCURRENCY).map((item) => ({
      ...item,
      url: validatePublicHttpUrl(item.url),
    }));

    const results = await mapWithConcurrency(
      items,
      FETCH_CONCURRENCY,
      async (item): Promise<WebFetchResultItem> => {
        try {
          return await this.fetchOne(item.url, fresh);
        } catch (error) {
          return {
            url: item.url,
            markdown: "",
            wordCount: 0,
            truncated: false,
            error: error instanceof Error ? error.message : "Failed to fetch web page.",
          };
        }
      },
    );

    return {
      provider: this.name,
      count: results.filter((result) => !result.error).length,
      results,
    };
  }

  private remainingTimeoutMs(deadlineMs: number) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      throw createTimeoutError(this.fetchTimeoutMs);
    }
    return Math.min(this.fetchTimeoutMs, remaining);
  }

  private async scrape(url: string, engine: Engine, deadlineMs: number, fresh: boolean) {
    const timeoutMs = this.remainingTimeoutMs(deadlineMs);
    return withTimeout(
      this.client.scrape({
        url,
        engine,
        formats: ["markdown"],
        only_main_content: true,
        timeout: timeoutMs,
        ...(fresh ? { max_age: 0 } : {}),
      }),
      timeoutMs,
    );
  }

  private async fetchOne(url: string, fresh: boolean) {
    const deadlineMs = Date.now() + this.fetchTimeoutMs;
    try {
      const autoResult = normalizeFetchResult(
        url,
        await this.scrape(url, "auto", deadlineMs, fresh),
      );
      if (!shouldFallbackToPlaywright(autoResult)) {
        return autoResult;
      }
    } catch (error) {
      if (isTimeoutError(error)) {
        throw error;
      }
      // Retry with a browser engine when the default extraction path cannot extract usable content.
    }

    return normalizeFetchResult(
      url,
      await this.scrape(url, "playwright", deadlineMs, fresh),
    );
  }
}
