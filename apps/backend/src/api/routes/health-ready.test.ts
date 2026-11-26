import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createRouteTestApp, readJson } from "../../test/hono";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  findMcp: vi.fn(),
  listMcp: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@sourceweft/db", () => ({ db: { execute: mocks.execute } }));
vi.mock("../../modules/market/read-repository", () => ({
  findMcp: mocks.findMcp,
  listMcp: mocks.listMcp,
}));
vi.mock("../../shared/logger", () => ({ logger: { warn: mocks.warn } }));

import {
  READINESS_CATALOG_BUDGET_MS,
  READINESS_DATABASE_BUDGET_MS,
  registerHealthReadyRoute,
} from "./health-ready";

const app = createRouteTestApp((hono) => registerHealthReadyRoute(hono));
const ready = () => app.request("http://localhost/v1/health/ready");

beforeEach(() => {
  mocks.execute.mockReset().mockResolvedValue({ rows: [{ "?column?": 1 }] });
  mocks.listMcp
    .mockReset()
    .mockResolvedValue({ items: [{ identifier: "io.github.o/weather" }] });
  mocks.findMcp.mockReset().mockResolvedValue({ item: {} });
  mocks.warn.mockReset();
});

test("200 with each check's duration when the database and the catalog read answer", async () => {
  const response = await ready();
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.status, "ok");
  assert.deepEqual(body.failed, []);
  const checks = body.checks as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(checks), ["database", "catalog"]);
  assert.equal(checks.database!.status, "ok");
  assert.equal(checks.database!.budgetMs, READINESS_DATABASE_BUDGET_MS);
  assert.equal(typeof checks.database!.durationMs, "number");
  assert.equal(checks.catalog!.budgetMs, READINESS_CATALOG_BUDGET_MS);
  assert.equal(mocks.execute.mock.calls.length, 1);
});

test("reads one server the way the public detail route does", async () => {
  await ready();

  assert.deepEqual(mocks.listMcp.mock.calls[0], [
    { includeDesktopOnly: true, limit: 1 },
  ]);
  assert.deepEqual(mocks.findMcp.mock.calls[0], [
    "io.github.o/weather",
    {
      locale: "en",
      relatedProduct: true,
      toolsRevision: true,
      referenceTools: true,
    },
  ]);
});

test("503 naming the database when its ping fails, without the error's text", async () => {
  mocks.execute.mockRejectedValue(
    new Error("getaddrinfo ENOTFOUND postgres.internal"),
  );

  const response = await ready();
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;

  assert.equal(response.status, 503);
  assert.equal(body.status, "unavailable");
  assert.deepEqual(body.failed, ["database"]);
  const checks = body.checks as Record<string, Record<string, unknown>>;
  assert.equal(checks.database!.reason, "error");
  assert.equal(typeof checks.database!.durationMs, "number");
  assert.equal(checks.catalog!.status, "ok");
  assert.ok(!text.includes("postgres.internal"));
  // The server's own log gets the cause.
  assert.equal(mocks.warn.mock.calls[0]![0], "Readiness check failed");
  assert.match(
    String((mocks.warn.mock.calls[0]![1] as { error: string }).error),
    /postgres\.internal/,
  );
});

test("503 naming the catalog when the detail read fails or finds nothing for a listed server", async () => {
  mocks.findMcp.mockRejectedValue(new Error("statement timeout"));
  let response = await ready();
  assert.equal(response.status, 503);
  assert.deepEqual((await readJson(response)).failed, ["catalog"]);

  mocks.findMcp.mockResolvedValue(null);
  response = await ready();
  assert.equal(response.status, 503);
  assert.deepEqual((await readJson(response)).failed, ["catalog"]);
});

test("503 naming a check that exceeds its budget", async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    mocks.execute.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = ready();
    await vi.advanceTimersByTimeAsync(READINESS_DATABASE_BUDGET_MS);
    const response = await pending;
    const body = await readJson(response);

    assert.equal(response.status, 503);
    assert.deepEqual(body.failed, ["database"]);
    const checks = body.checks as Record<string, Record<string, unknown>>;
    assert.equal(checks.database!.reason, "timeout");
    assert.ok(
      (checks.database!.durationMs as number) >= READINESS_DATABASE_BUDGET_MS,
    );
    // Let the ping settle: while it is out, the probe starts no other.
    release();
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
  }
});

test("an empty catalog is ready: the list read itself answered", async () => {
  mocks.listMcp.mockResolvedValue({ items: [] });

  const response = await ready();

  assert.equal(response.status, 200);
  assert.equal(mocks.findMcp.mock.calls.length, 0);
});
