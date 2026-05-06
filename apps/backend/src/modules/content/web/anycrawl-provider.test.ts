import assert from "node:assert/strict";
import test from "node:test";
import { AnyCrawlWebProvider } from "./anycrawl-provider";

test("AnyCrawlWebProvider fetch starts up to 5 scrapes concurrently", async () => {
  const provider = new AnyCrawlWebProvider("test-key");
  let active = 0;
  let maxActive = 0;
  const startedUrls: string[] = [];
  const releases: Array<() => void> = [];

  (provider as unknown as {
    client: {
      scrape(input: { url: string; engine?: string; timeout?: number }): Promise<unknown>;
    };
  }).client = {
    async scrape(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      startedUrls.push(input.url);

      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });

      active -= 1;
      return {
        status: "completed",
        url: input.url,
        title: input.url,
        markdown: `Content for ${input.url} ${"word ".repeat(100)}`,
        metadata: [],
      };
    },
  };

  const fetchPromise = provider.fetch({
    items: Array.from({ length: 5 }, (_, index) => ({
      url: `https://example.com/page-${index}`,
    })),
  });

  await waitFor(() => startedUrls.length === 5);
  assert.equal(maxActive, 5);
  assert.deepEqual(startedUrls, [
    "https://example.com/page-0",
    "https://example.com/page-1",
    "https://example.com/page-2",
    "https://example.com/page-3",
    "https://example.com/page-4",
  ]);

  for (const release of releases) {
    release();
  }
  const result = await fetchPromise;
  assert.equal(result.results.length, 5);
  assert.equal(result.count, 5);
});

test("AnyCrawlWebProvider search requests cheerio main content enrichment", async () => {
  const provider = new AnyCrawlWebProvider("test-key");
  const observedInputs: Array<{
    query: string;
    limit?: number;
    pages?: number;
    scrape_options?: {
      engine?: string;
      formats?: string[];
      only_main_content?: boolean;
    };
  }> = [];

  (provider as unknown as {
    client: {
      search(input: {
        query: string;
        limit?: number;
        pages?: number;
        scrape_options?: {
          engine?: string;
          formats?: string[];
          only_main_content?: boolean;
        };
      }): Promise<unknown>;
    };
  }).client = {
    async search(input) {
      observedInputs.push(input);
      return [{
        title: "Example",
        url: "https://example.com/result",
        description: "Snippet",
        source: "example",
        markdown: "Main content ".repeat(100),
      }];
    },
  };

  const result = await provider.search({
    query: "example query",
    limit: 20,
  });

  assert.equal(result.results.length, 1);
  assert.equal(observedInputs[0]?.limit, 20);
  assert.equal(observedInputs[0]?.pages, 2);
  assert.deepEqual(observedInputs[0]?.scrape_options, {
    engine: "cheerio",
    formats: ["markdown"],
    only_main_content: true,
  });
  assert.match(result.results[0]?.markdown ?? "", /Main content/);
  assert.equal(result.results[0]?.wordCount, 200);
  assert.equal(result.results[0]?.truncated, false);
});

test("AnyCrawlWebProvider search allows 20 results", async () => {
  const provider = new AnyCrawlWebProvider("test-key");
  let observedLimit = 0;

  (provider as unknown as {
    client: {
      search(input: { limit?: number }): Promise<unknown>;
    };
  }).client = {
    async search(input) {
      observedLimit = input.limit ?? 0;
      return Array.from({ length: 20 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/result-${index}`,
        description: "Snippet",
        source: "example",
        markdown: "Main content ".repeat(10),
      }));
    },
  };

  const result = await provider.search({
    query: "example query",
    limit: 20,
  });

  assert.equal(observedLimit, 20);
  assert.equal(result.count, 20);
  assert.equal(result.results.length, 20);
});

test("AnyCrawlWebProvider fetch only accepts the first 5 URLs", async () => {
  const provider = new AnyCrawlWebProvider("test-key");
  const startedUrls: string[] = [];

  (provider as unknown as {
    client: {
      scrape(input: { url: string; engine?: string; timeout?: number }): Promise<unknown>;
    };
  }).client = {
    async scrape(input) {
      startedUrls.push(input.url);
      return {
        status: "completed",
        url: input.url,
        title: input.url,
        markdown: `Content for ${input.url} ${"word ".repeat(100)}`,
        metadata: [],
      };
    },
  };

  const result = await provider.fetch({
    items: Array.from({ length: 7 }, (_, index) => ({
      url: `https://example.com/page-${index}`,
    })),
  });

  assert.equal(result.results.length, 5);
  assert.equal(result.count, 5);
  assert.deepEqual(startedUrls, [
    "https://example.com/page-0",
    "https://example.com/page-1",
    "https://example.com/page-2",
    "https://example.com/page-3",
    "https://example.com/page-4",
  ]);
});

test("AnyCrawlWebProvider fetch uses cheerio with a 30s scrape timeout by default", async () => {
  const provider = new AnyCrawlWebProvider("test-key");
  const observedInputs: Array<{ url: string; engine?: string; timeout?: number }> = [];

  (provider as unknown as {
    client: {
      scrape(input: { url: string; engine?: string; timeout?: number }): Promise<unknown>;
    };
  }).client = {
    async scrape(input) {
      observedInputs.push(input);
      return {
        status: "completed",
        url: input.url,
        title: input.url,
        markdown: "word ".repeat(100),
        metadata: [],
      };
    },
  };

  const result = await provider.fetch({
    items: [{ url: "https://example.com/static" }],
  });

  assert.equal(result.count, 1);
  assert.equal(observedInputs.length, 1);
  assert.equal(observedInputs[0]?.engine, "cheerio");
  assert.equal(observedInputs[0]?.timeout, 30_000);
});

test("AnyCrawlWebProvider fetch falls back to playwright when cheerio content is too small", async () => {
  const provider = new AnyCrawlWebProvider("test-key");
  const observedEngines: string[] = [];

  (provider as unknown as {
    client: {
      scrape(input: { url: string; engine?: string; timeout?: number }): Promise<unknown>;
    };
  }).client = {
    async scrape(input) {
      observedEngines.push(input.engine ?? "");
      return {
        status: "completed",
        url: input.url,
        title: input.url,
        markdown: input.engine === "cheerio" ? "short" : "word ".repeat(100),
        metadata: [],
      };
    },
  };

  const result = await provider.fetch({
    items: [{ url: "https://example.com/spa" }],
  });

  assert.equal(result.count, 1);
  assert.deepEqual(observedEngines, ["cheerio", "playwright"]);
  assert.equal(result.results[0]?.wordCount, 100);
});

test("AnyCrawlWebProvider fetch falls back to playwright when cheerio fails", async () => {
  const provider = new AnyCrawlWebProvider("test-key");
  const observedEngines: string[] = [];

  (provider as unknown as {
    client: {
      scrape(input: { url: string; engine?: string; timeout?: number }): Promise<unknown>;
    };
  }).client = {
    async scrape(input) {
      observedEngines.push(input.engine ?? "");
      if (input.engine === "cheerio") {
        throw new Error("static fetch failed");
      }
      return {
        status: "completed",
        url: input.url,
        title: input.url,
        markdown: "word ".repeat(100),
        metadata: [],
      };
    },
  };

  const result = await provider.fetch({
    items: [{ url: "https://example.com/js-required" }],
  });

  assert.equal(result.count, 1);
  assert.deepEqual(observedEngines, ["cheerio", "playwright"]);
});

test("AnyCrawlWebProvider fetch returns an item error when scrapes exceed timeout", async () => {
  const provider = new AnyCrawlWebProvider("test-key", { fetchTimeoutMs: 10 });

  (provider as unknown as {
    client: {
      scrape(input: { url: string; engine?: string; timeout?: number }): Promise<unknown>;
    };
  }).client = {
    async scrape() {
      await new Promise(() => {});
    },
  };

  const result = await provider.fetch({
    items: [{ url: "https://example.com/slow" }],
  });

  assert.equal(result.count, 0);
  assert.equal(result.results.length, 1);
  assert.match(result.results[0]?.error ?? "", /timed out after 10ms/);
});

async function waitFor(predicate: () => boolean) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
