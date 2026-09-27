import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  RepoTree,
  VIRTUAL_REPO_ROOT,
  type ReadGitHubRepository,
} from "./parser/repo-tree";

const mocks = vi.hoisted(() => ({ read: vi.fn(), withSystemModel: vi.fn() }));

vi.mock("./parser/repo-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./parser/repo-tree")>()),
  readGitHubRepository: mocks.read,
}));
// A submission asks no model: anything reaching the system model is recorded.
vi.mock("../../shared/model-gateway/system-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/model-gateway/system-client")
  >()),
  withSystemModel: mocks.withSystemModel,
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
          description: "Weather forecasts and alerts for any city.",
          packages: [
            {
              registryType: "npm",
              identifier: "@acme/weather-mcp",
              transport: { type: "stdio" },
              environmentVariables: [
                {
                  name: "WEATHER_API_KEY",
                  description: "Key for the weather API.",
                  isSecret: true,
                  isRequired: true,
                  value: "sk-live-should-not-be-kept",
                  default: "also-not-kept",
                },
              ],
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

  // Filed by the keyword rules; no model was asked.
  assert.equal(result.report.classification?.method, "rules");
  assert.ok(result.manifest.categories.length > 0);
  assert.equal(mocks.withSystemModel.mock.calls.length, 0);

  // The server.json's settings are kept by name and flags, never by value.
  assert.deepEqual(result.registryServer, {
    packages: [
      {
        registryType: "npm",
        identifier: "@acme/weather-mcp",
        transport: { type: "stdio" },
        environmentVariables: [
          {
            name: "WEATHER_API_KEY",
            description: "Key for the weather API.",
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
  });
  assert.equal(JSON.stringify(result.registryServer).includes("kept"), false);
});
