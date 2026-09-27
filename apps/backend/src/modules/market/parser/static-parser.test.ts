import assert from "node:assert/strict";
import { test } from "vitest";
import { parseStaticRepository } from "./static-parser";
import {
  RepoTree,
  VIRTUAL_REPO_ROOT,
  type ReadGitHubRepository,
} from "./repo-tree";

// The fixture used to write a real temp directory; ingest no longer touches the
// filesystem, so the repository is built straight as an in-memory tree.
function createRepositoryFixture(input: {
  files: Record<string, string>;
  owner?: string;
  repo: string;
}) {
  const owner = input.owner ?? "example";
  const sha = "a".repeat(40);
  const tree = new RepoTree(
    new Map(
      Object.entries(input.files).map(([relativePath, content]) => [
        relativePath,
        Buffer.from(content, "utf8"),
      ]),
    ),
  );
  return {
    commitSha: sha,
    owner,
    ref: "main",
    repo: input.repo,
    repoUrl: `https://github.com/${owner}/${input.repo}`,
    requestedRef: "main",
    resolvedRef: sha,
    rootDir: VIRTUAL_REPO_ROOT,
    sourceUrl: `https://github.com/${owner}/${input.repo}`,
    subpath: "",
    tree,
    workDir: VIRTUAL_REPO_ROOT,
  } satisfies ReadGitHubRepository;
}

test("rejects repositories without MCP evidence", async () => {
  const source = createRepositoryFixture({
    repo: "jsondiffpatch",
    owner: "benjamine",
    files: {
      "README.md": "# jsondiffpatch\n\nDiff and patch JavaScript objects.",
      "package.json": JSON.stringify({
        name: "jsondiffpatch",
        version: "1.0.0",
      }),
      "src/index.ts":
        "export function diff(left: unknown, right: unknown) { return [left, right]; }\n",
    },
  });

  const result = await parseStaticRepository(source);

  assert.equal(result.mcpAssessment.isMcp, false);
  assert.equal(result.mcpAssessment.confidence, 0);
  assert.match(result.warnings.join("\n"), /non-MCP/);
});

test("accepts repositories with MCP runtime and tool registration evidence", async () => {
  const source = createRepositoryFixture({
    repo: "playwright-mcp",
    files: {
      "README.md":
        "# Playwright MCP\n\nA Model Context Protocol server for browser automation.",
      "package.json": JSON.stringify({
        name: "playwright-mcp",
        dependencies: {
          "@modelcontextprotocol/sdk": "^1.0.0",
        },
      }),
      "src/server.ts": `
        import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
        import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
        const server = new McpServer({ name: "playwright", version: "1.0.0" });
        server.tool("browser_snapshot", "Capture page state", {}, async () => ({ content: [] }));
        await server.connect(new StdioServerTransport());
      `,
    },
  });

  const result = await parseStaticRepository(source);

  assert.equal(result.mcpAssessment.isMcp, true);
  assert.ok(result.mcpAssessment.confidence >= 0.7);
  assert.deepEqual(
    result.sourceTools.map((tool) => tool.name),
    ["browser_snapshot"],
  );
});

test("accepts explicit MCP subdirectories with runnable entrypoints", async () => {
  const source = createRepositoryFixture({
    repo: "monorepo",
    files: {
      "server.py": `
        from fastmcp import FastMCP
        app = FastMCP("benchmark")
        @app.tool()
        def get_data(path: str) -> str:
          return path
        if __name__ == "__main__":
          app.run(transport="stdio")
      `,
      "pyproject.toml": `
        [project]
        name = "benchmark-mcp"
        version = "1.0.0"
        dependencies = ["fastmcp"]
      `,
    },
  });
  const result = await parseStaticRepository({
    ...source,
    subpath: "servers/benchmark",
    sourceUrl: `${source.repoUrl}/tree/main/servers/benchmark`,
  });

  assert.equal(result.mcpAssessment.isMcp, true);
  assert.ok(
    result.mcpAssessment.signals.some(
      (signal) => signal.kind === "mcp-entrypoint",
    ),
  );
});

// An MCP server whose README the parser has to find; `files` adds the READMEs.
function readmeFixture(files: Record<string, string>) {
  return createRepositoryFixture({
    repo: "weather",
    files: {
      "mcp/server.json": JSON.stringify({
        name: "io.github.example/weather",
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@example/weather-mcp",
            transport: { type: "stdio" },
          },
        ],
      }),
      "mcp/package.json": JSON.stringify({
        name: "@example/weather-mcp",
        dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" },
      }),
      ...files,
    },
  });
}

test("the README is the repository root's first", async () => {
  const result = await parseStaticRepository(
    readmeFixture({
      "README.md": "# Weather\n\nThe repository.",
      "mcp/README.md": "# Weather MCP\n\nThe server.",
    }),
  );
  assert.equal(result.readme?.path, "README.md");
  assert.equal(result.readme?.content, "# Weather\n\nThe repository.");
});

test("without one at the root, the README next to server.json", async () => {
  const result = await parseStaticRepository(
    readmeFixture({
      "mcp/README.md": "# Weather MCP\n\nThe server.",
      "docs/README.md": "# Docs",
    }),
  );
  assert.equal(result.readme?.path, "mcp/README.md");
});

test("a README anywhere else in the tree is never taken", async () => {
  const result = await parseStaticRepository(
    readmeFixture({
      "docs/README.md": "# Docs",
      "mcp/node_modules/dep/README.md": "# A dependency",
      "packages/other/README.md": "# Another package",
    }),
  );
  assert.equal(result.readme, undefined);
});

test("in one directory a Markdown README wins, README.md before its variants", async () => {
  const result = await parseStaticRepository(
    readmeFixture({
      README: "plain text",
      "README.rst": "Weather\n=======",
      "README.zh-CN.md": "# 天气",
      "readme.md": "# weather",
      "README.md": "# Weather",
    }),
  );
  assert.equal(result.readme?.path, "README.md");

  const withoutMarkdown = await parseStaticRepository(
    readmeFixture({ "README.rst": "Weather\n=======", README: "plain text" }),
  );
  // Not Markdown, but still read for its evidence.
  assert.equal(withoutMarkdown.readme?.path, "README");
});
