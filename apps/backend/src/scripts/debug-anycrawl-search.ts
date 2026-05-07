import "dotenv/config";
import { AnyCrawlClient } from "@anycrawl/js-sdk";

const API_BASE_URL = "https://api.anycrawl.dev";
const DEFAULT_QUERY = "今日黄金价格 2026年5月7日";
const DEFAULT_LIMIT = 5;

type SearchResultRecord = {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  source?: unknown;
  markdown?: unknown;
  html?: unknown;
  text?: unknown;
  status?: unknown;
  error?: unknown;
  jobId?: unknown;
};

type SearchApiResponse = {
  success?: boolean;
  data?: SearchResultRecord[];
  error?: unknown;
  message?: unknown;
};

function readArg(name: string) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function wordCount(value: unknown) {
  if (typeof value !== "string") {
    return 0;
  }
  const compacted = compactWhitespace(value);
  return compacted ? compacted.split(/\s+/).length : 0;
}

function numericArg(name: string, fallback: number) {
  const raw = readArg(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function searchPayload(input: { query: string; limit: number; pages: number; fresh: boolean }) {
  const maxAgeMs = input.fresh ? 0 : undefined;
  return {
    query: input.query,
    engine: "google" as const,
    pages: input.pages,
    limit: input.limit,
    scrape_options: {
      engine: "cheerio" as const,
      formats: ["markdown" as const],
      only_main_content: true,
      ...(maxAgeMs === undefined ? {} : { max_age: maxAgeMs }),
    },
  };
}

function summarizeResults(label: string, results: SearchResultRecord[]) {
  const markdownCounts = results.map((result) => wordCount(result.markdown));
  const markdownResultCount = markdownCounts.filter((count) => count > 0).length;
  const statusCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();

  for (const result of results) {
    const status = typeof result.status === "string" ? result.status : "(missing)";
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    const source = typeof result.source === "string" ? result.source : "(missing)";
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }

  console.log(`\n[${label}] summary`);
  console.log({
    resultCount: results.length,
    markdownResultCount,
    missingMarkdownCount: results.length - markdownResultCount,
    markdownWordCounts: {
      min: markdownCounts.length ? Math.min(...markdownCounts) : 0,
      max: markdownCounts.length ? Math.max(...markdownCounts) : 0,
      values: markdownCounts,
    },
    statusCounts: Object.fromEntries(statusCounts),
    sourceCounts: Object.fromEntries(sourceCounts),
  });

  results.forEach((result, index) => {
    const keys = Object.keys(result).sort();
    const markdown = typeof result.markdown === "string" ? result.markdown : "";
    console.log(`\n[${label}] result ${index + 1}`);
    console.log({
      title: result.title,
      url: result.url,
      source: result.source,
      status: result.status,
      error: result.error,
      jobId: result.jobId,
      keys,
      markdownChars: markdown.length,
      markdownWords: wordCount(markdown),
      markdownPreview: markdown ? compactWhitespace(markdown).slice(0, 240) : "",
    });
  });
}

async function runSdk(input: {
  apiKey: string;
  query: string;
  limit: number;
  pages: number;
  fresh: boolean;
}) {
  const payload = searchPayload(input);
  console.log("\n[sdk] request");
  console.log(payload);

  const client = new AnyCrawlClient(input.apiKey);
  const results = await client.search(payload);
  summarizeResults("sdk", results as SearchResultRecord[]);
  return results as SearchResultRecord[];
}

async function runHttp(input: {
  apiKey: string;
  query: string;
  limit: number;
  pages: number;
  fresh: boolean;
}) {
  const payload = searchPayload(input);
  console.log("\n[http] request");
  console.log(payload);

  const response = await fetch(`${API_BASE_URL}/v1/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await response.json() as SearchApiResponse;
  console.log("\n[http] response envelope");
  console.log({
    status: response.status,
    ok: response.ok,
    success: json.success,
    error: json.error,
    message: json.message,
  });
  const results = Array.isArray(json.data) ? json.data : [];
  summarizeResults("http", results);
  return results;
}

async function scrapeFirst(input: {
  apiKey: string;
  results: SearchResultRecord[];
  fresh: boolean;
}) {
  const firstUrl = input.results
    .map((result) => result.url)
    .find((url): url is string => typeof url === "string" && url.startsWith("http"));
  if (!firstUrl) {
    console.log("\n[scrape-first] no URL available");
    return;
  }

  const client = new AnyCrawlClient(input.apiKey);
  const scrapePayload = {
    url: firstUrl,
    engine: "cheerio" as const,
    formats: ["markdown" as const],
    only_main_content: true,
    ...(input.fresh ? { max_age: 0 } : {}),
  };
  console.log("\n[scrape-first] request");
  console.log({
    ...scrapePayload,
    max_age: input.fresh ? 0 : "(omitted)",
  });
  const result = await client.scrape(scrapePayload);
  console.log("\n[scrape-first] response");
  console.log({
    url: result.url,
    status: result.status,
    title: result.status === "completed" ? result.title : undefined,
    error: result.status === "failed" ? result.error : undefined,
    markdownChars: result.status === "completed" ? result.markdown.length : 0,
    markdownWords: result.status === "completed" ? wordCount(result.markdown) : 0,
    markdownPreview: result.status === "completed"
      ? compactWhitespace(result.markdown).slice(0, 240)
      : "",
  });
}

async function main() {
  const apiKey = process.env.ANYCRAWL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANYCRAWL_API_KEY is required.");
  }

  const query = readArg("query") ?? process.argv[2] ?? DEFAULT_QUERY;
  const limit = numericArg("limit", DEFAULT_LIMIT);
  const pages = numericArg("pages", Math.max(1, Math.ceil(limit / 10)));
  const mode = readArg("mode") ?? "both";
  const fresh = hasFlag("fresh");

  console.log("[config]", {
    query,
    limit,
    pages,
    mode,
    fresh,
    searchMaxAgeMs: fresh ? 0 : "(omitted)",
    scrapeFirst: hasFlag("scrape-first"),
  });

  let results: SearchResultRecord[] = [];
  if (mode === "sdk" || mode === "both") {
    results = await runSdk({ apiKey, query, limit, pages, fresh });
  }
  if (mode === "http" || mode === "both") {
    results = await runHttp({ apiKey, query, limit, pages, fresh });
  }
  if (hasFlag("scrape-first")) {
    await scrapeFirst({ apiKey, results, fresh });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
