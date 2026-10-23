import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../shared/logger", () => ({
  logger: { warn: logs.warn, info: logs.info, debug: vi.fn(), error: vi.fn() },
}));
// The real module reaches for the provider registry and the queue; the sweep
// under test takes its ledger and provider as dependencies.
vi.mock(
  "../../modules/threads/agent/sandbox-service/provider-registry",
  () => ({
    initializeSandboxProviderRegistry: async () => new Map(),
    getSandboxProviderFactory: () => null,
  }),
);
vi.mock("../../modules/market/validation/stdio-queue", () => ({
  recordMcpStdioSandbox: vi.fn(),
  forgetMcpStdioSandbox: vi.fn(),
  listMcpStdioSandboxes: vi.fn(),
}));

import {
  MCP_STDIO_ORPHAN_AGE_MS,
  sweepOrphanedMcpStdioSandboxes,
} from "./mcp-stdio-sandbox";

const NOW = new Date("2026-10-24T12:00:00Z");
const at = (ageMs: number) => new Date(NOW.getTime() - ageMs).toISOString();

beforeEach(() => vi.clearAllMocks());

test("old entries are deleted and forgotten; young ones are left for their worker", async () => {
  const deleted: string[] = [];
  const forgotten: string[] = [];
  const result = await sweepOrphanedMcpStdioSandboxes({
    list: async () => [
      {
        provider: "cloudflare",
        providerSandboxId: "old",
        createdAt: at(MCP_STDIO_ORPHAN_AGE_MS + 1),
      },
      {
        provider: "cloudflare",
        providerSandboxId: "young",
        createdAt: at(60_000),
      },
      {
        provider: "cloudflare",
        providerSandboxId: "unknown-age",
        createdAt: new Date(0).toISOString(),
      },
    ],
    forget: async (id) => {
      forgotten.push(id);
    },
    deleteSandbox: async (entry) => {
      deleted.push(entry.providerSandboxId);
    },
    now: () => NOW,
  });
  assert.deepEqual(result, { swept: 2, failed: 0 });
  assert.deepEqual(deleted, ["old", "unknown-age"]);
  assert.deepEqual(forgotten, ["old", "unknown-age"]);
  assert.equal(logs.warn.mock.calls.length, 2);
});

test("a delete the provider refuses keeps the entry for the next sweep", async () => {
  const forgotten: string[] = [];
  const result = await sweepOrphanedMcpStdioSandboxes({
    list: async () => [
      {
        provider: "cloudflare",
        providerSandboxId: "stuck",
        createdAt: at(MCP_STDIO_ORPHAN_AGE_MS + 1),
      },
    ],
    forget: async (id) => {
      forgotten.push(id);
    },
    deleteSandbox: async () => {
      throw new Error("bridge unavailable");
    },
    now: () => NOW,
  });
  assert.deepEqual(result, { swept: 0, failed: 1 });
  assert.deepEqual(forgotten, []);
});
