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
        results: [
          {
            title: "Example",
            url: "https://example.com",
            snippet: "Example snippet",
            source: "example",
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

function createInvokableWebTools(input: {
  provider: WebProvider;
  citationRegistry: AgentCitationRegistry;
  searchEnabled?: boolean;
}) {
  return createWebTools(input) as InvokableTool[];
}

test("web tools inject web_fetch without web_search by default", () => {
  const tools = createWebTools({
    provider: createProvider(),
    citationRegistry: new AgentCitationRegistry(),
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["web_fetch"],
  );
});

test("web tools inject web_search only when enabled", () => {
  const tools = createWebTools({
    provider: createProvider(),
    citationRegistry: new AgentCitationRegistry(),
    searchEnabled: true,
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["web_search", "web_fetch"],
  );
});

test("web_search defaults to 10 enriched results and registers citation", async () => {
  let observedLimit = 0;
  let observedIncludeContent: boolean | undefined;
  let observedFresh: boolean | undefined;
  const provider = createProvider();
  const wrappedProvider: WebProvider = {
    ...provider,
    async search(input) {
      observedLimit = input.limit;
      observedIncludeContent = input.includeContent;
      observedFresh = input.fresh;
      return provider.search(input);
    },
  };
  const citationRegistry = new AgentCitationRegistry();
  const [webSearch] = createInvokableWebTools({
    provider: wrappedProvider,
    citationRegistry,
    searchEnabled: true,
  });
  assert.ok(webSearch);

  const output = await webSearch.invoke({ query: "OpenAI news" });

  assert.equal(observedLimit, 10);
  assert.equal(observedIncludeContent, true);
  assert.equal(observedFresh, false);
  assert.match(String(output), /\[citation:c1\]|id='c1'/);
  assert.equal(citationRegistry.list()[0]?.externalUri, "https://example.com");
  assert.equal(citationRegistry.toCitationRecords()[0]?.chunkId, null);
});

test("web_search passes fresh flag for time-sensitive searches", async () => {
  let observedFresh: boolean | undefined;
  const provider = createProvider();
  const wrappedProvider: WebProvider = {
    ...provider,
    async search(input) {
      observedFresh = input.fresh;
      return provider.search(input);
    },
  };
  const [webSearch] = createInvokableWebTools({
    provider: wrappedProvider,
    citationRegistry: new AgentCitationRegistry(),
    searchEnabled: true,
  });
  assert.ok(webSearch);

  await webSearch.invoke({ query: "gold price today", fresh: true });

  assert.equal(observedFresh, true);
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
    },
    citationRegistry,
    searchEnabled: true,
  });
  assert.ok(webSearch);

  const output = String(await webSearch.invoke({ query: "OpenAI news" }));

  assert.match(
    output,
    /<main_content>Search result main content<\/main_content>/,
  );
  assert.equal(citationRegistry.list()[0]?.excerpt, "Example snippet");
  assert.equal(
    citationRegistry.list()[0]?.content,
    "Search result main content",
  );
});

test("web_search keeps full citation content when main content is long", async () => {
  const citationRegistry = new AgentCitationRegistry();
  const longMainContent = `Full content ${"word ".repeat(200)}`.trim();
  const [webSearch] = createInvokableWebTools({
    provider: {
      ...createProvider(),
      async search(input) {
        return {
          provider: "test",
          query: input.query,
          count: 1,
          results: [
            {
              title: "Long page",
              url: "https://example.com/long",
              snippet: "Short search summary",
              markdown: longMainContent,
              wordCount: 202,
              truncated: false,
            },
          ],
        };
      },
    },
    citationRegistry,
    searchEnabled: true,
  });
  assert.ok(webSearch);

  await webSearch.invoke({ query: "long page" });

  const citation = citationRegistry.list()[0];
  assert.equal(citation?.excerpt, "Short search summary");
  assert.equal(citation?.content, longMainContent);
  assert.equal(citation?.content?.length, longMainContent.length);
});

test("web_search returns a tool failure result when provider search fails", async () => {
  const citationRegistry = new AgentCitationRegistry();
  const [webSearch] = createInvokableWebTools({
    provider: {
      ...createProvider(),
      async search() {
        throw new Error("API Error 500: Internal server error");
      },
    },
    citationRegistry,
    searchEnabled: true,
  });
  assert.ok(webSearch);

  const output = String(
    await webSearch.invoke({ query: "Shanghai weather today" }),
  );

  assert.match(output, /web_search failed/);
  assert.match(output, /<web_tool_error /);
  assert.match(output, /API Error 500: Internal server error/);
  assert.equal(citationRegistry.list().length, 0);
});

test("web_search uses snippet as citation summary when main content is missing", async () => {
  const citationRegistry = new AgentCitationRegistry();
  const [webSearch] = createInvokableWebTools({
    provider: {
      ...createProvider(),
      async search(input) {
        return {
          provider: "test",
          query: input.query,
          count: 1,
          results: [
            {
              title: "Snippet only",
              url: "https://example.com/snippet",
              snippet: "Only a search snippet is available",
            },
          ],
        };
      },
    },
    citationRegistry,
    searchEnabled: true,
  });
  assert.ok(webSearch);

  await webSearch.invoke({ query: "snippet only" });

  const citation = citationRegistry.list()[0];
  assert.equal(citation?.excerpt, "Only a search snippet is available");
  assert.equal(citation?.content, undefined);
});

test("web_search rejects overly long queries", async () => {
  const [webSearch] = createInvokableWebTools({
    provider: createProvider(),
    citationRegistry: new AgentCitationRegistry(),
    searchEnabled: true,
  });
  assert.ok(webSearch);

  await assert.rejects(
    () => webSearch.invoke({ query: "x".repeat(241) }),
    /Search query is too long|at most 240/,
  );
});

test("web_fetch accepts up to 5 URLs and registers citations", async () => {
  let observedCount = 0;
  let observedFresh: boolean | undefined;
  const provider = createProvider();
  const wrappedProvider: WebProvider = {
    ...provider,
    async fetch(input) {
      observedCount = input.items.length;
      observedFresh = input.fresh;
      return provider.fetch(input);
    },
  };
  const citationRegistry = new AgentCitationRegistry();
  const [webFetch] = createInvokableWebTools({
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
  assert.equal(observedFresh, false);
  assert.match(String(output), /<web_page id='c1'/);
  assert.equal(citationRegistry.list().length, 5);
});

test("web_fetch passes fresh flag for time-sensitive pages", async () => {
  let observedFresh: boolean | undefined;
  const provider = createProvider();
  const wrappedProvider: WebProvider = {
    ...provider,
    async fetch(input) {
      observedFresh = input.fresh;
      return provider.fetch(input);
    },
  };
  const [webFetch] = createInvokableWebTools({
    provider: wrappedProvider,
    citationRegistry: new AgentCitationRegistry(),
  });
  assert.ok(webFetch);

  await webFetch.invoke({
    fresh: true,
    items: [{ url: "https://example.com/live" }],
  });

  assert.equal(observedFresh, true);
});

test("web_fetch returns failed pages when provider fetch fails", async () => {
  const [webFetch] = createInvokableWebTools({
    provider: {
      ...createProvider(),
      async fetch() {
        throw new Error("API Error 500: Internal server error");
      },
    },
    citationRegistry: new AgentCitationRegistry(),
  });
  assert.ok(webFetch);

  const output = String(
    await webFetch.invoke({
      items: [{ url: "https://example.com/live" }],
    }),
  );

  assert.match(output, /<web_page /);
  assert.match(output, /error='API Error 500: Internal server error'/);
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
          results: [
            {
              title: "A 'quoted' <title>",
              url: "https://example.com/?q=one&x='two'",
              snippet: "Snippet with <tag> & text",
            },
          ],
        };
      },
    },
    citationRegistry,
    searchEnabled: true,
  });
  assert.ok(webSearch);

  const output = String(await webSearch.invoke({ query: "escaping" }));

  assert.match(output, /title='A &apos;quoted&apos; &lt;title&gt;'/);
  assert.match(output, /Snippet with &lt;tag&gt; &amp; text/);
});
