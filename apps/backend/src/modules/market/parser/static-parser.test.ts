import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { parseStaticRepository } from "./static-parser";
import type { PreparedGitHubRepository } from "../types";

async function createRepositoryFixture(input: {
  files: Record<string, string>;
  owner?: string;
  repo: string;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "sourceweft-mcp-fixture-"));
  for (const [relativePath, content] of Object.entries(input.files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return {
    owner: input.owner ?? "example",
    repo: input.repo,
    ref: "main",
    requestedRef: "main",
    resolvedRef: "main",
    rootDir: root,
    workDir: root,
    tempRoot: root,
    subpath: "",
    repoUrl: `https://github.com/${input.owner ?? "example"}/${input.repo}`,
    sourceUrl: `https://github.com/${input.owner ?? "example"}/${input.repo}`,
  } satisfies PreparedGitHubRepository;
}

test("rejects repositories without MCP evidence", async () => {
  const source = await createRepositoryFixture({
    repo: "jsondiffpatch",
    owner: "benjamine",
    files: {
      "README.md": "# jsondiffpatch\n\nDiff and patch JavaScript objects.",
      "package.json": JSON.stringify({
        name: "jsondiffpatch",
        version: "1.0.0",
      }),
      "src/index.ts": "export function diff(left: unknown, right: unknown) { return [left, right]; }\n",
    },
  });

  const result = await parseStaticRepository(source);

  assert.equal(result.mcpAssessment.isMcp, false);
  assert.equal(result.mcpAssessment.confidence, 0);
  assert.match(result.warnings.join("\n"), /non-MCP/);
});

test("accepts repositories with MCP runtime and tool registration evidence", async () => {
  const source = await createRepositoryFixture({
    repo: "playwright-mcp",
    files: {
      "README.md": "# Playwright MCP\n\nA Model Context Protocol server for browser automation.",
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
  const source = await createRepositoryFixture({
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
