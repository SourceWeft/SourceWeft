import assert from "node:assert/strict";
import { test } from "vitest";
import type { StaticParseResult } from "../types";
import {
  classifyByText,
  inferMcpCategories,
  nonCategorySlugs,
  normalizeMcpCategorySlug,
} from "./categories";
import { RepoTree, VIRTUAL_REPO_ROOT } from "./repo-tree";

/**
 * The keyword rules: what a submission and a federated entry are filed under
 * until the AI overview (`modules/market/overview`) replaces them.
 */

function staticParseFixture(input?: {
  repo?: string;
  summary?: string;
}): StaticParseResult {
  const repo = input?.repo ?? "playwright-mcp";
  return {
    connections: [],
    evidence: [],
    mcpAssessment: {
      confidence: 0.8,
      isMcp: true,
      reasons: ["test fixture"],
      signals: [],
    },
    packageHints: [{ name: repo, registryType: "npm", version: "1.0.0" }],
    readme: {
      content: input?.summary ?? "",
      installCommands: [],
      path: "README.md",
      summary:
        input?.summary ??
        "Playwright MCP server for browser automation and page testing.",
      tools: [],
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

test("never uses market source slugs as categories", () => {
  const categories = inferMcpCategories(staticParseFixture(), [
    "mcp-so",
    "mcpservers",
    "official",
    "featured",
    "browser",
  ]);
  assert.ok(categories.includes("browser-automation"));
  assert.equal(
    categories.some((category) => nonCategorySlugs.has(category)),
    false,
  );
});

test("rule classifier covers representative MCP categories", () => {
  const cases: Array<{ expected: string; repo: string; summary: string }> = [
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
