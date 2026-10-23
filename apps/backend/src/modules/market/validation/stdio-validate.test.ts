import assert from "node:assert/strict";
import { beforeEach, describe, test, vi, type Mock } from "vitest";

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../../shared/logger", () => ({
  logger: { warn: logs.warn, info: logs.info, debug: vi.fn(), error: vi.fn() },
}));

import {
  MCP_STDIO_BATCH_SIZE,
  MCP_STDIO_CONCURRENCY,
  MCP_STDIO_SCHEDULED_JOB_ID,
} from "./stdio-queue";
import type { ClaimedMcpStdioValidation } from "./stdio-repository";
import type { McpStdioDriverResult } from "./stdio-state";
import {
  scheduleDueMcpStdioValidations,
  validateMcpStdioBatch,
  type ValidateMcpStdioBatchDeps,
} from "./stdio-validate";

const NOW = new Date("2026-10-24T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduling", () => {
  test("queues one batch of the due versions, never-tried first as found", async () => {
    const findDue = vi.fn(async (_input: { limit: number }) => [
      { versionId: "v-new", identifier: "a", neverTried: true },
      { versionId: "v-old", identifier: "b", neverTried: false },
    ]);
    const enqueue = vi.fn(async () => undefined);
    const result = await scheduleDueMcpStdioValidations({
      sandboxEnabled: () => true,
      jobExists: async () => false,
      findDue,
      enqueue,
    });
    assert.deepEqual(result, {
      queued: 2,
      inFlight: false,
      sandboxEnabled: true,
    });
    assert.deepEqual(findDue.mock.calls[0]?.[0], {
      limit: MCP_STDIO_BATCH_SIZE,
    });
    assert.deepEqual(enqueue.mock.calls[0], [
      { versionIds: ["v-new", "v-old"], reason: "scheduled" },
      MCP_STDIO_SCHEDULED_JOB_ID,
    ]);
  });

  test("the batch is small and the interval long enough that the first pass takes days, not hours", () => {
    // Six two-at-a-time is three rounds of one to two minutes each: the
    // batch ends well inside its 15-minute interval, and ~1,500 packages
    // take about three days.
    assert.equal(MCP_STDIO_BATCH_SIZE, 6);
    assert.equal(MCP_STDIO_CONCURRENCY, 2);
    const perDay = (MCP_STDIO_BATCH_SIZE * 24 * 60) / 15;
    assert.ok(perDay < 700, `${perDay} a day is too fast a first pass`);
    assert.ok(1500 / perDay >= 2, "the first pass should spread over days");
  });

  test("queues nothing while a batch is in flight, and nothing with no versions due", async () => {
    const enqueue = vi.fn(async () => undefined);
    assert.deepEqual(
      await scheduleDueMcpStdioValidations({
        sandboxEnabled: () => true,
        jobExists: async () => true,
        findDue: async () => [
          { versionId: "v", identifier: "a", neverTried: true },
        ],
        enqueue,
      }),
      { queued: 0, inFlight: true, sandboxEnabled: true },
    );
    assert.deepEqual(
      await scheduleDueMcpStdioValidations({
        sandboxEnabled: () => true,
        jobExists: async () => false,
        findDue: async () => [],
        enqueue,
      }),
      { queued: 0, inFlight: false, sandboxEnabled: true },
    );
    assert.equal(enqueue.mock.calls.length, 0);
  });

  test("queues nothing without a sandbox runtime, without looking for due versions", async () => {
    const findDue = vi.fn(async () => []);
    assert.deepEqual(
      await scheduleDueMcpStdioValidations({
        sandboxEnabled: () => false,
        jobExists: async () => false,
        findDue,
        enqueue: async () => undefined,
      }),
      { queued: 0, inFlight: false, sandboxEnabled: false },
    );
    assert.equal(findDue.mock.calls.length, 0);
  });
});

function claimed(
  versionId: string,
  packages: unknown,
): ClaimedMcpStdioValidation {
  return {
    versionId,
    serverId: `s-${versionId}`,
    identifier: `io.github.acme/${versionId}`,
    version: "1.0.0",
    provenanceJson: {
      registryServer: packages === undefined ? {} : { packages },
    },
  };
}

const NPM = [
  { registryType: "npm", identifier: "acme-server", version: "1.0.0" },
];

function ok(tools: Array<{ name: string }>): McpStdioDriverResult {
  return {
    ok: true,
    serverInfo: { name: "acme", version: "1.0.0" },
    tools,
    timings: { installMs: 1000, startMs: 2000 },
    stderrTail: "",
  };
}

function deps(
  overrides: Partial<ValidateMcpStdioBatchDeps> = {},
): ValidateMcpStdioBatchDeps & {
  writeSuccess: Mock<ValidateMcpStdioBatchDeps["writeSuccess"]>;
  writeFailure: Mock<ValidateMcpStdioBatchDeps["writeFailure"]>;
  record: Mock<ValidateMcpStdioBatchDeps["record"]>;
} {
  return {
    sandboxReadiness: async () => ({ ready: true }),
    claim: async () => [],
    run: async () => ok([]),
    writeSuccess: vi.fn(async () => undefined),
    writeFailure: vi.fn(async () => undefined),
    record: vi.fn(async () => undefined),
    now: () => NOW,
    ...overrides,
  } as never;
}

describe("validating a batch", () => {
  test("claims the batch, starts each runnable package, stores tools and self-description", async () => {
    const claim = vi.fn(async (_input: { versionIds: string[]; now: Date }) => [
      claimed("v1", NPM),
      claimed("v2", NPM),
    ]);
    const run = vi.fn(async (plan: { package: { identifier: string } }) =>
      ok([{ name: `tool-of-${plan.package.identifier}` }]),
    );
    const d = deps({ claim, run });
    const summary = await validateMcpStdioBatch(
      { versionIds: ["v1", "v2", "v3"], reason: "scheduled" },
      d,
    );
    assert.deepEqual(claim.mock.calls[0]?.[0], {
      versionIds: ["v1", "v2", "v3"],
      now: NOW,
    });
    assert.equal(run.mock.calls.length, 2);
    assert.equal(d.writeSuccess.mock.calls.length, 2);
    const written = d.writeSuccess.mock.calls[0]?.[0] as {
      versionId: string;
      serverId: string;
      validatedAt: string;
      selfDescription: { source: string; serverInfo: { name: string } };
      tools: Array<{ name: string }>;
    };
    assert.equal(written.versionId, "v1");
    assert.equal(written.serverId, "s-v1");
    assert.equal(written.validatedAt, NOW.toISOString());
    assert.equal(written.selfDescription.source, "stdio-sandbox");
    assert.equal(written.selfDescription.serverInfo.name, "acme");
    assert.deepEqual(
      written.tools.map((t) => t.name),
      ["tool-of-acme-server"],
    );
    assert.equal(d.writeFailure.mock.calls.length, 0);
    assert.equal(summary.requested, 3);
    assert.equal(summary.claimed, 2);
    assert.equal(summary.processed, 2);
    assert.deepEqual(summary.outcomes, { validated: 2 });
    assert.equal(summary.errors, 0);
    assert.equal(d.record.mock.calls.length, 1);
  });

  test("a failed start is stored as its reason; an unsupported package needs no sandbox", async () => {
    const run = vi.fn(async (): Promise<McpStdioDriverResult> => ({
      ok: false,
      reason: "start",
      detail: "server exited with 1 before answering initialize: boom",
      exitCode: 1,
      timings: { installMs: 500, startMs: 100 },
      stderrTail: "boom",
    }));
    const d = deps({
      claim: async () => [
        claimed("v-fails", NPM),
        claimed("v-docker", [
          { registryType: "oci", identifier: "ghcr.io/x/y:1" },
        ]),
        claimed("v-none", undefined),
      ],
      run,
    });
    const summary = await validateMcpStdioBatch(
      { versionIds: ["v-fails", "v-docker", "v-none"], reason: "scheduled" },
      d,
    );
    assert.equal(run.mock.calls.length, 1);
    assert.equal(d.writeSuccess.mock.calls.length, 0);
    // Two run at once, so the writes land in no fixed order.
    const writes = d.writeFailure.mock.calls
      .map((call) => call[0] as { versionId: string })
      .sort((a, b) => a.versionId.localeCompare(b.versionId));
    assert.deepEqual(writes, [
      {
        versionId: "v-docker",
        validation: {
          status: "unsupported",
          reason: "unsupported-package",
          at: NOW.toISOString(),
          detail: "No runnable npm or PyPI package; registry types: oci",
        },
      },
      {
        versionId: "v-fails",
        validation: {
          status: "failed",
          reason: "start",
          at: NOW.toISOString(),
          detail: "server exited with 1 before answering initialize: boom",
        },
      },
      {
        versionId: "v-none",
        validation: {
          status: "unsupported",
          reason: "unsupported-package",
          at: NOW.toISOString(),
          detail: "No stdio package to run",
        },
      },
    ]);
    assert.deepEqual(summary.outcomes, { start: 1, "unsupported-package": 2 });
  });

  test("a sandbox that cannot be had, or a driver with no result, stores nothing and counts an error", async () => {
    const d = deps({
      claim: async () => [
        claimed("v-throws", NPM),
        claimed("v-null", NPM),
        claimed("v-ok", NPM),
      ],
      run: async (_plan, context) => {
        if (context.identifier.endsWith("v-throws"))
          throw new Error("SANDBOX_PROVIDER_UNAVAILABLE");
        if (context.identifier.endsWith("v-null")) return null;
        return ok([{ name: "t" }]);
      },
    });
    const summary = await validateMcpStdioBatch(
      { versionIds: ["v-throws", "v-null", "v-ok"], reason: "scheduled" },
      d,
    );
    assert.equal(d.writeSuccess.mock.calls.length, 1);
    assert.equal(d.writeFailure.mock.calls.length, 0);
    assert.equal(summary.errors, 2);
    assert.equal(summary.processed, 1);
    assert.deepEqual(summary.outcomes, { validated: 1 });
    assert.equal(logs.warn.mock.calls.length, 2);
  });

  test("a write that fails does not stop the batch", async () => {
    const d = deps({
      claim: async () => [claimed("v1", NPM), claimed("v2", NPM)],
      run: async () => ok([{ name: "t" }]),
      writeSuccess: vi.fn(async (input: { versionId: string }) => {
        if (input.versionId === "v1") throw new Error("connection reset");
      }),
    });
    const summary = await validateMcpStdioBatch(
      { versionIds: ["v1", "v2"], reason: "scheduled" },
      d,
    );
    assert.equal(summary.errors, 1);
    assert.deepEqual(summary.outcomes, { validated: 1 });
  });

  test("no more than the concurrency runs at once", async () => {
    let running = 0;
    let peak = 0;
    const d = deps({
      claim: async () =>
        ["a", "b", "c", "d", "e"].map((id) => claimed(id, NPM)),
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return ok([]);
      },
    });
    const summary = await validateMcpStdioBatch(
      { versionIds: ["a", "b", "c", "d", "e"], reason: "scheduled" },
      d,
    );
    assert.equal(peak, MCP_STDIO_CONCURRENCY);
    assert.equal(summary.processed, 5);
  });

  test("without a usable sandbox the batch claims nothing and says why", async () => {
    const claim = vi.fn(async () => [claimed("v1", NPM)]);
    const d = deps({
      sandboxReadiness: async () => ({
        ready: false,
        reason: "provider daytona is missing DAYTONA_API_KEY",
      }),
      claim,
    });
    const summary = await validateMcpStdioBatch(
      { versionIds: ["v1"], reason: "scheduled" },
      d,
    );
    assert.equal(claim.mock.calls.length, 0);
    assert.equal(summary.stoppedBy, "sandbox_unavailable");
    assert.equal(
      summary.sandboxUnavailableReason,
      "provider daytona is missing DAYTONA_API_KEY",
    );
    assert.equal(d.record.mock.calls.length, 1);
  });
});
