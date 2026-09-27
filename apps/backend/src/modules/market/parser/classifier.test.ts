import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withSystemModel: vi.fn() }));

// Only the door to the model is replaced; the not-ready error and readiness
// are the real ones.
vi.mock(
  "../../../shared/model-gateway/system-client",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../shared/model-gateway/system-client")
    >()),
    withSystemModel: mocks.withSystemModel,
  }),
);

import { logger } from "../../../shared/logger";
import {
  SystemModelUnavailableError,
  evaluateSystemModelReadiness,
  type SystemModelCallContext,
  type SystemChatCompleteInput,
} from "../../../shared/model-gateway/system-client";
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

type Answer = {
  confidence: number;
  primaryCategory: string;
  reason: string;
  reviewRequired: boolean;
  secondaryCategories: string[];
};

/** The system model answers with `answer`; records what it was asked. */
function modelAnswers(answer: Answer) {
  const calls: Array<{
    context: SystemModelCallContext;
    input: SystemChatCompleteInput;
  }> = [];
  mocks.withSystemModel.mockImplementation(
    async (
      context: SystemModelCallContext,
      run: (chat: {
        complete: (input: SystemChatCompleteInput) => Promise<unknown>;
      }) => Promise<unknown>,
    ) =>
      run({
        complete: async (input) => {
          calls.push({ context, input });
          return {
            model: "deepseek/deepseek-v4.1-flash",
            provider: "openrouter",
            providerModel: "deepseek/deepseek-v4.1-flash",
            structuredOutput: answer,
            raw: { content: "" },
          };
        },
      }),
  );
  return calls;
}

const browserAnswer: Answer = {
  confidence: 0.95,
  primaryCategory: "browser-automation",
  reason: "Playwright controls browsers.",
  reviewRequired: false,
  secondaryCategories: ["developer-tools"],
};

beforeEach(() => {
  mocks.withSystemModel.mockReset();
});

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

test("uses the system model's result when it returns canonical categories", async () => {
  const calls = modelAnswers(browserAnswer);
  const result = await classifyMcpRepository(staticParseFixture(), {
    mode: "model",
  });

  assert.equal(result.method, "model");
  assert.deepEqual(result.categories, [
    "browser-automation",
    "developer-tools",
  ]);
  assert.equal(result.reviewRequired, false);
  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, "deepseek/deepseek-v4.1-flash");

  // One structured call under the classifier's purpose, prompt unchanged.
  assert.equal(calls.length, 1);
  const [{ context, input }] = calls as [(typeof calls)[number]];
  assert.equal(context.purpose, "mcp_market.classify");
  assert.equal(context.subjectRef, "mcp-repository:microsoft/playwright-mcp");
  assert.equal(input.structuredOutput?.name, "mcp_classification");
  assert.deepEqual(
    (input.structuredOutput?.schema as { required: string[] }).required,
    [
      "confidence",
      "primaryCategory",
      "reason",
      "reviewRequired",
      "secondaryCategories",
    ],
  );
  assert.deepEqual(input.thinking, {
    mode: "off",
    enabled: false,
    includeReasoning: false,
  });
  const prompt = String(input.messages[0]?.content);
  assert.match(prompt, /^Classify this Model Context Protocol server/);
  assert.match(prompt, /Rule-based candidates:\n\[.*"browser-automation"/);
  assert.match(prompt, /-----BEGIN UNTRUSTED MCP SERVER EVIDENCE-----/);
});

test("falls back to rules when the system model returns an unknown slug", async () => {
  modelAnswers({
    confidence: 0.9,
    primaryCategory: "not-a-real-category",
    reason: "Invalid category.",
    reviewRequired: false,
    secondaryCategories: [],
  });
  const result = await classifyMcpRepository(staticParseFixture(), {
    mode: "model",
  });

  assert.equal(result.method, "rules-fallback");
  assert.equal(
    result.fallbackReason,
    "The system model returned unknown category slug(s): not-a-real-category",
  );
  assert.ok(result.categories.includes("browser-automation"));
  assert.equal(result.categories.includes("not-a-real-category"), false);
});

test("an answer that shares nothing with the rule candidates requires review", async () => {
  modelAnswers({
    confidence: 0.99,
    primaryCategory: "databases",
    reason: "It stores data.",
    reviewRequired: false,
    secondaryCategories: [],
  });
  const result = await classifyMcpRepository(staticParseFixture(), {
    mode: "model",
  });
  assert.equal(result.method, "model");
  assert.deepEqual(result.categories, ["databases"]);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.llmResult?.reviewRequired, true);
  assert.match(
    result.llmResult?.reason ?? "",
    /\[flagged: category diverges from rule candidates \[.*"browser-automation"/,
  );
});

test("when the system model is not ready, keyword rules are used with an explicit reason and a warning", async () => {
  const readiness = evaluateSystemModelReadiness(
    { enabled: false, provider: "openrouter", apiKey: "", model: "m" },
    null,
  );
  mocks.withSystemModel.mockRejectedValue(
    new SystemModelUnavailableError(readiness),
  );
  const warn = vi.spyOn(logger, "warn");
  const result = await classifyMcpRepository(staticParseFixture(), {
    mode: "model",
  });

  assert.equal(result.method, "rules-fallback");
  assert.equal(result.fallbackReason, "system_model_not_ready");
  assert.equal(result.reviewRequired, true);
  assert.deepEqual(
    result.categories,
    inferMcpCategories(staticParseFixture(), []),
  );
  assert.equal(warn.mock.calls.length, 1);
  assert.match(String(warn.mock.calls[0]?.[0]), /system model is not ready/);
  assert.deepEqual(warn.mock.calls[0]?.[1], {
    subjectRef: "mcp-repository:microsoft/playwright-mcp",
    reason: readiness.reason,
  });
});

test("a failed model call falls back to rules with its reason and a warning", async () => {
  mocks.withSystemModel.mockRejectedValue(
    Object.assign(new Error("Upstream unavailable"), { code: "UPSTREAM" }),
  );
  const warn = vi.spyOn(logger, "warn");
  const result = await classifyMcpRepository(staticParseFixture(), {
    mode: "model",
  });
  assert.equal(result.method, "rules-fallback");
  assert.equal(result.fallbackReason, "Upstream unavailable");
  assert.equal(warn.mock.calls.length, 1);
  assert.equal(
    (warn.mock.calls[0]?.[1] as { errorCode?: string }).errorCode,
    "UPSTREAM",
  );
});

test("never uses market source slugs as manifest categories", async () => {
  const result = await classifyMcpRepository(staticParseFixture(), {
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

test("every classification asks the model: there is no local cache", async () => {
  const calls = modelAnswers(browserAnswer);
  const parsed = staticParseFixture();
  await classifyMcpRepository(parsed, { mode: "model" });
  const again = await classifyMcpRepository(parsed, { mode: "model" });
  assert.equal(calls.length, 2);
  assert.equal(again.method, "model");
});

test("the classifier keeps no direct client, cache file or classifier environment", () => {
  const source = readFileSync(
    new URL("./classifier.ts", import.meta.url),
    "utf8",
  );
  for (const retired of [
    "@ai-sdk/",
    "generateText",
    "ATLASCLOUD_API_KEY",
    "MCP_CLASSIFIER_",
    "mcp-classification-cache",
    "process.env",
    "node:fs",
  ]) {
    assert.equal(source.includes(retired), false, retired);
  }
});

test("rules mode skips the model", async () => {
  const result = await classifyMcpRepository(staticParseFixture(), {
    mode: "rules",
  });

  assert.equal(mocks.withSystemModel.mock.calls.length, 0);
  assert.equal(result.method, "rules-fallback");
  assert.equal(result.fallbackReason, "Rules mode requested");
});
