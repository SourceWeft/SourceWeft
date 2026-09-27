import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  RepoTree,
  VIRTUAL_REPO_ROOT,
  type ReadGitHubRepository,
} from "./parser/repo-tree";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("./parser/repo-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./parser/repo-tree")>()),
  readGitHubRepository: mocks.read,
}));
vi.mock("./parser/classifier", () => ({
  classifyMcpRepository: async () => ({
    categories: [],
    inputHash: "test",
    method: "rules-fallback",
    reviewRequired: false,
    ruleCandidates: [],
    taxonomyVersion: "test",
  }),
}));

import { parseMcpRepository } from "./parse-repository";

const COMMIT = "a".repeat(40);

function repository(
  files: Record<string, string | Buffer>,
  subpath: string,
): ReadGitHubRepository {
  return {
    commitSha: COMMIT,
    owner: "acme",
    repo: "tools",
    ref: "main",
    repoUrl: "https://github.com/acme/tools",
    requestedRef: "main",
    resolvedRef: COMMIT,
    rootDir: VIRTUAL_REPO_ROOT,
    sourceUrl: `https://github.com/acme/tools/tree/main/${subpath}`,
    subpath,
    tree: new RepoTree(
      new Map(
        Object.entries(files).map(([path, content]) => [
          path,
          Buffer.isBuffer(content) ? content : Buffer.from(content),
        ]),
      ),
    ),
    workDir: `${VIRTUAL_REPO_ROOT}/${subpath}`,
  };
}

test("the parse hands back the README's bytes at its repository path", async () => {
  // Bytes that do not survive a UTF-8 round trip: the stored hash must be of
  // the file, not of its decoded text.
  const readme = Buffer.concat([
    Buffer.from("# Weather MCP\n\nA Model Context Protocol server.\n"),
    Buffer.from([0xef, 0xbb, 0xbf]),
  ]);
  mocks.read.mockResolvedValue(
    repository(
      {
        "README.md": "# Tools monorepo",
        "servers/weather/README.md": readme,
        "servers/weather/server.json": JSON.stringify({
          name: "io.github.acme/weather",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@acme/weather-mcp",
              transport: { type: "stdio" },
            },
          ],
        }),
        "servers/weather/package.json": JSON.stringify({
          name: "@acme/weather-mcp",
          dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" },
        }),
      },
      "servers/weather",
    ),
  );

  const result = await parseMcpRepository(
    "https://github.com/acme/tools/tree/main/servers/weather",
    { mode: "static" },
  );

  assert.equal(result.readme?.path, "servers/weather/README.md");
  assert.deepEqual(Buffer.from(result.readme!.bytes), readme);
  assert.equal(result.report.static.readmePath, "README.md");
  assert.equal(result.report.github.commitSha, COMMIT);
});
