import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { recordMemberToolObservation } from "./member-tools";

vi.mock("../market/tool-revisions/member-observed", () => ({
  recordMemberObservedTools: vi.fn(),
}));
vi.mock("../../shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const tools = [
  {
    name: "t",
    description: "d",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
];
const catalogInstall = {
  source: "market",
  marketIdentifier: "io.example/server",
  endpointUrl: "https://mcp.example.com/mcp",
};

test("hands the catalog the tools and the endpoint, and returns before it finishes", async () => {
  let release: () => void = () => undefined;
  const record = vi.fn(
    (_input: Record<string, unknown>) =>
      new Promise<{ recorded: true; outcome: "created" }>((resolve) => {
        release = () => resolve({ recorded: true, outcome: "created" });
      }),
  );
  const returned = recordMemberToolObservation({
    install: catalogInstall,
    tools,
    complete: true,
    publishable: true,
    record: record as never,
  });
  assert.equal(returned, undefined);
  await vi.waitFor(() => assert.equal(record.mock.calls.length, 1));
  assert.deepEqual(record.mock.calls[0]![0], {
    marketIdentifier: "io.example/server",
    endpointUrl: "https://mcp.example.com/mcp",
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    complete: true,
  });
  release();
});

test("an install that is not from the catalog is never offered", async () => {
  const record = vi.fn();
  for (const source of ["custom", "local_import"]) {
    recordMemberToolObservation({
      install: { ...catalogInstall, source },
      tools,
      complete: true,
      publishable: true,
      record,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(record.mock.calls.length, 0);
});

test("a connection that is not publishable is never offered", async () => {
  const record = vi.fn();
  recordMemberToolObservation({
    install: catalogInstall,
    publishable: false,
    tools,
    complete: true,
    record,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(record.mock.calls.length, 0);
});

test("a failure is logged without its message, which may carry query parameters", async () => {
  const { logger } = await import("../../shared/logger");
  vi.mocked(logger.warn).mockClear();
  recordMemberToolObservation({
    install: catalogInstall,
    publishable: true,
    tools,
    complete: true,
    record: vi.fn().mockRejectedValue(
      Object.assign(new Error('insert into "x" params: secret-tool-name'), { code: "57014" }),
    ),
  });
  await vi.waitFor(() => assert.equal(vi.mocked(logger.warn).mock.calls.length, 1));
  const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls[0]);
  assert.ok(!logged.includes("secret-tool-name"));
  assert.ok(logged.includes("57014"));
});

test("a rejected or throwing recorder is swallowed", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    recordMemberToolObservation({
      install: catalogInstall,
      tools,
      complete: true,
      publishable: true,
      record: vi.fn().mockRejectedValue(new Error("down")),
    });
    recordMemberToolObservation({
      install: catalogInstall,
      tools,
      complete: true,
      publishable: true,
      record: vi.fn(() => {
        throw new Error("sync");
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.mock.calls.length, 0);
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});
