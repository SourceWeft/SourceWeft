import type {
  WebFetchProviderInput,
  WebFetchProviderResult,
  WebFetchResultItem,
  WebProvider,
  WebSearchProviderInput,
  WebSearchProviderResult,
  WebSearchResultItem,
} from "../types";
import { validatePublicHttpUrl } from "../url-safety";
import {
  clamp,
  compactWhitespace,
  mapWithConcurrency,
  truncateMarkdown,
  wordCount,
} from "./shared";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const QUERY_MAX_CHARS = 128;
const SEARCH_COUNT_MAX = 50;
const SEARCH_WITH_CONTENT_COUNT_MAX = 10;
const SEARCH_MARKDOWN_MAX_CHARS = 12_000;
const FETCH_MARKDOWN_MAX_CHARS = 50_000;
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 30_000;
const RETRY_DELAY_DEFAULT_MS = 1_000;
const RETRY_DELAY_MAX_MS = 5_000;
const LANG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

export type DeepSeekWebProviderOptions = {
  fetchTimeoutMs?: number;
  baseUrl?: string;
  /** Test seam: replaces the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overrides the 429 retry delay (otherwise `Retry-After`, capped at 5 s). */
  retryDelayMs?: number;
};

type DeepSeekSearchHit = {
  rerank_score?: number;
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string;
  date?: string;
};

type DeepSeekFetchBody = { title?: string; content?: string };

function isTimeoutLike(error: unknown) {
  return (
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function readErrorMessage(response: Response) {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") {
        detail = parsed.error.message;
      }
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    // The status code alone is still a useful message.
  }
  return detail ? `${response.status} ${compactWhitespace(detail)}` : String(response.status);
}

function buildQuery(rawQuery: string, lang: string | undefined) {
  const base = compactWhitespace(rawQuery);
  const suffix = lang && LANG_PATTERN.test(lang) ? ` lang:${lang}` : "";
  const room = Math.max(1, QUERY_MAX_CHARS - Array.from(suffix).length);
  const sent = Array.from(base).slice(0, room).join("").trimEnd() + suffix;
  return { base, sent };
}

function normalizeSearchHit(hit: DeepSeekSearchHit): WebSearchResultItem | null {
  if (!hit.url) {
    return null;
  }
  let url: string;
  try {
    url = validatePublicHttpUrl(hit.url);
  } catch {
    return null;
  }

  const title = compactWhitespace(hit.title || url);
  const snippet = compactWhitespace(hit.snippet || hit.summary || "");
  const source = hit.content ?? "";
  const { markdown, truncated } = truncateMarkdown(source, SEARCH_MARKDOWN_MAX_CHARS);
  const words = wordCount(source);

  return {
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(markdown ? { markdown } : {}),
    ...(words > 0 ? { wordCount: words, truncated } : {}),
    ...(hit.date ? { publishedAt: hit.date } : {}),
    ...(hit.site_name ? { source: hit.site_name } : {}),
  };
}

export class DeepSeekWebProvider implements WebProvider {
  readonly name = "deepseek";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fetchTimeoutMs: number;
  private readonly retryDelayMs: number | undefined;

  constructor(apiKey: string, options: DeepSeekWebProviderOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs;
  }

  async search(input: WebSearchProviderInput): Promise<WebSearchProviderResult> {
    const includeContent = input.includeContent !== false;
    const count = clamp(
      input.limit,
      1,
      includeContent ? SEARCH_WITH_CONTENT_COUNT_MAX : SEARCH_COUNT_MAX,
    );
    const { base, sent } = buildQuery(input.query, input.lang);

    const response = await this.post("/v1/tools/search", {
      query: sent,
      count,
      need_content: includeContent,
    });
    if (!response.ok) {
      throw new Error(`DeepSeek search failed: ${await readErrorMessage(response)}`);
    }

    const body = (await response.json()) as { results?: DeepSeekSearchHit[] };
    const hits = Array.isArray(body.results) ? body.results : [];
    const results = hits
      .map((hit, index) => ({ hit, index }))
      .sort(
        (a, b) =>
          (b.hit.rerank_score ?? 0) - (a.hit.rerank_score ?? 0) || a.index - b.index,
      )
      .map(({ hit }) => normalizeSearchHit(hit))
      .filter((item): item is WebSearchResultItem => item !== null)
      .slice(0, count);

    return { provider: this.name, query: base, count: results.length, results };
  }

  async fetch(input: WebFetchProviderInput): Promise<WebFetchProviderResult> {
    const items = input.items.slice(0, FETCH_CONCURRENCY);
    const results = await mapWithConcurrency(
      [...items],
      FETCH_CONCURRENCY,
      (item) => this.fetchOne(item.url),
    );
    return {
      provider: this.name,
      count: results.filter((result) => !result.error).length,
      results,
    };
  }

  private async fetchOne(rawUrl: string): Promise<WebFetchResultItem> {
    const failed = (url: string, error: string): WebFetchResultItem => ({
      url,
      markdown: "",
      wordCount: 0,
      truncated: false,
      error,
    });

    let url: string;
    try {
      url = validatePublicHttpUrl(rawUrl);
    } catch (error) {
      return failed(rawUrl, error instanceof Error ? error.message : "Invalid URL.");
    }

    try {
      let response = await this.post("/v1/tools/fetch", { url });
      if (response.status === 429) {
        await this.sleep(this.retryDelay(response));
        response = await this.post("/v1/tools/fetch", { url });
      }
      if (!response.ok) {
        return failed(url, `DeepSeek fetch failed: ${await readErrorMessage(response)}`);
      }

      const body = (await response.json()) as DeepSeekFetchBody;
      const content = body.content ?? "";
      if (!content.trim()) {
        return failed(url, "DeepSeek returned no content for this URL.");
      }
      const { markdown, truncated } = truncateMarkdown(content, FETCH_MARKDOWN_MAX_CHARS);
      const title = compactWhitespace(body.title ?? "");
      return {
        url,
        ...(title ? { title } : {}),
        markdown,
        wordCount: wordCount(content),
        truncated,
      };
    } catch (error) {
      if (isTimeoutLike(error)) {
        return failed(url, `Web fetch timed out after ${this.fetchTimeoutMs}ms.`);
      }
      return failed(url, error instanceof Error ? error.message : "Failed to fetch web page.");
    }
  }

  private post(path: string, body: Record<string, unknown>) {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
    });
  }

  private retryDelay(response: Response) {
    if (this.retryDelayMs !== undefined) {
      return this.retryDelayMs;
    }
    const seconds = Number(response.headers.get("Retry-After"));
    if (Number.isFinite(seconds) && seconds > 0) {
      return clamp(seconds * 1_000, 0, RETRY_DELAY_MAX_MS);
    }
    return RETRY_DELAY_DEFAULT_MS;
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
