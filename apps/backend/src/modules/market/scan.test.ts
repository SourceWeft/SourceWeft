import assert from "node:assert/strict";
import { test } from "vitest";
import type { MarketMcpManifest } from "@sourceweft/market-contracts";
import { scanMcpSubmission } from "./scan";
import type { McpParserReport } from "./types";

function report(overrides: Partial<McpParserReport> = {}): McpParserReport {
  return {
    connections: [],
    evidence: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
    github: {
      owner: "acme",
      ref: "main",
      repo: "mcp",
      repoUrl: "https://github.com/acme/mcp",
      sourceUrl: "https://github.com/acme/mcp",
      subpath: "",
    },
    installCommands: [],
    mode: "static",
    packageHints: [],
    runtime: { toolsCount: 0, warnings: [] },
    schemaVersion: 1,
    static: { sourceToolCount: 0, warnings: [] },
    ...overrides,
  };
}

const manifest = {
  identifier: "io.github.acme/mcp",
  version: "1.0.0",
  endpointUrl: "https://mcp.acme.io",
} as unknown as MarketMcpManifest;

test("clean submission needs no review", () => {
  const scan = scanMcpSubmission({ manifest, report: report() });
  assert.equal(scan.reviewRequired, false);
  assert.deepEqual(scan.flags, []);
});

test("pipe-to-shell install command is flagged", () => {
  const scan = scanMcpSubmission({
    manifest,
    report: report({ installCommands: ["curl https://get.acme.sh | sh"] }),
  });
  assert.equal(scan.reviewRequired, true);
  assert.ok(scan.flags.includes("command:pipe-to-shell"));
});

test("sudo in a connection command is flagged", () => {
  const scan = scanMcpSubmission({
    manifest,
    report: report({
      connections: [
        {
          confidence: 1,
          transport: "stdio",
          command: "sudo",
          args: ["npm", "i", "-g", "x"],
          source: "readme",
        },
      ],
    }),
  });
  assert.ok(scan.flags.includes("command:sudo"));
});

test("an endpoint pointing at a metadata address is flagged", () => {
  const scan = scanMcpSubmission({
    manifest: {
      ...manifest,
      endpointUrl: "https://169.254.169.254/latest/meta-data",
    } as unknown as MarketMcpManifest,
    report: report(),
  });
  assert.ok(scan.flags.includes("endpoint:internal-address"));
});
