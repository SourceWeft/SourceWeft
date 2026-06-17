import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWebTools,
  type WebCitationRegistry,
  type WebExternalCitationInput,
  type WebProvider,
} from "../src/index";

type Citation = {
  readonly citation: string;
  readonly externalUri: string;
  readonly excerpt?: string;
  readonly content?: string;
};

class FakeCitationRegistry implements WebCitationRegistry {
  readonly citations: Citation[] = [];

  addExternal(input: WebExternalCitationInput) {
    const existing = this.citations.find(
      (citation) => citation.externalUri === input.externalUri,
    );
    if (existing) {
      return existing;
    }

    const fullContent = input.fullContent?.trim();
    const citation = {
      citation: `c${this.citations.length + 1}`,
      externalUri: input.externalUri,
      excerpt: input.excerptContent ?? input.content,
      ...(fullContent ? { content: fullContent } : {}),
    };
    this.citations.push(citation);
    return citation;
  }
}

function createProvider(): WebProvider {
  return {
    name: "test",
    async search(input) {
      return {
        provider: "test",
        query: input.query,
        count: 1,
        results: [
          {
            title: "Example",
            url: "https://example.com",
            snippet: "Example snippet",
            markdown: "Search result main content",
            wordCount: 4,
            truncated: false,
          },
        ],
      };
    },
    async fetch(input) {
      return {
        provider: "test",
        count: input.items.length,
        results: input.items.map((item) => ({
          url: item.url,
          title: "Fetched",
          markdown: "Fetched content",
          wordCount: 2,
          truncated: false,
        })),
      };
    },
  };
}

test("createWebTools exposes search and fetch only when web access is enabled", () => {
  const defaultTools = createWebTools({
    provider: createProvider(),
    citationRegistry: new FakeCitationRegistry(),
  });
  const searchTools = createWebTools({
    provider: createProvider(),
    citationRegistry: new FakeCitationRegistry(),
    searchEnabled: true,
  });

  assert.deepEqual(
    defaultTools.map((tool) => tool.name),
    [],
  );
  assert.deepEqual(
    searchTools.map((tool) => tool.name),
    ["web_search", "web_fetch"],
  );
});

test("createWebTools formats web_search results with citations", async () => {
  const citationRegistry = new FakeCitationRegistry();
  const [webSearch] = createWebTools({
    provider: createProvider(),
    citationRegistry,
    searchEnabled: true,
  });
  assert.ok(webSearch);

  const output = String(await webSearch.invoke({ query: "OpenAI news" }));

  assert.match(output, /<main_content>Search result main content<\/main_content>/);
  assert.match(output, /id='c1'/);
  assert.equal(citationRegistry.citations[0]?.externalUri, "https://example.com");
  assert.equal(
    citationRegistry.citations[0]?.content,
    "Search result main content",
  );
});

test("createWebTools returns display-safe web_search failures", async () => {
  const [webSearch] = createWebTools({
    provider: {
      ...createProvider(),
      async search() {
        throw new Error("API Error 500: Internal server error");
      },
    },
    citationRegistry: new FakeCitationRegistry(),
    searchEnabled: true,
  });
  assert.ok(webSearch);

  const output = String(
    await webSearch.invoke({ query: "Shanghai weather today" }),
  );

  assert.match(output, /web_search failed/);
  assert.match(output, /<web_tool_error /);
  assert.match(output, /API Error 500: Internal server error/);
});

test("createWebTools caps web_fetch input and records fetch citations", async () => {
  let observedCount = 0;
  const provider = createProvider();
  const citationRegistry = new FakeCitationRegistry();
  const [, webFetch] = createWebTools({
    provider: {
      ...provider,
      async fetch(input) {
        observedCount = input.items.length;
        return provider.fetch(input);
      },
    },
    citationRegistry,
    searchEnabled: true,
  });
  assert.ok(webFetch);

  const output = String(
    await webFetch.invoke({
      items: Array.from({ length: 5 }, (_, index) => ({
        url: `https://example.com/${index}`,
      })),
    }),
  );

  assert.equal(observedCount, 5);
  assert.match(output, /<web_page id='c1'/);
  assert.equal(citationRegistry.citations.length, 5);
});
