import assert from "node:assert/strict";
import test from "node:test";
import { AgentCitationRegistry } from "../citation-registry";
import { createWebTools } from "./web-tools";
import type { WebProvider } from "../../web";

type InvokableTool = {
  invoke(input: unknown): Promise<unknown>;
};

function createProvider(): WebProvider {
  return {
    name: "test",
    async search(input) {
      return {
        provider: "test",
        query: input.query,
        count: 1,
        results: [{
          title: "Example",
          url: "https://example.com",
          snippet: "Example snippet",
          source: "example",
        }],
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

function createInvokableWebTools(input: {
  provider: WebProvider;
  citationRegistry: AgentCitationRegistry;
}) {
  return createWebTools(input) as InvokableTool[];
}

test("web_search defaults to limit 20 and registers citation", async () => {
  let observedLimit = 0;
  const provider = createProvider();
  const wrappedProvider: WebProvider = {
    ...provider,
    async search(input) {
      observedLimit = input.limit;
      return provider.search(input);
    },
  };
  const citationRegistry = new AgentCitationRegistry();
  const [webSearch] = createInvokableWebTools({
    provider: wrappedProvider,
    citationRegistry,
  });
  assert.ok(webSearch);

  const output = await webSearch.invoke({ query: "OpenAI news" });

  assert.equal(observedLimit, 20);
  assert.match(String(output), /\[citation:c1\]|id='c1'/);
  assert.equal(citationRegistry.list()[0]?.externalUri, "https://example.com");
  assert.equal(citationRegistry.toCitationRecords()[0]?.chunkId, null);
});

test("web_search returns main content from search results", async () => {
  const citationRegistry = new AgentCitationRegistry();
  const [webSearch] = createInvokableWebTools({
    provider: {
      ...createProvider(),
      async search(input) {
        return {
          provider: "test",
          query: input.query,
          count: 1,
          results: [{
            title: "Example",
            url: "https://example.com",
            snippet: "Example snippet",
            markdown: "Search result main content",
            wordCount: 4,
            truncated: false,
          }],
        };
      },
    },
    citationRegistry,
  });
  assert.ok(webSearch);

  const output = String(await webSearch.invoke({ query: "OpenAI news" }));

  assert.match(output, /<main_content>Search result main content<\/main_content>/);
  assert.equal(citationRegistry.list()[0]?.excerpt, "Search result main content");
});

test("web_search rejects overly long queries", async () => {
  const [webSearch] = createInvokableWebTools({
    provider: createProvider(),
    citationRegistry: new AgentCitationRegistry(),
  });
  assert.ok(webSearch);

  await assert.rejects(
    () => webSearch.invoke({ query: "x".repeat(241) }),
    /Search query is too long|at most 240/,
  );
});

test("web_fetch accepts up to 5 URLs and registers citations", async () => {
  let observedCount = 0;
  const provider = createProvider();
  const wrappedProvider: WebProvider = {
    ...provider,
    async fetch(input) {
      observedCount = input.items.length;
      return provider.fetch(input);
    },
  };
  const citationRegistry = new AgentCitationRegistry();
  const [, webFetch] = createInvokableWebTools({
    provider: wrappedProvider,
    citationRegistry,
  });
  assert.ok(webFetch);

  const output = await webFetch.invoke({
    items: Array.from({ length: 5 }, (_, index) => ({
      url: `https://example.com/${index}`,
    })),
  });

  assert.equal(observedCount, 5);
  assert.match(String(output), /<web_page id='c1'/);
  assert.equal(citationRegistry.list().length, 5);
});

test("web tools escape result fields", async () => {
  const citationRegistry = new AgentCitationRegistry();
  const [webSearch] = createInvokableWebTools({
    provider: {
      ...createProvider(),
      async search(input) {
        return {
          provider: "test",
          query: input.query,
          count: 1,
          results: [{
            title: "A 'quoted' <title>",
            url: "https://example.com/?q=one&x='two'",
            snippet: "Snippet with <tag> & text",
          }],
        };
      },
    },
    citationRegistry,
  });
  assert.ok(webSearch);

  const output = String(await webSearch.invoke({ query: "escaping" }));

  assert.match(output, /title='A &apos;quoted&apos; &lt;title&gt;'/);
  assert.match(output, /Snippet with &lt;tag&gt; &amp; text/);
});
