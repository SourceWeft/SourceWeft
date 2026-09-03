import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { classifyMcpRepository } from "./classifier";
import {
  classifyByText,
  inferMcpCategories,
  normalizeMcpCategorySlug,
  nonCategorySlugs,
} from "./categories";
import type { StaticParseResult } from "../types";
import { RepoTree, VIRTUAL_REPO_ROOT } from "./repo-tree";

function staticParseFixture(input?: {
  repo?: string;
  summary?: string;
  tools?: Array<{ description?: string; name: string }>;
}): StaticParseResult {
  const repo = input?.repo ?? "playwright-mcp";
  return {
    connections: [],
    evidence: [],
    mcpAssessment: {
      confidence: 0.8,
      isMcp: true,
      reasons: ["test fixture"],
      signals: [
        {
          confidence: 0.8,
          kind: "mcp-readme",
          path: "README.md",
          summary: "test fixture",
        },
      ],
    },
    packageHints: [
      {
        name: repo,
        registryType: "npm",
        version: "1.0.0",
      },
    ],
    readme: {
      content: input?.summary ?? "",
      installCommands: [],
      path: "README.md",
      summary:
        input?.summary ??
        "Playwright MCP server for browser automation and page testing.",
      tools:
        input?.tools?.map((tool) => ({
          annotations: {},
          confidence: 0.8,
          description: tool.description,
          inputSchema: {},
          name: tool.name,
          risk: "read",
          source: "readme",
          title: tool.name,
        })) ?? [],
    },
    source: {
      commitSha: "a".repeat(40),
      owner: "microsoft",
      ref: "main",
      repo,
      repoUrl: `https://github.com/microsoft/${repo}`,
      requestedRef: "main",
      resolvedRef: "a".repeat(40),
      rootDir: VIRTUAL_REPO_ROOT,
      sourceUrl: `https://github.com/microsoft/${repo}`,
      subpath: "",
      tree: new RepoTree(new Map()),
      workDir: VIRTUAL_REPO_ROOT,
    },
    sourceTools: [],
    warnings: [],
  };
}

async function tempCachePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "sourceweft-classifier-test-"));
  return path.join(dir, "cache.json");
}

test("classifyByText keyword-classifies plain text and pins explicit slugs", () => {
  // Registry-style text (no repo parse) still classifies from name/description.
  const dbCats = classifyByText("A Postgres database MCP with SQL queries");
  assert.ok(dbCats.includes("databases"));
  assert.equal(dbCats[0], "databases");
  // Explicit categories are normalized and pinned ahead of keyword matches.
  const withExplicit = classifyByText(
    "browser automation with playwright screenshots",
    ["developer-tools"],
  );
  assert.equal(withExplicit[0], "developer-tools");
  assert.ok(withExplicit.includes("browser-automation"));
  // Unclassifiable text falls back to "other".
  assert.deepEqual(classifyByText("zzz qqq"), ["other"]);
});

test("filters source market slugs out of canonical categories", () => {
  assert.equal(normalizeMcpCategorySlug("mcp-so"), undefined);
  assert.equal(normalizeMcpCategorySlug("mcpservers"), undefined);
  assert.equal(normalizeMcpCategorySlug("official"), undefined);
  assert.equal(normalizeMcpCategorySlug("featured"), undefined);
  assert.equal(normalizeMcpCategorySlug("all"), undefined);
  assert.equal(normalizeMcpCategorySlug("browser"), "browser-automation");
});

test("uses DeepSeek result when it returns canonical categories", async () => {
  const result = await classifyMcpRepository(staticParseFixture(), {
    cachePath: await tempCachePath(),
    mode: "deepseek",
    deepSeekRunner: async () => ({
      confidence: 0.95,
      primaryCategory: "browser-automation",
      reason: "Playwright controls browsers.",
      reviewRequired: false,
      secondaryCategories: ["developer-tools"],
    }),
  });

  assert.equal(result.method, "deepseek");
  assert.deepEqual(result.categories, [
    "browser-automation",
    "developer-tools",
  ]);
  assert.equal(result.reviewRequired, false);
});

test("falls back to rules when DeepSeek returns an unknown slug", async () => {
  const result = await classifyMcpRepository(staticParseFixture(), {
    cachePath: await tempCachePath(),
    mode: "deepseek",
    deepSeekRunner: async () => ({
      confidence: 0.9,
      primaryCategory: "not-a-real-category",
      reason: "Invalid category.",
      reviewRequired: false,
      secondaryCategories: [],
    }),
  });

  assert.equal(result.method, "rules-fallback");
  assert.equal(
    result.fallbackReason,
    "DeepSeek returned unknown category slug(s): not-a-real-category",
  );
  assert.ok(result.categories.includes("browser-automation"));
  assert.equal(result.categories.includes("not-a-real-category"), false);
});

test("never uses market source slugs as manifest categories", async () => {
  const result = await classifyMcpRepository(staticParseFixture(), {
    cachePath: await tempCachePath(),
    categories: ["mcp-so", "mcpservers", "official", "featured", "browser"],
    discovery: { sourceMarket: "mcp-so" },
    mode: "rules",
  });

  assert.equal(result.method, "rules-fallback");
  assert.ok(result.categories.includes("browser-automation"));
  assert.equal(
    result.categories.some((category) => nonCategorySlugs.has(category)),
    false,
  );
});

test("rule classifier covers representative MCP categories", () => {
  const cases: Array<{
    expected: string;
    repo: string;
    summary: string;
  }> = [
    {
      expected: "browser-automation",
      repo: "playwright-mcp",
      summary: "Playwright MCP server for browser automation and screenshots.",
    },
    {
      expected: "knowledge-memory",
      repo: "context7",
      summary: "RAG documentation retrieval and memory for Context7 docs.",
    },
    {
      expected: "web-search-scraping",
      repo: "tavily-mcp",
      summary: "Search the web and retrieve news with Tavily.",
    },
    {
      expected: "web-search-scraping",
      repo: "firecrawl-mcp",
      summary: "Scrape websites, crawl pages, and extract web content.",
    },
    {
      expected: "databases",
      repo: "postgres-mcp",
      summary: "Query PostgreSQL databases with SQL.",
    },
    {
      expected: "communication-collaboration",
      repo: "slack-mcp",
      summary: "Send Slack messages and list team channels.",
    },
    {
      expected: "business-commerce",
      repo: "shopify-mcp",
      summary: "Manage Shopify ecommerce orders and products.",
    },
    {
      expected: "cloud-infrastructure",
      repo: "aws-mcp",
      summary:
        "Manage AWS cloud infrastructure, Docker deployments, and Kubernetes clusters.",
    },
  ];

  for (const item of cases) {
    assert.ok(
      inferMcpCategories(
        staticParseFixture({ repo: item.repo, summary: item.summary }),
        [],
      ).includes(item.expected),
      `${item.repo} should include ${item.expected}`,
    );
  }
});

test("serves successful DeepSeek classifications from cache", async () => {
  let calls = 0;
  const cachePath = await tempCachePath();
  const parsed = staticParseFixture();
  const runner = async () => {
    calls += 1;
    return {
      confidence: 0.95,
      primaryCategory: "browser-automation",
      reason: "Playwright controls browsers.",
      reviewRequired: false,
      secondaryCategories: ["developer-tools"],
    };
  };

  await classifyMcpRepository(parsed, {
    cachePath,
    deepSeekRunner: runner,
    mode: "deepseek",
  });
  const cached = await classifyMcpRepository(parsed, {
    cachePath,
    deepSeekRunner: runner,
    mode: "deepseek",
  });

  assert.equal(calls, 1);
  assert.equal(cached.method, "deepseek");
  assert.deepEqual(cached.categories, [
    "browser-automation",
    "developer-tools",
  ]);
});

test("rules mode skips the DeepSeek runner", async () => {
  let calls = 0;
  const result = await classifyMcpRepository(staticParseFixture(), {
    cachePath: await tempCachePath(),
    deepSeekRunner: async () => {
      calls += 1;
      throw new Error("should not be called");
    },
    mode: "rules",
  });

  assert.equal(calls, 0);
  assert.equal(result.method, "rules-fallback");
  assert.equal(result.fallbackReason, "Rules mode requested");
});
