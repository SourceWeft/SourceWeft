import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../shared/logger", () => ({
  logger: { warn: logs.warn, info: logs.info, debug: vi.fn(), error: vi.fn() },
}));
// The real module reaches for the provider registry, the config and the
// queue; here they are a fake factory (set per test), a minimal config and
// in-memory ledger stubs.
const fake = vi.hoisted(() => ({
  factory: null as null | {
    id: string;
    createProvider: () => unknown;
    getConfigurationStatus: () => { configured: boolean; missing: string[] };
  },
}));
vi.mock(
  "../../modules/threads/agent/sandbox-service/provider-registry",
  () => ({
    initializeSandboxProviderRegistry: async () => new Map(),
    getSandboxProviderFactory: () => fake.factory,
  }),
);
vi.mock("../../shared/config", () => ({
  config: {
    sandbox: { enabled: true, provider: "fake", maxCommandTimeoutMs: 600_000 },
  },
}));
vi.mock("../../modules/market/validation/stdio-driver-source", () => ({
  MCP_STDIO_DRIVER_FILE: "stdio-driver.mjs",
  stdioDriverSource: () => "// driver",
}));
vi.mock("../../modules/market/validation/stdio-queue", () => ({
  recordMcpStdioSandbox: vi.fn(async () => undefined),
  forgetMcpStdioSandbox: vi.fn(async () => undefined),
  listMcpStdioSandboxes: vi.fn(async () => []),
}));

import {
  MCP_STDIO_ORPHAN_AGE_MS,
  runMcpStdioValidationInSandbox,
  sweepOrphanedMcpStdioSandboxes,
} from "./mcp-stdio-sandbox";
import {
  forgetMcpStdioSandbox,
  recordMcpStdioSandbox,
} from "../../modules/market/validation/stdio-queue";
import type { McpStdioLaunchPlan } from "../../modules/market/validation/stdio-package";

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

const PLAN: McpStdioLaunchPlan = {
  package: { registryType: "npm", identifier: "acme", version: "1.0.0" },
  install: "true",
  start: "true",
  env: {},
  installTimeoutMs: 90_000,
  runTimeoutMs: 60_000,
  cpuSeconds: 120,
};

/** A provider whose driver run writes `resultFile`; records every call. */
function fakeProvider(resultFile: Buffer | Error) {
  const calls: string[] = [];
  const provider = {
    id: "fake",
    pathPolicy: { workspaceRoot: "/workspace" },
    createSandbox: async () => {
      calls.push("create");
      return { id: "sb-1" };
    },
    ensureDirectory: async () => {
      calls.push("mkdir");
    },
    uploadFile: async (input: { sandboxPath: string }) => {
      calls.push(`upload ${input.sandboxPath}`);
    },
    executeSystem: async (input: { command: string; timeoutMs: number }) => {
      calls.push(`exec ${input.command} ${input.timeoutMs}`);
      return { output: "ok", exitCode: 0, truncated: false };
    },
    downloadFile: async () => {
      calls.push("download");
      if (resultFile instanceof Error) throw resultFile;
      return resultFile;
    },
    deleteSandbox: async () => {
      calls.push("delete");
    },
  };
  fake.factory = {
    id: "fake",
    createProvider: () => provider,
    getConfigurationStatus: () => ({ configured: true, missing: [] }),
  };
  return calls;
}

test("a result larger than the cap is a protocol failure, not a retry; the sandbox is still deleted", async () => {
  const calls = fakeProvider(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
  const result = await runMcpStdioValidationInSandbox(PLAN, {
    identifier: "io.github.acme/server",
    version: "1.0.0",
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "protocol",
    detail: "the server's answer was larger than 4 MB",
    timings: { installMs: 0, startMs: 0 },
    stderrTail: "",
  });
  assert.deepEqual(calls, [
    "create",
    "mkdir",
    "upload /workspace/mcp-validate/stdio-driver.mjs",
    "upload /workspace/mcp-validate/plan.json",
    "exec node stdio-driver.mjs plan.json result.json 170000",
    "download",
    "delete",
  ]);
  assert.equal(vi.mocked(recordMcpStdioSandbox).mock.calls.length, 1);
  assert.equal(vi.mocked(forgetMcpStdioSandbox).mock.calls.length, 1);
});

test("a result the driver wrote is parsed; a missing one is null, and both delete the sandbox", async () => {
  const written = {
    ok: true,
    tools: [{ name: "t" }],
    timings: { installMs: 1, startMs: 2 },
    stderrTail: "",
  };
  fakeProvider(Buffer.from(JSON.stringify(written)));
  const parsed = await runMcpStdioValidationInSandbox(PLAN, {
    identifier: "io.github.acme/server",
    version: "1.0.0",
  });
  assert.equal(parsed?.ok, true);

  const calls = fakeProvider(new Error("file not found: result.json"));
  const missing = await runMcpStdioValidationInSandbox(PLAN, {
    identifier: "io.github.acme/server",
    version: "1.0.0",
  });
  assert.equal(missing, null);
  assert.equal(calls.at(-1), "delete");
});
